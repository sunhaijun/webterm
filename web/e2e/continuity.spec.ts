/**
 * E2E-2 Resume after disconnect, the core guarantee (AC-2.1 / AC-2.2 / AC-2.3 / AC-2.5 / AC-2.21)
 * E2E-3 Input typed while disconnected is not lost (AC-2.4 / AC-2.12)
 * E2E-4 UI behavior on the snapshot path (AC-2.6)
 *
 * These tests do not check that reconnecting works (too weak); they check that the final screen is
 * identical to a run that never disconnected. Any seq bookkeeping error, slice offset, duplicate
 * replay or dropped frame makes the two differ. This is the mechanical evidence behind "never lose
 * the session".
 *
 * Each round runs in a new session and starts with `printf '\033c'` (RIS) to clear the echoed
 * command line. Baseline and test runs use different per-line delays (different command lines);
 * after the clear only emit.sh output remains.
 */
import { expect, test, type Page } from '@playwright/test'

import {
  Agent,
  EMIT,
  count,
  framesSince,
  hooks,
  installWSControl,
  lastWelcome,
  newSession,
  outSeq,
  serialize,
  submit,
  terminalText,
  waitFor,
  waitOnline,
  waitSnapshot,
  waitText,
  type WSControl,
} from './harness'

// No trace: every message relayed by routeWebSocket is recorded as a trace action, and thousands of
// output frames can clog Playwright's protocol channel for tens of seconds (one waitForTimeout(300)
// once took 44s).
test.use({ trace: 'off' })

/** waitQuiet waits until output has fully stopped (outSeq and buffer text unchanged), giving each round a fixed cutoff. */
async function waitQuiet(page: Page, quietMs = 700): Promise<void> {
  let last = ''
  let since = Date.now()
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const now = `${await outSeq(page)}:${(await terminalText(page)).length}`
    if (now !== last) {
      last = now
      since = Date.now()
    } else if (Date.now() - since >= quietMs) {
      return
    }
    await page.waitForTimeout(50)
  }
  throw new Error('timed out waiting for: output to go quiet')
}

/** untilDone truncates the serialization at the done marker; the prompt and cursor after it are not part of the output. */
function untilDone(s: string): string {
  const i = s.indexOf('EMIT-DONE')
  if (i < 0) throw new Error('serialization has no EMIT-DONE')
  return s.slice(0, i + 'EMIT-DONE'.length)
}

function assertSame(got: string, want: string, what: string): void {
  if (got === want) return
  let i = 0
  while (i < got.length && i < want.length && got[i] === want[i]) i++
  throw new Error(
    `${what}: diverges at byte ${i}\n` +
      `baseline length ${want.length}, actual length ${got.length}\n` +
      `baseline ...${JSON.stringify(want.slice(Math.max(0, i - 60), i + 60))}\n` +
      `actual   ...${JSON.stringify(got.slice(Math.max(0, i - 60), i + 60))}`,
  )
}

/** startEmit runs emit in a new session after clearing the screen and returns the session ID. */
async function startEmit(page: Page, args: string): Promise<number> {
  const sid = await newSession(page)
  await submit(page, `printf '\\033c'; ${EMIT} ${args}`)
  return sid
}

/** finish waits for the round to complete and returns the serialized buffer. */
async function finish(page: Page): Promise<string> {
  await waitText(page, 'EMIT-DONE', 'output finished', 90_000)
  await waitQuiet(page)
  return untilDone(await serialize(page))
}

/** cut drops the connection once: waits for the reconnecting banner, optionally holds, then restores and waits for online. */
async function cut(page: Page, net: WSControl, holdMs = 0): Promise<void> {
  await net.goOffline()
  await expect(page.getByTestId('conn-text')).toContainText('Reconnecting', { timeout: 10_000 })
  if (holdMs) await page.waitForTimeout(holdMs)
  net.goOnline()
  await waitOnline(page, 30_000)
}

test.describe('E2E-2 byte-level continuity (default 256 KiB ring, incremental path)', () => {
  let agent: Agent
  test.beforeEach(async () => {
    agent = await Agent.start()
  })
  test.afterEach(() => agent.stop())

  test('E2E-2a/2b/2d one disconnect / 5s disconnect / 10 rapid disconnects: screen is byte-identical to a run without disconnects', async ({ page }) => {
    test.setTimeout(240_000)
    const net = await installWSControl(page)
    await agent.open(page)

    // Baseline: no disconnect.
    await startEmit(page, '2000 0')
    const baseline = await finish(page)
    expect(baseline.length, 'baseline output too small to prove anything').toBeGreaterThan(100_000)

    // 2a: cut about halfway through the output.
    {
      await startEmit(page, '2000 2')
      await waitText(page, 'line 01000', 'output past halfway')
      await cut(page, net)
      // The restore toast reports how much was caught up (AC-2.10).
      await expect(page.getByTestId('toast')).toContainText('Resumed')
      expect((await lastWelcome(page))!.resumed.every((r) => r.status === 'ok'), 'no overflow, so incremental').toBe(true)
      assertSame(await finish(page), baseline, 'E2E-2a byte-level continuity broken after one disconnect')
    }

    // 2b: disconnect for 5s. At 5ms per line that is at most ~1100 lines ≈ 180 KiB, which fits the 256 KiB ring.
    {
      await startEmit(page, '2000 5')
      await waitText(page, 'line 00200', 'output started')
      await cut(page, net, 5000)
      expect((await lastWelcome(page))!.resumed.every((r) => r.status === 'ok'), '5s does not overflow, still incremental').toBe(true)
      assertSame(await finish(page), baseline, 'E2E-2b byte-level continuity broken after a 5s disconnect')
    }

    // 2d: 10 rapid disconnects, 300ms apart, to check that misalignment does not accumulate.
    {
      // 10ms per line ≈ 20s, so all 10 disconnects (~0.7s each including backoff) land during output.
      await startEmit(page, '2000 10')
      await waitText(page, 'line 00050', 'output started')
      for (let i = 0; i < 10; i++) {
        await net.goOffline()
        await page.waitForTimeout(300)
        net.goOnline()
        await waitOnline(page, 30_000)
      }
      expect(await terminalText(page), 'all 10 disconnects should land during output').not.toContain('EMIT-DONE')
      assertSame(await finish(page), baseline, 'E2E-2d byte-level continuity broken after 10 rapid disconnects')
    }
  })

  test('E2E-2e cut inside a colored span: incremental path resumes the bytes verbatim, colors match the baseline', async ({ page }) => {
    test.setTimeout(120_000)
    const net = await installWSControl(page)
    await agent.open(page)

    await startEmit(page, '1500 0 mono')
    const baseline = await finish(page)

    const sid = await startEmit(page, '1500 3 mono')
    await waitText(page, 'line 00500', 'colored span has started')
    await net.goOffline()
    await expect(page.getByTestId('conn-text')).toContainText('Reconnecting')
    const cutAt = await outSeq(page)
    const read = await framesSince(page)
    net.goOnline()
    await waitOnline(page)

    const w = (await lastWelcome(page))!
    expect(w.resumed.find((r) => r.sid === sid)?.status, 'the cut is within the ring window, so incremental is required').toBe('ok')

    // The agent does not rewrite the output stream (AC-2.5): the first resumed frame starts at the
    // cut (or earlier; the client dedups the overlap) with no snapshot in between. Read early:
    // frames() keeps only the last 512 frames, so after the run only the tail would be left.
    let fs: Awaited<ReturnType<typeof read>> = []
    await waitFor(async () => {
      fs = (await read()).filter((f) => f.sid === sid)
      return fs.length > 0
    }, 'first frame after reconnect')
    expect(fs.some((f) => f.kind === 'SNAPSHOT'), 'incremental path must not include a snapshot').toBe(false)
    expect(fs[0]!.seq, `first resumed frame should start at the cut ${cutAt}`).toBeLessThanOrEqual(cutAt)
    expect(fs[0]!.seq + fs[0]!.bytes, 'first frame covers the cut').toBeGreaterThan(cutAt)

    const after = await finish(page)
    assertSame(after, baseline, 'E2E-2e cut inside a colored span: resumed colors/bytes differ from the baseline')
  })
})

test.describe('E2E-2c / E2E-4 output during disconnect exceeds ring_bytes -> snapshot', () => {
  let agent: Agent
  test.beforeEach(async () => {
    agent = await Agent.start({ ringBytes: 65536 }) // small enough to exercise the snapshot path
  })
  test.afterEach(() => agent.stop())

  test('E2E-2c reconnect via snapshot: last 2000 lines + current screen match the baseline line by line, no truncation notice, later output correct', async ({ page }) => {
    test.setTimeout(180_000)
    const net = await installWSControl(page)
    await agent.open(page)

    // Baseline: same command, no disconnect. The leading `sleep 3` gives the test run time to cut
    // the line so all output lands while disconnected; the baseline uses the same command so the
    // echoed command line matches too.
    const cmd = `sleep 3; ${EMIT} 5000 0`
    await newSession(page)
    await submit(page, cmd)
    await waitText(page, 'EMIT-DONE', 'baseline finished', 90_000)
    await waitQuiet(page)
    const base = (await terminalText(page)).split('\n').map((l) => l.trimEnd())

    // Test run: same command in a new session, disconnect immediately.
    const sid = await newSession(page)
    await submit(page, `printf 'OLD-%s\\n' SCREEN; ${cmd}`)
    await waitText(page, 'OLD-SCREEN')
    // Scroll up first: after the snapshot the view should return to the bottom (E2E-4).
    await hooks.scrollLines(page, -5)
    await net.goOffline()
    await expect(page.getByTestId('conn-text')).toContainText('Reconnecting')
    // While disconnected: after 3s, 5000 lines ≈ 800 KiB, far more than 64 KiB.
    const read = await framesSince(page)
    await page.waitForTimeout(7000)
    net.goOnline()
    await waitOnline(page)

    const w = (await lastWelcome(page))!
    expect(w.resumed.find((r) => r.sid === sid)?.status, 'backlog over ring_bytes must use a snapshot').toBe('snapshot')
    const snap = await waitSnapshot(read, sid)
    expect(snap.length).toBeGreaterThan(0)
    await waitText(page, 'EMIT-DONE', 'finished', 60_000)
    await waitQuiet(page)

    // No "history truncated" notice: the snapshot is the complete picture.
    await expect(page.getByTestId('truncated')).toHaveCount(0)
    await expect(page.getByText(/truncated/i)).toHaveCount(0)

    // Screen-level consistency (AC-2.21): last 2000 lines of history + current screen, line by line.
    // Trailing whitespace is not a difference: spaces written by a program look the same as empty
    // cells, and a snapshot records trailing spaces as empty cells (translateToString trims empty
    // cells but not written spaces). The cell-by-cell unit test normalizes both the same way
    // (cellKey in web/tests/snapshot-xterm.test.ts).
    const got = (await terminalText(page)).split('\n').map((l) => l.trimEnd())
    const { rows } = await hooks.size(page)
    const n = 2000 + rows
    expect(got.length, `lines restored by the snapshot (history <= 2000 + current screen ${rows})`).toBeLessThanOrEqual(n)
    expect(got.length, 'snapshot should carry the full 2000 lines of history').toBeGreaterThanOrEqual(n - 1)
    const tail = (a: string[]) => a.slice(-Math.min(got.length, n))
    const g = tail(got)
    const b = tail(base)
    for (let i = 0; i < g.length; i++) {
      if (g[i] !== b[i]) throw new Error(`line ${i} after snapshot differs from the baseline\nbaseline ${JSON.stringify(b[i])}\nactual   ${JSON.stringify(g[i])}`)
    }

    // E2E-4: the screen is cleared before writing the snapshot, so pre-disconnect content is not
    // left in front of it.
    const text = got.join('\n')
    expect(count(text, 'OLD-SCREEN'), 'old screen should be cleared before the snapshot').toBe(0)
    expect(count(text, 'line 05000'), 'same content appears once').toBe(1)
    // E2E-4: the view returns to the bottom.
    expect((await hooks.viewport(page)).y, 'view should return to the bottom after the snapshot').toBeGreaterThanOrEqual(got.length - rows)

    // Output produced after reconnecting is correct.
    await submit(page, "printf 'marker-%s\\n' xyz")
    await waitFor(
      async () => (await terminalText(page)).split('\n').some((l) => l.trimEnd() === 'marker-xyz'),
      'output after the snapshot is still correct',
    )
  })
})

test.describe('E2E-3 input typed while disconnected is not lost', () => {
  let agent: Agent
  test.beforeEach(async () => {
    agent = await Agent.start()
  })
  test.afterEach(() => agent.stop())

  test('three commands typed while disconnected run in order after reconnect, no duplicates or losses, in_ack survives the reconnect', async ({ page }) => {
    const net = await installWSControl(page)
    await agent.open(page)
    const sid = (await hooks.sid(page))!

    // Type something before disconnecting: only with in_ack > 0 can we tell it was not reset (AC-2.12).
    await submit(page, "printf 'PRE-%s\\n' CUT")
    await waitText(page, 'PRE-CUT')
    await waitFor(async () => (await hooks.inputStats(page)).unackedBytes === 0, 'input before the disconnect was all acked')

    await net.goOffline()
    await expect(page.getByTestId('conn-text')).toContainText('Reconnecting', { timeout: 20_000 })

    // Type three commands straight into the terminal while disconnected. The output is `A1-OK`; the
    // echoed command contains only `A%s-OK`, so it cannot be mistaken for output.
    await submit(page, 'printf "A%s-OK\\n" 1')
    await submit(page, 'printf "A%s-OK\\n" 2')
    await submit(page, 'printf "A%s-OK\\n" 3')

    // They are pending: the banner is still up and the bytes are counted as unacked, not silently dropped.
    await expect(page.getByTestId('conn-banner')).toBeVisible()
    const pending = (await hooks.inputStats(page)).unackedBytes
    expect(pending, 'input typed offline should wait in the send queue').toBeGreaterThan(0)

    net.goOnline()
    await waitOnline(page, 40_000)

    const w = (await lastWelcome(page))!
    const r = w.resumed.find((x) => x.sid === sid)
    expect(r, 'reconnect should resume the current session').toBeTruthy()
    expect(r!.in_ack, 'in_ack must be the pre-disconnect total, not reset to zero (otherwise input_gap)').toBeGreaterThan(0)

    await waitFor(async () => (await terminalText(page)).includes('A3-OK'), 'all three ran', 30_000)
    // Search by substring, not whole lines: the three arrive as one batch after reconnect. While
    // bash runs the first, the kernel echoes the type-ahead of the other two, and after readline
    // redraws, fragments of that echo (`A1p`, `inA1`) remain on output lines, which would break a
    // whole-line comparison.
    const out = await terminalText(page)
    const at = (s: string) => out.indexOf(s)
    // In order.
    expect(at('A1-OK')).toBeGreaterThan(-1)
    expect(at('A1-OK')).toBeLessThan(at('A2-OK'))
    expect(at('A2-OK')).toBeLessThan(at('A3-OK'))
    // No duplicates: each marker appears once.
    for (const m of ['A1-OK', 'A2-OK', 'A3-OK']) {
      expect(count(out, m), `${m} printed more than once; input was written twice`).toBe(1)
    }
    await expect.poll(async () => (await hooks.inputStats(page)).unackedBytes, { message: 'all acked after resend' }).toBe(0)
  })

  test('variant: more than 64 KiB of input submitted while disconnected -> clear "offline input full" notice', async ({ page }) => {
    const net = await installWSControl(page)
    await agent.open(page)

    await net.goOffline()
    await expect(page.getByTestId('conn-text')).toContainText('Reconnecting', { timeout: 20_000 })

    // Paste 70 KB into the terminal (xterm's paste event -> one onData call).
    await page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('.term .xterm-helper-textarea')!
      ta.focus()
      const dt = new DataTransfer()
      dt.setData('text/plain', 'x'.repeat(70 * 1024))
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    })
    await expect(page.getByTestId('toast')).toContainText('Offline input buffer full')
  })
})
