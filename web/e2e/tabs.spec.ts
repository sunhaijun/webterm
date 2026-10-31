/**
 * E2E-41 宽屏标签栏 —— AC-4.10（另含 AC-4.8 的「切换不改几何」）。
 *
 * 1440×900 鼠标；第 7 步用 iPad Mini 设备描述（触屏 wide）。
 */
import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, EMIT, framesSince, hooks, newSession, rectOf, submit, switchTo, waitFor, waitText } from './harness'

const WIDE = { viewport: { width: 1440, height: 900 }, contextOptions: { screen: { width: 1440, height: 900 } } }
const { defaultBrowserType: _p, ...IPAD } = devices['iPad Mini']!

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

const geo = async (p: Page) => ({ rect: await rectOf(p, '[data-testid=terminal]'), size: await hooks.size(p) })
const closeVisible = (p: Page, sid: number) =>
  p.getByTestId(`tab-${sid}-close`).evaluate((el) => getComputedStyle(el).visibility === 'visible')
/** 标签上显示的名字（不含 ⇵ 与未读点）。 */
const tabName = (p: Page, sid: number) => p.getByTestId(`tab-${sid}`).locator('.tab-name').textContent()

test.describe('1440×900 鼠标', () => {
  test.use(WIDE)

  test('E2E-41 ①② 结构；新建与切换不改终端几何', async ({ page }) => {
    await agent.open(page)
    const a = (await hooks.sid(page))!

    // ① 顶栏在终端上方；标签条里一个标签 + `+`；右侧钉住状态点与 ⚙；没有 ☰、没有附加键
    await expect(page.locator('.app')).toHaveAttribute('data-form', 'wide')
    const bar = (await rectOf(page, '.topbar'))!
    const term = (await rectOf(page, '[data-testid=terminal]'))!
    expect(bar.bottom).toBeLessThanOrEqual(term.top + 1)
    expect(bar.height, '标签栏 36px（鼠标）').toBe(36)
    const tabbar = page.getByTestId('tabbar')
    await expect(tabbar.locator('.tab')).toHaveCount(1)
    await expect(tabbar.getByTestId('new-session')).toBeVisible()
    await expect(tabbar.getByTestId('conn-dot'), '状态点不在可滚动的标签条里').toHaveCount(0)
    await expect(tabbar.getByTestId('open-settings')).toHaveCount(0)
    await expect(page.locator('.topbar').getByTestId('conn-dot')).toHaveAttribute('data-state', 'online')
    await expect(page.locator('.topbar').getByTestId('open-settings')).toBeVisible()
    const dot = (await rectOf(page, '[data-testid=conn-dot]'))!
    const gear = (await rectOf(page, '.topbar [data-testid=open-settings]'))!
    const strip = (await rectOf(page, '[data-testid=tabbar]'))!
    expect(dot.left, '状态点在标签条右边').toBeGreaterThanOrEqual(strip.right - 1)
    expect(gear.right, '⚙ 在最右').toBeGreaterThanOrEqual(bar.right - 1)
    await expect(page.getByTestId('open-sessions')).toHaveCount(0)
    await expect(page.getByTestId('extrakeys')).toHaveCount(0)

    // ② 新建与切换：几何全程不变
    await page.waitForTimeout(300)
    const g0 = await geo(page)
    await page.getByTestId('new-session').click()
    await expect(tabbar.locator('.tab')).toHaveCount(2)
    await waitFor(async () => (await hooks.sid(page)) !== a, '新标签成为当前')
    const b = (await hooks.sid(page))!
    await expect(page.getByTestId(`tab-${b}`)).toHaveAttribute('aria-current', 'true')
    expect(await geo(page)).toEqual(g0)
    await page.getByTestId(`tab-${a}`).click()
    await waitFor(async () => (await hooks.sid(page)) === a, '点第一个标签切回去')
    expect(await geo(page)).toEqual(g0)
  })

  test('E2E-41 ③ 关闭：悬停出 ✕、在跑先确认；中键同样关闭', async ({ page }) => {
    await agent.open(page)
    const a = (await hooks.sid(page))!
    const b = await newSession(page)
    const c = await newSession(page)

    // 非当前标签：平时 ✕ 隐藏，悬停才出现
    expect(await closeVisible(page, a)).toBe(false)
    await page.getByTestId(`tab-${a}`).hover()
    expect(await closeVisible(page, a), '悬停出 ✕').toBe(true)

    const dialogs: string[] = []
    page.on('dialog', (d) => {
      dialogs.push(d.message())
      void d.accept()
    })
    await page.getByTestId(`tab-${a}-close`).click()
    await expect.poll(() => dialogs.length, { message: '会话在跑：先弹确认' }).toBe(1)
    await expect(page.getByTestId(`tab-${a}`)).toHaveCount(0)
    expect(await hooks.sid(page), '关的不是当前标签，当前不变').toBe(c)

    // 中键点标签 = 关闭
    await page.getByTestId(`tab-${b}`).click({ button: 'middle' })
    await expect.poll(() => dialogs.length).toBe(2)
    await expect(page.getByTestId(`tab-${b}`)).toHaveCount(0)
  })

  test('E2E-41 ④ 改名：双击 → 输入框 → 回车；清空回车恢复自动命名', async ({ page }) => {
    await agent.open(page)
    const sid = (await hooks.sid(page))!
    const auto = (await tabName(page, sid))!
    expect(auto, '自动命名 = CWD 的 basename（家目录是 ~）').toBe('~')

    await page.getByTestId(`tab-${sid}`).dblclick()
    const input = page.getByTestId('rename-input')
    await expect(input).toBeFocused()
    await input.fill('RENAMED')
    await input.press('Enter')
    await expect.poll(() => tabName(page, sid)).toBe('RENAMED')

    // 改名之后不再跟随 CWD
    await submit(page, 'cd /tmp')
    await page.waitForTimeout(1500)
    expect(await tabName(page, sid)).toBe('RENAMED')

    await page.getByTestId(`tab-${sid}`).dblclick()
    await input.fill('')
    await input.press('Enter')
    await expect.poll(() => tabName(page, sid), { message: '清空 → 恢复自动命名（当前 CWD 的 basename）' }).toBe('tmp')
  })

  test('E2E-41 ⑤ 会话菜单：右键 → 改名 / 保持接收 / 关闭；保持接收后切走仍在收', async ({ page }) => {
    await agent.open(page)
    const a = (await hooks.sid(page))!
    await newSession(page)

    await page.getByTestId(`tab-${a}`).click({ button: 'right' })
    const menu = page.getByTestId('session-menu')
    await expect(menu).toBeVisible()
    await expect(menu.getByTestId('session-rename')).toBeVisible()
    await expect(menu.getByTestId('session-pin')).toHaveAttribute('aria-checked', 'false')
    await expect(menu.getByTestId('session-close')).toBeVisible()
    await menu.getByTestId('session-pin').click()
    await expect(menu).toHaveCount(0)
    await expect(page.getByTestId(`tab-${a}`).locator('.pin-mark'), '名字前出现 ⇵').toHaveText('⇵')

    // A 跑持续输出，切到别的会话：A 的帧照样到（outSeq 在涨），也就不会有未读
    await switchTo(page, a)
    await submit(page, `${EMIT} 60 50`)
    await waitText(page, 'line 00003')
    const read = await framesSince(page)
    const b = (await page.locator('.tabbar .tab').nth(1).getAttribute('data-sid'))!
    await switchTo(page, Number(b))
    await page.waitForTimeout(1500)
    const fs = (await read()).filter((f) => f.sid === a && f.kind === 'OUTPUT')
    expect(fs.length, '保持接收：切走后仍收到 A 的 OUTPUT').toBeGreaterThan(3)
    const seqs = fs.map((f) => f.seq)
    expect(seqs[seqs.length - 1]!, 'A 的 outSeq 在涨').toBeGreaterThan(seqs[0]!)
    expect(await hooks.unread(page, a)).toBe(false)
  })

  test('E2E-41 ⑥ 未读：A 持续输出，切到 B → A 的标签有未读点；切回消失', async ({ page }) => {
    await agent.open(page)
    const a = (await hooks.sid(page))!
    const b = await newSession(page)
    await switchTo(page, a)
    await submit(page, `${EMIT} 80 50`)
    await waitText(page, 'line 00003')
    await switchTo(page, b)
    await expect(page.getByTestId(`tab-${a}-unread`)).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId(`tab-${a}`)).toHaveAttribute('data-unread', 'true')
    await switchTo(page, a)
    await expect(page.getByTestId(`tab-${a}-unread`)).toHaveCount(0)
    await expect(page.getByTestId(`tab-${a}`)).toHaveAttribute('data-unread', 'false')
  })
})

test.describe('iPad Mini 触屏', () => {
  test.use(IPAD)

  test('E2E-41 ⑦ 触屏：✕ 只在当前标签上；长按标签弹会话菜单；附加键在、左列只有 ✎', async ({ page }) => {
    await agent.open(page)
    const a = (await hooks.sid(page))!
    const b = await newSession(page)

    await expect(page.locator('.app')).toHaveAttribute('data-form', 'wide')
    await expect(page.locator('.app')).toHaveAttribute('data-coarse', 'true')
    expect(await closeVisible(page, b), '当前标签有 ✕').toBe(true)
    expect(await closeVisible(page, a), '非当前标签没有 ✕（免得误点）').toBe(false)

    const box = (await page.getByTestId(`tab-${a}`).boundingBox())!
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] })
    await page.waitForTimeout(700)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await cdp.detach()
    await expect(page.getByTestId('session-menu')).toBeVisible()
    expect(await hooks.sid(page), '长按不切会话').toBe(b)
    await page.getByTestId('session-menu-scrim').click({ position: { x: 5, y: 500 } })

    await expect(page.getByTestId('extrakeys')).toBeVisible()
    const side = await page.evaluate(() => [...document.querySelectorAll('.ek-side > *')].map((e) => (e as HTMLElement).dataset.testid))
    expect(side, 'wide 上左列只有 ✎').toEqual(['toggle-text'])
  })
})
