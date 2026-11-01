/**
 * E2E-30 Switch away -> backlog exceeds ring_bytes -> switch back (AC-2.6 / AC-2.15).
 *
 * E2E-2c / E2E-4 go through reconnect (welcome.resumed[].status); this one goes through switch-back
 * (subscribe), a different code path. Runs with `--ring-bytes 65536`.
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

import {
  Agent,
  count,
  framesSince,
  hooks,
  newSession,
  recordSent,
  submit,
  switchTo,
  terminalText,
  waitFor,
  waitSnapshot,
  waitText,
  type SentRecorder,
} from './harness'

const PAD = 'x'.repeat(60)

/**
 * floodCmd emits `lines` lines (~70 B each) in the background, ends with a terminal query (CPR), and
 * signals completion with a file.
 *
 * It sleeps 3s first, which is time to switch to another session, so all output lands while
 * unsubscribed. The query sits at the tail of the catch-up or snapshot: if the client does not mark
 * it as replay, xterm answers it and the answer is sent to the PTY as user input (AC-2.15).
 */
function floodCmd(tag: string, lines: number, done: string): string {
  return `(sleep 3; for i in $(seq 1 ${lines}); do printf '${tag} %04d %s\\n' $i ${PAD}; done; printf '\\033[6n'; touch ${done}) &`
}

const cprSent = async (rec: SentRecorder) => (await rec.input()).some((s) => /\x1b\[\d+;\d+R/.test(s))

/** assertSubscribeCarriesSize checks what the client sent on switch-back: subscribe carries the size, and no resize precedes it. */
async function assertSubscribeCarriesSize(rec: SentRecorder, sid: number) {
  const ctl = await rec.ctl()
  const iSub = ctl.findIndex((m) => m.t === 'subscribe' && m.sid === sid)
  expect(iSub, `switch-back should send subscribe: ${ctl.map((m) => m.t).join(' -> ')}`).toBeGreaterThanOrEqual(0)
  const sub = ctl[iSub] as { cols?: number; rows?: number }
  expect(sub.cols, 'subscribe carries cols').toBeGreaterThan(0)
  expect(sub.rows, 'subscribe carries rows').toBeGreaterThan(0)
  const iResize = ctl.findIndex((m) => m.t === 'resize')
  expect(iResize >= 0 && iResize < iSub, `resize must not precede subscribe: ${ctl.map((m) => m.t).join(' -> ')}`).toBe(false)
}

async function setup(page: Page, agent: Agent) {
  await agent.open(page)
  const a = (await hooks.sid(page))!
  await submit(page, "printf 'MARK-%s\\n' ONE")
  await waitText(page, /^MARK-ONE$/m, 'A shows its marker')
  return a
}

test.describe('E2E-30 switch away -> backlog -> switch back (64 KiB ring)', () => {
  let agent: Agent
  test.beforeEach(async () => {
    agent = await Agent.start({ ringBytes: 65536 })
  })
  test.afterEach(() => agent.stop())

  test('(1) backlog exceeds ring_bytes -> snapshot: screen is cleared and rebuilt, not appended to the old one, no echo', async ({ page }) => {
    test.setTimeout(150_000)
    const rec = await recordSent(page)
    const a = await setup(page, agent)
    const dir = mkdtempSync(join(tmpdir(), 'webterm-e2e30-'))

    // 2500 lines × 70 B ≈ 175 KiB, far more than 64 KiB.
    const done1 = join(dir, 'round1')
    await submit(page, floodCmd('pad', 2500, done1))
    const b = await newSession(page)
    await waitFor(() => existsSync(done1), 'A overran the buffer several times in the background', 60_000)

    await rec.clear()
    const read = await framesSince(page)
    await switchTo(page, a)
    await assertSubscribeCarriesSize(rec, a)

    // A SNAPSHOT arrives, not OUTPUT continuing from the old position.
    await waitSnapshot(read, a, 'switch-back uses a snapshot')
    const first = (await read()).find((f) => f.sid === a)!
    expect(first.kind, "A's first frame after switch-back should be SNAPSHOT").toBe('SNAPSHOT')
    await waitText(page, 'pad 2500')
    await page.waitForTimeout(500)

    // The screen was cleared: MARK-ONE is well beyond the snapshot's 2000 lines, so if it is still
    // there the snapshot was appended after the old screen.
    const after = await terminalText(page)
    expect(count(after, 'MARK-ONE'), 'old screen was not cleared; the snapshot was appended after old content').toBe(0)
    expect(count(after, 'pad 2500 '), 'same content appears once').toBe(1)
    // The CPR query in the snapshot is history: xterm's answer must not reach the PTY as input.
    expect(await cprSent(rec), 'a replayed terminal query was answered and sent to the PTY').toBe(false)

    // Round two: switch away, overrun again, switch back. Each round rebuilds rather than appends.
    const lines1 = after.split('\n').length
    const done2 = join(dir, 'round2')
    await submit(page, floodCmd('pad', 2500, done2))
    await switchTo(page, b)
    await waitFor(() => existsSync(done2), 'second round overran the buffer too', 60_000)
    const read2 = await framesSince(page)
    await switchTo(page, a)
    await waitSnapshot(read2, a, 'second switch-back also uses a snapshot')
    await page.waitForTimeout(500)
    const lines2 = (await terminalText(page)).split('\n').length
    const { rows } = await hooks.size(page)
    expect(Math.abs(lines2 - lines1), `line count went from ${lines1} to ${lines2} over two rounds, more than a screen apart`).toBeLessThan(rows)
  })

  test('(2) backlog within ring_bytes -> incremental catch-up: no clear, gap filled, no echo', async ({ page }) => {
    const rec = await recordSent(page)
    const a = await setup(page, agent)
    const dir = mkdtempSync(join(tmpdir(), 'webterm-e2e30b-'))

    // 200 lines ≈ 14 KiB, well under 64 KiB, so the incremental path is used. Nothing on the wire
    // marks this data as history; whether it counts as replay depends entirely on the client
    // tracking catchup_to (protocol §5.3).
    const done = join(dir, 'small')
    await submit(page, floodCmd('few', 200, done))
    await newSession(page)
    await waitFor(() => existsSync(done), 'A produced a short burst in the background', 60_000)

    await rec.clear()
    const read = await framesSince(page)
    await switchTo(page, a)
    await assertSubscribeCarriesSize(rec, a)
    await waitText(page, 'few 0200', 'output from while away has been filled in')
    await page.waitForTimeout(500)

    const fs = (await read()).filter((f) => f.sid === a)
    expect(fs.length).toBeGreaterThan(0)
    expect(fs.every((f) => f.kind === 'OUTPUT'), 'incremental catch-up: only OUTPUT, no SNAPSHOT').toBe(true)
    expect(count(await terminalText(page), 'MARK-ONE'), 'incremental catch-up must not clear the screen').toBeGreaterThan(0)
    expect(await cprSent(rec), 'switch-back catch-up replayed a query and sent its answer to the PTY').toBe(false)
  })
})
