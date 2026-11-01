/**
 * E2E-39 Form (AC-5.18; ADR-0025 §1, layout.md "Form").
 *
 * Form is decided by the screen's short side, so each context sets both `viewport` and `screen`.
 */
import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, hooks, rectOf } from './harness'

const { defaultBrowserType: _a, ...PIXEL } = devices['Pixel 5']!
const { defaultBrowserType: _b, ...IPAD } = devices['iPad Mini']!

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

const form = (p: Page) => p.locator('.app').getAttribute('data-form')
const side = (p: Page) => p.evaluate(() => [...document.querySelectorAll('.ek-side > *')].map((e) => (e as HTMLElement).dataset.testid))

test.describe('Pixel 5', () => {
  test.use(PIXEL)
  test('E2E-39 (1) phone portrait (screen 393×851) -> compact: sessions button, no tab bar', async ({ page }) => {
    await agent.open(page)
    expect(await form(page)).toBe('compact')
    expect(await hooks.form(page)).toBe('compact')
    await expect(page.getByTestId('open-sessions')).toBeVisible()
    await expect(page.getByTestId('tabbar')).toHaveCount(0)
  })
})

test.describe('Pixel 5 landscape', () => {
  test.use({ ...PIXEL, viewport: { width: 851, height: 393 }, contextOptions: { screen: { width: 851, height: 393 } } })
  test('E2E-39 (2) viewport and screen both 851×393 -> still compact', async ({ page }) => {
    await agent.open(page)
    expect(await form(page)).toBe('compact')
    await expect(page.getByTestId('open-sessions')).toBeVisible()
    await expect(page.getByTestId('tabbar')).toHaveCount(0)
  })
})

test.describe('iPad Mini', () => {
  test.use({ ...IPAD, contextOptions: { screen: { width: 768, height: 1024 } } })
  test('E2E-39 (3)(5)(6) tablet -> wide: 40px tab bar, no sessions button, extra keys side column holds only ✎; keyboard and rotation keep the form', async ({ page }) => {
    await agent.open(page)
    expect(await form(page)).toBe('wide')
    await expect(page.getByTestId('tabbar')).toBeVisible()
    expect((await rectOf(page, '.topbar'))!.height, 'touch tab bar is 40px').toBe(40)
    await expect(page.getByTestId('open-sessions')).toHaveCount(0)
    await expect(page.getByTestId('extrakeys')).toBeVisible()
    expect(await side(page)).toEqual(['toggle-text'])

    // (5) Keyboard opens on a landscape tablet: viewport height shrinks to 344.
    await page.setViewportSize({ width: 1024, height: 344 })
    await page.waitForTimeout(400)
    expect(await form(page), 'opening the keyboard keeps the form').toBe('wide')
    await expect(page.getByTestId('tabbar')).toBeVisible()

    // (6) Rotate to landscape.
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.waitForTimeout(400)
    expect(await form(page), 'rotation keeps the form').toBe('wide')
    await expect(page.getByTestId('tabbar')).toBeVisible()
  })
})

test.describe('1440×900 mouse', () => {
  test.use({ viewport: { width: 1440, height: 900 }, contextOptions: { screen: { width: 1440, height: 900 } } })
  test('E2E-39 (4) desktop -> wide: 36px tab bar, no extra keys', async ({ page }) => {
    await agent.open(page)
    expect(await form(page)).toBe('wide')
    expect((await rectOf(page, '.topbar'))!.height).toBe(36)
    await expect(page.getByTestId('extrakeys')).toHaveCount(0)
    await expect(page.getByTestId('open-sessions')).toHaveCount(0)
  })
})
