/**
 * E2E-36 Scrollback still works after a reload (AC-5.14 / AC-2.6 / AC-2.13, ADR-0026).
 *
 * Default `--ring-bytes`. A reload wipes browser state (out_seq back to 0), so every subscribe takes
 * the snapshot path: the agent exports the current screen plus up to 2000 lines of history from its
 * emulator. The browser keeps no local snapshot.
 *
 * Each emit.sh line is `line NNNNN ...`, 147 columns wide. 1440×900 keeps lines from wrapping, so
 * "the last 2000 lines" start right after line 1000.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

import {
  ALTSCREEN,
  Agent,
  EMIT,
  count,
  hooks,
  newSession,
  submit,
  switchTo,
  terminalText,
  waitFor,
  waitOnline,
  waitSnapshot,
  waitText,
} from './harness'

test.use({ viewport: { width: 1440, height: 900 }, contextOptions: { screen: { width: 1440, height: 900 } } })

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

/** reloadAndSnapshot reloads the page and waits for the snapshot to be written. */
async function reloadAndSnapshot(page: Page, sid: number) {
  await page.reload()
  await waitOnline(page)
  await waitFor(async () => (await hooks.sid(page)) !== null, 'a session is selected after reload')
  if ((await hooks.sid(page)) !== sid) await switchTo(page, sid)
  await waitFor(async () => (await hooks.frames(page)).some((f) => f.sid === sid && f.kind === 'SNAPSHOT' && (f.flags & 1) === 0), 'reload took the snapshot path')
  await page.waitForTimeout(500)
}

test('E2E-36 after reload: scroll back through the last 2000 lines, one copy, output continues cleanly; alternate-screen session shows the current screen; agent restart leaves no old sessions', async ({ page }) => {
  test.setTimeout(150_000)
  await agent.open(page)
  const a = (await hooks.sid(page))!
  expect((await hooks.size(page)).cols, 'an emit line does not wrap').toBeGreaterThanOrEqual(147)

  // (1)
  await submit(page, `${EMIT} 3000 0`)
  await waitText(page, 'EMIT-DONE', 'output finished', 60_000)

  // (2) Reload: out_seq == 0 -> snapshot.
  await reloadAndSnapshot(page, a)
  expect((await hooks.frames(page)).find((f) => f.sid === a)?.kind, 'first frame after reload is SNAPSHOT').toBe('SNAPSHOT')

  // (3)(4) Scrollback is there, exactly once.
  const ser = await hooks.serialize(page)
  expect(ser, 'content within the last 2000 lines is present').toContain('line 01500')
  expect(ser, 'content older than 2000 lines is gone').not.toContain('line 00100')
  const text = await terminalText(page)
  expect(count(text, 'line 01500 '), 'exactly one copy').toBe(1)
  expect(count(text, 'EMIT-DONE')).toBe(1)

  // (5) Output continues cleanly: run another command; earlier content does not reflow.
  const before = text.split('\n')
  await submit(page, "printf 'AFTER-%s\\n' RELOAD")
  await waitText(page, /^AFTER-RELOAD$/m)
  const after = (await terminalText(page)).split('\n')
  const keep = before.length - 1 // the last line is the prompt the command was typed on
  expect(after.slice(0, keep), 'new output after reload must not reflow earlier content').toEqual(before.slice(0, keep))

  // (7) An alternate-screen session shows its current screen after reload: FRAME appears once and
  // scrollback holds no copy of the UI.
  const b = await newSession(page)
  const dir = mkdtempSync(join(tmpdir(), 'webterm-e2e36-'))
  await submit(page, `${ALTSCREEN} 1 ${join(dir, 'busy')}`)
  await waitText(page, 'FRAME', 'fake TUI drew its first screen')
  await page.waitForTimeout(1500)
  await reloadAndSnapshot(page, b)
  expect(await hooks.altScreen(page), 'back on the alternate screen after reload').toBe(true)
  expect(count(await terminalText(page), 'FRAME'), 'one copy of the UI on the current screen').toBe(1)
  expect(count(await hooks.serialize(page), 'FRAME'), 'no copy of the UI in the main screen buffer').toBe(1)

  // (6) Agent restart: instance_id changes and all sessions are destroyed, so the session created
  // after reload shows no old output.
  const oldInstance = (await hooks.welcome(page))!.instance_id
  await agent.restart()
  await page.reload()
  await waitOnline(page)
  await waitFor(async () => (await hooks.sid(page)) !== null, 'a new session was created after reload')
  expect((await hooks.welcome(page))!.instance_id).not.toBe(oldInstance)
  const sid = (await hooks.sid(page))!
  await waitSnapshot(() => hooks.frames(page), sid, 'first screen of the new session')
  await page.waitForTimeout(800)
  const fresh = await terminalText(page)
  expect(fresh, 'no output from old sessions').not.toContain('line 0')
  expect(fresh).not.toContain('EMIT-DONE')
  expect(fresh).not.toContain('FRAME')
})
