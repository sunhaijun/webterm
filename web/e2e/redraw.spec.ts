/**
 * E2E-31 Switching back to an alternate-screen session shows the current screen (AC-2.6 / AC-2.11 /
 * AC-2.15 / AC-2.21, ADR-0026).
 *
 * A byte window cannot reconstruct an alternate-screen program's current screen; a snapshot can,
 * because the emulator holds exactly that screen. Runs with `--ring-bytes 65536`; the fixture
 * `fixtures/altscreen.sh` is a fake TUI modeled on measured claude output.
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

import {
  ALTSCREEN,
  Agent,
  count,
  focusTerm,
  framesSince,
  hooks,
  newSession,
  submit,
  switchTo,
  terminalText,
  waitFor,
  waitSnapshot,
  waitText,
} from './harness'

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start({ ringBytes: 65536 })
})
test.afterEach(() => agent.stop())

test('E2E-31 switching back to an alternate-screen session uses a snapshot: KB-sized, back on the alternate screen, one copy of the UI, no resize; no residue on the main screen after exit', async ({ page }) => {
  test.setTimeout(150_000)
  await agent.open(page)
  const dir = mkdtempSync(join(tmpdir(), 'webterm-e2e31-'))
  const busy = join(dir, 'busy')

  // (1) Run the fake TUI in A: busy for 5s (~30 KB/s, overruns the 64 KiB window several times), then idle.
  const a = (await hooks.sid(page))!
  await submit(page, `${ALTSCREEN} 5 ${busy}`)
  await waitText(page, 'FRAME', 'fake TUI drew its first screen')
  expect(await hooks.altScreen(page), 'fake TUI should be on the alternate screen').toBe(true)

  // (2) Switch to B; wait for A to overrun the window and go idle.
  const b = await newSession(page)
  await waitFor(() => existsSync(busy), 'A overran the window and went idle', 60_000)
  await page.waitForTimeout(300)

  // (3) Switch back to A.
  const read = await framesSince(page)
  await switchTo(page, a)
  const snap = await waitSnapshot(read, a, 'switch-back uses a snapshot')
  const bytes = snap.reduce((n, f) => n + f.bytes, 0)
  expect(bytes, `snapshot is ${bytes} bytes: one screen is KB-sized, not the whole ring_bytes`).toBeLessThan(8 * 1024)
  await waitFor(() => hooks.altScreen(page), 'snapshot put the client back on the alternate screen')
  await waitText(page, 'FRAME')
  await page.waitForTimeout(500)
  const text = await terminalText(page)
  expect(count(text, 'FRAME'), 'one copy of the UI on screen').toBe(1)
  // Scrollback (the main screen buffer) holds no copy of the program's UI. The serialization covers
  // both the main buffer and the alternate screen, so the UI should appear exactly once.
  const ser = await hooks.serialize(page)
  expect(count(ser, 'FRAME'), 'main screen buffer holds a copy of the fake TUI').toBe(1)
  expect(count(ser, 'row 05 '), 'UI content rows appear once').toBe(1)
  // The agent did not resize on switch-back: no SIGWINCH, so the FRAME counter is still 000.
  expect(text, 'switch-back must not trigger a SIGWINCH full redraw').toContain('FRAME 000')

  // (4) Quit the fake TUI (SIGINT -> ESC[?1049l back to the main screen), have A overrun the window
  // again, then switch away and back.
  await focusTerm(page)
  await page.keyboard.press('Control+c')
  await waitFor(async () => !(await hooks.altScreen(page)), 'fake TUI exited, back on the main screen')
  const flood = join(dir, 'flood')
  await submit(page, `(sleep 3; for i in $(seq 1 2500); do printf 'pad %04d %s\\n' $i ${'x'.repeat(60)}; done; touch ${flood}) &`)
  await switchTo(page, b)
  await waitFor(() => existsSync(flood), 'main-screen backlog overran the window', 60_000)
  const read2 = await framesSince(page)
  await switchTo(page, a)
  await waitSnapshot(read2, a, 'switch-back after exit still uses a snapshot')
  await waitText(page, 'pad 2500')
  await page.waitForTimeout(300)
  expect(await hooks.altScreen(page), 'main screen').toBe(false)
  const main = await terminalText(page)
  expect(count(main, 'FRAME'), 'no fake TUI residue on the main screen').toBe(0)
  expect(count(main, 'tick 0'), 'no fake TUI content rows on the main screen').toBe(0)
})
