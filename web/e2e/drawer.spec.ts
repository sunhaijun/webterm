/**
 * E2E-28 浮层与手机会话抽屉 —— AC-4.10 / AC-5.11 / AC-4.8。
 *
 * 设置与手机会话抽屉共用一个 Drawer：触屏贴底整宽 + 抓手 + 标题栏 + ✕，鼠标设备居中浮窗；
 * 关法一致，且浮层【不挤终端】。触屏抽屉有约 170ms 的进场动画，量矩形前先等它落位。
 */
import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, focusTerm, hooks, newSession, openDrawer, rectOf, settled, waitFor } from './harness'

const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
test.setTimeout(90_000)

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

const vp = (p: Page) => p.evaluate(() => ({ w: innerWidth, h: innerHeight }))
const activeInDrawer = (p: Page) => p.evaluate(() => document.activeElement?.closest('.drawer') !== null && document.activeElement !== null)
const activeClass = (p: Page) => p.evaluate(() => (document.activeElement as HTMLElement | null)?.className ?? '')

/** CDP 长按（触摸）。 */
async function longPress(page: Page, x: number, y: number, ms = 700) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  await page.waitForTimeout(ms)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

/** 终端几何快照：矩形、cols/rows、resize 计数。 */
async function termGeo(page: Page) {
  return { rect: await rectOf(page, '[data-testid=terminal]'), size: await hooks.size(page), resizes: await hooks.resizes(page) }
}

test.describe('Pixel 5', () => {
  test.use(PIXEL)

  test('E2E-28 ①②④ 会话抽屉：贴底整宽、抓手、✕、底部固定行；焦点进浮层；不挤终端', async ({ page }) => {
    await agent.open(page)
    await page.waitForTimeout(300) // 让首屏的 resize 防抖落定
    const before = await termGeo(page)

    await page.getByTestId('open-sessions').click()
    await settled(page, 'session-drawer')
    const r = (await rectOf(page, '[data-testid=session-drawer]'))!
    const v = await vp(page)
    expect(Math.abs(r.bottom - v.h), '贴底').toBeLessThanOrEqual(1)
    expect(r.left).toBeLessThanOrEqual(0)
    expect(r.right, '整宽').toBeGreaterThanOrEqual(v.w)
    await expect(page.getByTestId('session-drawer').locator('.drawer-grab'), '触屏有抓手').toBeVisible()
    await expect(page.getByTestId('session-drawer').getByTestId('drawer-close'), '标题栏有 ✕').toBeVisible()
    // 底部固定一行：新会话 · 设置
    const foot = page.getByTestId('session-drawer').locator('.drawer-foot')
    await expect(foot.getByTestId('new-session')).toBeVisible()
    await expect(foot.getByTestId('open-settings')).toBeVisible()
    expect(await activeInDrawer(page), '打开时焦点进浮层').toBe(true)

    expect(await termGeo(page), '开抽屉不改终端几何、不发 resize').toEqual(before)
    await page.getByTestId('drawer-close').click()
    await expect(page.getByTestId('session-drawer')).toHaveCount(0)

    // 设置（从抽屉底部进）：同一种壳
    await openDrawer(page)
    await page.getByTestId('open-settings').click()
    await expect(page.getByTestId('session-drawer')).toHaveCount(0)
    await settled(page, 'settings')
    const s = (await rectOf(page, '[data-testid=settings]'))!
    expect(Math.abs(s.bottom - v.h), '设置也贴底').toBeLessThanOrEqual(1)
    await expect(page.getByTestId('settings').locator('.drawer-grab')).toBeVisible()
    expect(await activeInDrawer(page), '设置打开时焦点进浮层').toBe(true)
    expect(await termGeo(page), '开设置不改终端几何、不发 resize').toEqual(before)

    // ⑦ 设置内容完整；改字号实时生效
    await expect(page.getByTestId('theme-select')).toBeVisible()
    await expect(page.getByTestId('font-family')).toBeVisible()
    await page.getByTestId('font-size').fill('18')
    await expect.poll(() => hooks.fontSize(page)).toBe(18)
  })

  test('E2E-28 ③ 会话抽屉五种关法：遮罩 / Esc / ✕ / 选中会话 / 返回键；历史记录不累积', async ({ page }) => {
    await agent.open(page)
    const sid = (await hooks.sid(page))!
    const h0 = await page.evaluate(() => history.length)
    const drawer = page.getByTestId('session-drawer')

    // 遮罩：点抽屉上方的空白
    await openDrawer(page)
    await page.getByTestId('drawer-backdrop').click({ position: { x: 20, y: 20 } })
    await expect(drawer).toHaveCount(0)

    // Esc
    await openDrawer(page)
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)

    // ✕
    await openDrawer(page)
    await page.getByTestId('drawer-close').click()
    await expect(drawer).toHaveCount(0)

    // 选中一个会话
    await openDrawer(page)
    await page.getByTestId(`session-${sid}`).click()
    await expect(drawer).toHaveCount(0)

    // 系统返回键：只关抽屉，不离开页面
    await openDrawer(page)
    await page.goBack()
    await expect(drawer).toHaveCount(0)
    expect(new URL(page.url()).pathname, '返回键之后仍在 /').toBe('/')
    await expect(page.getByTestId('terminal')).toBeVisible()

    await page.waitForTimeout(300) // history.back() 是异步的
    const h1 = await page.evaluate(() => history.length)
    expect(h1 - h0, `五次开关之后 history.length 从 ${h0} 变成 ${h1}`).toBeLessThanOrEqual(1)
  })

  test('E2E-28 ⑤ 焦点恢复：开抽屉前焦点在终端，选会话后在新会话的终端；不在则不给', async ({ page }) => {
    await agent.open(page)
    const a = (await hooks.sid(page))!
    const b = await newSession(page)
    expect(b).not.toBe(a)

    // 终端有焦点 → 开抽屉 → 选 A → 焦点在 A 的 helper textarea
    await focusTerm(page)
    await openDrawer(page)
    expect(await activeInDrawer(page)).toBe(true)
    await page.getByTestId(`session-${a}`).click()
    await waitFor(async () => (await hooks.sid(page)) === a, '切到 A')
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest('.term-host')?.getAttribute('data-sid') ?? null))
      .toBe(String(a))
    expect(await activeClass(page)).toContain('xterm-helper-textarea')

    // 终端失焦 → 开抽屉 → 选 B → 焦点【不】在终端（触屏上凭空 focus 会弹键盘）
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await openDrawer(page)
    await page.getByTestId(`session-${b}`).click()
    await waitFor(async () => (await hooks.sid(page)) === b, '切到 B')
    await page.waitForTimeout(200)
    expect(await activeClass(page), '之前不在终端，切过去也不该给终端焦点').not.toContain('xterm-helper-textarea')
  })

  test('E2E-28 ⑥ 会话菜单：长按一行弹出改名 / 保持接收 / 关闭；改名生效；点外面关闭', async ({ page }) => {
    await agent.open(page)
    const sid = (await hooks.sid(page))!
    await openDrawer(page)

    const row = page.getByTestId(`session-${sid}`)
    const box = (await row.boundingBox())!
    await longPress(page, box.x + box.width / 2, box.y + box.height / 2)
    const menu = page.getByTestId('session-menu')
    await expect(menu).toBeVisible()
    await expect(menu.getByTestId('session-rename')).toBeVisible()
    await expect(menu.getByTestId('session-pin')).toBeVisible()
    await expect(menu.getByTestId('session-close')).toBeVisible()

    await menu.getByTestId('session-rename').click()
    const input = page.getByTestId('rename-input')
    await expect(input).toBeFocused()
    await input.fill('RENAMED')
    await input.press('Enter')
    await expect(row.locator('.sl-text')).toHaveText('RENAMED')
    await expect(page.getByTestId('session-drawer'), '改名不关抽屉').toBeVisible()

    // 点外面关闭菜单
    await longPress(page, box.x + box.width / 2, box.y + box.height / 2)
    await expect(menu).toBeVisible()
    await page.getByTestId('session-menu-scrim').click({ position: { x: 10, y: 10 } })
    await expect(menu).toHaveCount(0)
  })
})

test.describe('1440×900 鼠标', () => {
  test.use({ viewport: { width: 1440, height: 900 }, contextOptions: { screen: { width: 1440, height: 900 } } })

  test('E2E-28 ①④ 设置（Ctrl+Shift+,）是居中浮窗、没有抓手；不挤终端；Esc 关闭', async ({ page }) => {
    await agent.open(page)
    await page.waitForTimeout(300)
    const before = await termGeo(page)

    await focusTerm(page)
    await page.keyboard.press('Control+Shift+Comma')
    await expect(page.getByTestId('settings')).toBeVisible()
    const r = (await rectOf(page, '[data-testid=settings]'))!
    const v = await vp(page)
    expect(Math.abs(r.left - (v.w - r.right)), '水平居中').toBeLessThanOrEqual(2)
    expect(Math.abs(r.top - (v.h - r.bottom)), '垂直居中').toBeLessThanOrEqual(2)
    expect(r.bottom, '不贴底').toBeLessThan(v.h - 20)
    await expect(page.getByTestId('settings').locator('.drawer-grab'), '鼠标设备没有抓手').toBeHidden()
    expect(await activeInDrawer(page), '焦点进浮层').toBe(true)
    expect(await termGeo(page), '开设置不改终端几何').toEqual(before)

    await expect(page.getByTestId('theme-select')).toBeVisible()
    await expect(page.getByTestId('font-size')).toBeVisible()
    await expect(page.getByTestId('font-family')).toBeVisible()
    await page.getByTestId('font-size').fill('18')
    await expect.poll(() => hooks.fontSize(page)).toBe(18)

    await page.keyboard.press('Escape')
    await expect(page.getByTestId('settings')).toHaveCount(0)
  })
})
