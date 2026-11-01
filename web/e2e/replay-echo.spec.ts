/**
 * No echo from reconnect catch-up (AC-2.15). E2E-30 (2) covers the incremental catch-up on the
 * switch-back (subscribe) path; this is the same rule on the reconnect path
 * (welcome.resumed[].status == "ok"). It has no scenario number of its own.
 *
 * Terminal queries (DSR, DA, ...) a program emitted while the client was offline are history. When
 * catch-up writes them into xterm, xterm answers them automatically. Those answers are not user
 * input; the replay gate must drop them, or the foreground program receives a burst of garbage keys.
 */
import { expect, test } from '@playwright/test'

import { Agent, installWSControl, lastWelcome, recordSent, submit, waitOnline } from './harness'

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

test('AC-2.15 terminal queries in reconnect catch-up are not answered into the PTY', async ({ page }) => {
  const rec = await recordSent(page)
  const net = await installWSControl(page)
  await agent.open(page)

  // After 2s, send a DSR cursor position query (\e[6n), then hang.
  await submit(page, 'sleep 2; printf "\\033[6n"; sleep 30')
  await net.goOffline() // drop now so the query lands in the offline window and only arrives via catch-up
  await page.waitForTimeout(3000)
  net.goOnline()
  await waitOnline(page)
  expect((await lastWelcome(page))!.resumed.every((r) => r.status === 'ok'), 'this test covers incremental catch-up').toBe(true)
  await page.waitForTimeout(800) // let catch-up reach xterm

  const cpr = (await rec.input()).some((s) => /\x1b\[\d+;\d+R/.test(s))
  expect(cpr, 'xterm must not answer a replayed DSR query as PTY input').toBe(false)
})
