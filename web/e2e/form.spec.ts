/**
 * E2E-39 形态 —— AC-5.18（ADR-0025 §1，layout.md §形态）。
 *
 * 形态按屏幕短边判，所以 context 要同时给 `viewport` 与 `screen`。
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
  test('E2E-39 ① 手机竖屏（screen 393×851）→ compact：有会话按钮、没有标签栏', async ({ page }) => {
    await agent.open(page)
    expect(await form(page)).toBe('compact')
    expect(await hooks.form(page)).toBe('compact')
    await expect(page.getByTestId('open-sessions')).toBeVisible()
    await expect(page.getByTestId('tabbar')).toHaveCount(0)
  })
})

test.describe('Pixel 5 横屏', () => {
  test.use({ ...PIXEL, viewport: { width: 851, height: 393 }, contextOptions: { screen: { width: 851, height: 393 } } })
  test('E2E-39 ② viewport 与 screen 都是 851×393 → 仍是 compact', async ({ page }) => {
    await agent.open(page)
    expect(await form(page)).toBe('compact')
    await expect(page.getByTestId('open-sessions')).toBeVisible()
    await expect(page.getByTestId('tabbar')).toHaveCount(0)
  })
})

test.describe('iPad Mini', () => {
  test.use({ ...IPAD, contextOptions: { screen: { width: 768, height: 1024 } } })
  test('E2E-39 ③⑤⑥ 平板 → wide：标签栏 40px、无会话按钮、附加键左列只有 ✎；弹键盘、旋转都不改形态', async ({ page }) => {
    await agent.open(page)
    expect(await form(page)).toBe('wide')
    await expect(page.getByTestId('tabbar')).toBeVisible()
    expect((await rectOf(page, '.topbar'))!.height, '触屏标签栏 40px').toBe(40)
    await expect(page.getByTestId('open-sessions')).toHaveCount(0)
    await expect(page.getByTestId('extrakeys')).toBeVisible()
    expect(await side(page)).toEqual(['toggle-text'])

    // ⑤ 平板横屏弹键盘：视口高度缩到 344
    await page.setViewportSize({ width: 1024, height: 344 })
    await page.waitForTimeout(400)
    expect(await form(page), '键盘弹出不改形态').toBe('wide')
    await expect(page.getByTestId('tabbar')).toBeVisible()

    // ⑥ 旋转：横屏
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.waitForTimeout(400)
    expect(await form(page), '旋转不改形态').toBe('wide')
    await expect(page.getByTestId('tabbar')).toBeVisible()
  })
})

test.describe('1440×900 鼠标', () => {
  test.use({ viewport: { width: 1440, height: 900 }, contextOptions: { screen: { width: 1440, height: 900 } } })
  test('E2E-39 ④ 桌面 → wide：标签栏 36px、没有附加键', async ({ page }) => {
    await agent.open(page)
    expect(await form(page)).toBe('wide')
    expect((await rectOf(page, '.topbar'))!.height).toBe(36)
    await expect(page.getByTestId('extrakeys')).toHaveCount(0)
    await expect(page.getByTestId('open-sessions')).toHaveCount(0)
  })
})
