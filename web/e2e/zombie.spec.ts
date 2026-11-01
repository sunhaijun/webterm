/**
 * E2E-33 Zombie connection is exposed as soon as the app returns to the foreground (AC-2.20 /
 * AC-2.4, ADR-0020).
 *
 * A zombie connection is a dead line with no onclose. Screen off, app switch, Wi-Fi to cellular,
 * silent NAT or reverse-proxy reaping: none of these send a FIN, so `readyState` stays OPEN. The
 * page thinks it is online, keystrokes go into a dead socket, and nothing changes on screen.
 *
 * The heartbeat alone (30s ping + 10s pong timeout) takes up to 40s to notice. On `online` and on
 * the page becoming visible again, the client now probes immediately and declares the socket dead
 * if no pong arrives within 2s.
 */
import { expect, test } from '@playwright/test'

import { Agent, focusTerm, installWSControl, terminalText, waitFor } from './harness'

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

test('E2E-33 dead line without onclose: detected and reconnected within 5s of returning to the foreground; input typed meanwhile is not lost', async ({
  page,
}) => {
  const net = await installWSControl(page)
  await agent.open(page)

  // Baseline: the path works, so "typing does nothing" below means something.
  await focusTerm(page)
  await page.keyboard.type('echo ALIVE')
  await page.keyboard.press('Enter')
  await waitFor(async () => (await terminalText(page)).includes('ALIVE'), 'ALIVE echoed')

  net.goZombie()

  // Type a line while zombied: it enters the resend queue and the dead socket, but no byte reaches the agent.
  await page.keyboard.type('echo ZOMBIE')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)
  await expect(
    page.getByTestId('conn-text'),
    'the bug: the line is dead but the page still thinks it is online',
  ).toHaveText('Online')
  expect(await terminalText(page), 'dead socket, not even an echo').not.toContain('ZOMBIE')

  // The user brings the app back to the foreground.
  const t0 = Date.now()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))

  await expect(page.getByTestId('conn-text'), 'the liveness probe exposes it immediately').not.toHaveText('Online', {
    timeout: 5_000,
  })
  const detectMs = Date.now() - t0
  expect(detectMs, `heartbeat alone needs 30s ping + 10s pong; measured ${detectMs}ms`).toBeLessThan(5_000)

  net.goOnline()
  await expect(page.getByTestId('conn-text')).toHaveText('Online', { timeout: 40_000 })

  // Probing must not lose input: the line typed while zombied is resent from in_ack and runs (AC-2.4).
  await waitFor(async () => (await terminalText(page)).includes('ZOMBIE'), 'ZOMBIE runs after reconnect')
})
