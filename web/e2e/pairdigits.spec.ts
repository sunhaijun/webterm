/**
 * E2E-27 Typing the numeric pairing code (AC-1.15, ADR-0017).
 *
 * Users who cannot scan the QR code open /pair and type the 16 digits shown in the terminal. The
 * digits and the QR code are two keys to the same pairing: using either one invalidates the other.
 */
import { expect, test } from '@playwright/test'

import { Agent, waitOnline } from './harness'

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

test('E2E-27 /pair without a fragment shows an input; space-separated digits pair; the QR code is then invalid; a wrong code can be retried', async ({ page, browser }) => {
  const digits = await agent.pairDigits()
  expect(digits).toMatch(/^\d{4}-\d{4}-\d{4}-\d{4}$/)

  await page.goto(agent.baseURL + '/pair')
  const input = page.getByTestId('pair-code')
  const submit = page.getByTestId('pair-submit')
  await expect(input).toBeVisible()
  await expect(input).toHaveAttribute('inputmode', 'numeric')
  await expect(submit, 'cannot submit fewer than 16 digits').toBeDisabled()

  // A 16-digit but wrong code: 401 message, input stays.
  const wrong = digits.replace(/\d$/, (d) => String((Number(d) + 1) % 10))
  await input.fill(wrong)
  await expect(submit).toBeEnabled()
  await submit.click()
  await expect(page.getByTestId('pair-status')).toContainText('Invalid')
  await expect(input, 'input is still editable after a wrong code').toBeVisible()

  // Paste with spaces -> auto-grouped with dashes -> pairs and lands on the main UI.
  await input.fill(digits.replace(/-/g, ' '))
  await expect(input).toHaveValue(digits)
  await submit.click()
  await page.waitForURL((u) => u.pathname === '/' && !u.hash, { timeout: 20_000 })
  await waitOnline(page)

  // The URL code (the QR code key) for the same pairing is now invalid.
  const ctx2 = await browser.newContext()
  const p2 = await ctx2.newPage()
  await p2.goto(agent.pairLink())
  await expect(p2.getByTestId('pair-status')).toContainText('Invalid')
  await ctx2.close()
})
