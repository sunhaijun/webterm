/**
 * E2E-1 Basic round trip (AC-1.3 / AC-1.9 / AC-4.1).
 * Also two frontend guards on pairing: the unpaired landing page (AC-1.7) and single-use pairing
 * codes (AC-1.4 / AC-1.5).
 */
import { expect, test } from '@playwright/test'

import { Agent, hooks, terminalText, termSize, waitFor, waitOnline } from './harness'

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

test('E2E-1 pair -> session created automatically -> click terminal and type -> output appears; stty size matches the frontend', async ({ page, context }) => {
  await agent.pair(page)

  // Cookie attributes (AC-1.9).
  const cookie = (await context.cookies()).find((c) => c.name === 'webterm_session')
  expect(cookie, 'pairing sets a session cookie').toBeTruthy()
  expect(cookie!.httpOnly, 'cookie must be HttpOnly').toBe(true)
  expect(cookie!.sameSite, 'cookie must be SameSite=Strict').toBe('Strict')

  await page.goto(agent.baseURL)
  await waitOnline(page)
  // First connection with no sessions -> one is created automatically.
  await waitFor(async () => (await hooks.sid(page)) !== null, 'first session created automatically')

  // Click the terminal and type; there is no input mode (ADR-0025).
  await page.getByTestId('terminal').click({ position: { x: 80, y: 80 } })
  await page.keyboard.type('echo hello-webterm')
  await page.keyboard.press('Enter')
  // Assert on the output line, not the echoed command line, which also contains hello-webterm.
  await waitFor(
    async () => (await terminalText(page)).split('\n').some((l) => l.trimEnd() === 'hello-webterm'),
    'terminal shows hello-webterm as an output line',
  )

  // The PTY size must match the cols/rows the frontend computed. Otherwise line wrapping is off and
  // everything layout-related breaks with it.
  const size = await termSize(page)
  expect(size.cols).toBeGreaterThan(20)
  await page.keyboard.type('stty size')
  await page.keyboard.press('Enter')
  await waitFor(
    async () => new RegExp(`^${size.rows} ${size.cols}$`, 'm').test(await terminalText(page)),
    `stty size prints "${size.rows} ${size.cols}"`,
  )
})

/** An unpaired browser gets clear instructions instead of a blank page (frontend side of AC-1.7). */
test('unpaired browser shows pairing instructions', async ({ page }) => {
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('unpaired')).toBeVisible()
  await expect(page.getByTestId('unpaired')).toContainText('webterm pair')
})

/** Pairing codes are single-use: opening the same link again fails (AC-1.4) and leaves nothing in history (AC-1.5). */
test('pairing code is invalid after first use', async ({ page, browser }) => {
  await agent.pair(page)

  const second = await browser.newContext()
  const p2 = await second.newPage()
  await p2.goto(agent.pairLink())
  // The second attempt stays on the pairing page and says why, instead of quietly letting it through.
  await expect(p2.getByTestId('pair-status')).toContainText(/invalid|expired/i)
  expect(new URL(p2.url()).pathname, 'a failed pairing must not enter the main UI').toBe('/pair')

  // The pairing code must not stay in browser history either (AC-1.5).
  expect(p2.url(), 'replaceState removes the pairing code').not.toContain('#')
  await second.close()
})
