/**
 * E2E-26 Hot upgrade keeps sessions (AC-2.14; ADR-0016 / ADR-0026 §8).
 *
 * The real binary gets SIGUSR2 -> preflight -> freeze -> handoff -> exec of the same file in place.
 * The browser should see one ordinary reconnect: instance_id unchanged (resumed.status == ok), no
 * lost or duplicated output, the running shell still there. Emulator state is handed off too: fresh
 * tabs opened before and after the upgrade take the snapshot path and see identical terminals, line
 * for line. The preflight-failure path is covered by the Go integration test IT-handoff-1.
 */
import { expect, test, type BrowserContext } from '@playwright/test'

import { Agent, hooks, lastWelcome, serialize, submit, terminalText, waitFor, waitOnline } from './harness'

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

/**
 * freshTabSerialize opens a new tab in the same context (shared cookie; out_seq == 0, so it takes
 * the snapshot path) and returns its serialized buffer.
 */
async function freshTabSerialize(ctx: BrowserContext, url: string): Promise<string> {
  const p = await ctx.newPage()
  await p.goto(url)
  await waitOnline(p)
  await waitFor(async () => (await hooks.sid(p)) !== null, 'new tab selected a session')
  await waitFor(async () => (await hooks.frames(p)).some((f) => f.kind === 'SNAPSHOT' && (f.flags & 1) === 0), 'new tab received a snapshot')
  await p.waitForTimeout(300) // let xterm finish parsing the snapshot
  const s = await serialize(p)
  await p.close()
  return s
}

async function generation(): Promise<number> {
  const r = await agent.reloadProbe()
  expect(r.code, `webterm reload --probe should exit 0: ${r.out}`).toBe(0)
  const m = r.out.match(/generation=(\d+)/)
  expect(m, r.out).toBeTruthy()
  return Number(m![1])
}

test('E2E-26 hot upgrade mid-output: one reconnect, 300 lines with no loss or duplicates, shell still alive, emulator state handed off', async ({ page }) => {
  await agent.open(page)
  const pid = agent.pid()
  expect(await generation()).toBe(0)

  // About 6s of output. The done marker appears only in output, not in the echoed command line.
  await submit(page, 'for i in $(seq 1 300); do printf "LINE-%03d\\n" $i; sleep 0.02; done; printf "REEXEC-%s\\n" DONE')
  await waitFor(async () => (await terminalText(page)).includes('LINE-040'), 'output is running')

  // Hot upgrade: watch the connection status and record every non-online state seen.
  const seen: string[] = []
  const watcher = (async () => {
    const t0 = Date.now()
    while (Date.now() - t0 < 8_000) {
      const txt = await page.getByTestId('conn-text').textContent().catch(() => null)
      if (txt && txt !== 'Online' && !seen.includes(txt)) seen.push(txt)
      await page.waitForTimeout(50)
    }
  })()
  agent.reexec()
  await waitFor(async () => (await terminalText(page)).includes('REEXEC-DONE'), 'command finished after hot upgrade', 20_000)
  await watcher
  await waitOnline(page)

  // Every line exactly once, in order.
  const text = await terminalText(page)
  const lines = text.match(/^LINE-\d{3}$/gm) ?? []
  const uniq = new Set(lines)
  expect(uniq.size, `${300 - uniq.size} lines lost`).toBe(300)
  expect(lines.length, `${lines.length - 300} lines duplicated`).toBe(300)
  for (let i = 0; i < 300; i++) expect(lines[i]).toBe(`LINE-${String(i + 1).padStart(3, '0')}`)

  // The client saw only an ordinary reconnect: instance_id unchanged, so resume is ok, not gone.
  const w = await lastWelcome(page)
  expect(w, 'a new welcome after reconnecting').not.toBeNull()
  expect(w!.resumed.length).toBeGreaterThan(0)
  expect(w!.resumed[0]!.status, `resumed=${JSON.stringify(w!.resumed)}`).toBe('ok')
  expect(seen.length, 'should briefly leave the online state and come back').toBeGreaterThan(0)

  // Shell alive, PID unchanged, new process reports generation 1.
  await submit(page, 'printf "ALIVE-%s\\n" AFTER')
  await waitFor(async () => (await terminalText(page)).includes('ALIVE-AFTER'), 'shell usable after handoff')
  expect(agent.pid()).toBe(pid)
  expect(agent.logs()).toContain('hot upgrade complete')
  expect(await generation()).toBe(1)

  // (5) Emulator state was handed off: with the session idle, open a fresh tab (snapshot path)
  // before and after an upgrade; the two must match line for line.
  await page.waitForTimeout(500)
  const before = await freshTabSerialize(page.context(), agent.baseURL)
  expect(before).toContain('ALIVE-AFTER')
  agent.reexec()
  await waitFor(async () => (await agent.reloadProbe()).out.includes('generation=2'), 'second hot upgrade finished', 30_000)
  await waitOnline(page)
  const after = await freshTabSerialize(page.context(), agent.baseURL)
  const a = before.split('\n')
  const b = after.split('\n')
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) throw new Error(`snapshot line ${i} differs across the upgrade\nbefore ${JSON.stringify(a[i])}\nafter  ${JSON.stringify(b[i])}`)
  }
})
