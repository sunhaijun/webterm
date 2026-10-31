/**
 * E2E-28 浮层与手机会话抽屉 —— AC-4.10 / AC-4.11 / AC-5.11 / AC-4.8。
 *
 * 手机会话抽屉：贴底整宽 + 抓手 + 标题栏 + ✕，浮层【不挤终端】；会话按钮的方框里是会话数。
 * 至少半屏高、底部一行四周留白（ADR-0037 §5）；关闭确认叠在抽屉上（ADR-0038）；从抽屉进设置。
 * 抽屉有约 170ms 的进场动画，量矩形前先等它落位。
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

/** CDP 触摸拖动：按下 → 分 steps 步移到终点 → 抬起。 */
async function touchDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 8, holdMs = 0) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] })
  if (holdMs) await page.waitForTimeout(holdMs)
  for (let i = 1; i <= steps; i++) {
    const p = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] })
    await page.waitForTimeout(16)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

/** 左滑一行 dx 像素（从行的右侧三分之二处起手）。 */
async function swipeRow(page: Page, sid: number, dx: number) {
  const b = (await page.getByTestId(`session-${sid}`).boundingBox())!
  const from = { x: b.x + b.width * 0.66, y: b.y + b.height / 2 }
  await touchDrag(page, from, { x: from.x + dx, y: from.y })
}

/** 一行正文此刻的横向位移（打开 = −216）。等过渡结束。 */
async function rowShift(page: Page, sid: number): Promise<number> {
  await page.waitForTimeout(260)
  return page.getByTestId(`session-${sid}`).evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41)
}

/** 终端几何快照：矩形、cols/rows、resize 计数。 */
async function termGeo(page: Page) {
  return { rect: await rectOf(page, '[data-testid=terminal]'), size: await hooks.size(page), resizes: await hooks.resizes(page) }
}

test.describe('Pixel 5', () => {
  test.use(PIXEL)

  test('E2E-28 ①②④ 会话抽屉：会话数、贴底整宽、抓手、✕、底部固定行；焦点进浮层；不挤终端', async ({ page }) => {
    await agent.open(page)
    await page.waitForTimeout(300) // 让首屏的 resize 防抖落定
    const before = await termGeo(page)
    const button = page.getByTestId('open-sessions')
    await expect(button, '会话按钮的方框里是会话数').toHaveText('1')

    await button.click()
    await settled(page, 'session-drawer')
    const r = (await rectOf(page, '[data-testid=session-drawer]'))!
    const v = await vp(page)
    expect(Math.abs(r.bottom - v.h), '贴底').toBeLessThanOrEqual(1)
    expect(r.left).toBeLessThanOrEqual(0)
    expect(r.right, '整宽').toBeGreaterThanOrEqual(v.w)
    await expect(page.getByTestId('session-drawer').locator('.drawer-grab'), '触屏有抓手').toBeVisible()
    await expect(page.getByTestId('session-drawer').getByTestId('drawer-close'), '标题栏有 ✕').toBeVisible()
    // 底部固定一行：新会话与设置，各有一个线条图标（ADR-0037）
    const foot = page.getByTestId('session-drawer').locator('.drawer-foot')
    await expect(foot.getByTestId('new-session')).toBeVisible()
    await expect(foot.getByTestId('open-settings')).toBeVisible()
    await expect(foot.locator('button')).toHaveCount(2)
    await expect(foot.locator('button svg')).toHaveCount(2)
    expect(await activeInDrawer(page), '打开时焦点进浮层').toBe(true)

    expect(await termGeo(page), '开抽屉不改终端几何、不发 resize').toEqual(before)
    await page.getByTestId('drawer-close').click()
    await expect(page.getByTestId('session-drawer')).toHaveCount(0)

    // 会话数跟着新建 / 关闭即时变
    const b = await newSession(page)
    await expect(button, '新建之后').toHaveText('2')
    let dialogs = 0
    page.on('dialog', (d) => {
      dialogs++
      void d.dismiss()
    })
    await openDrawer(page)
    const closeFromMenu = async () => {
      await swipeRow(page, b, -150)
      await page.getByTestId(`session-${b}`).locator('xpath=..').getByTestId('row-close').click()
      await settled(page, 'close-confirm')
    }
    // 关闭确认：贴底 sheet，叠在抽屉上；Esc 只关最上面那层（AC-4.11）
    await closeFromMenu()
    const c = (await rectOf(page, '[data-testid=close-confirm]'))!
    expect(Math.abs(c.bottom - v.h), '确认也是贴底 sheet').toBeLessThanOrEqual(1)
    expect(c.right - c.left, '整宽').toBeGreaterThanOrEqual(v.w)
    await expect(page.locator('.drawer'), '叠在会话抽屉上').toHaveCount(2)
    await expect(page.getByTestId('close-confirm')).toContainText('关闭「')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('close-confirm')).toHaveCount(0)
    await expect(page.getByTestId('session-drawer'), 'Esc 只关确认，抽屉还在').toBeVisible()
    await expect(page.getByTestId(`session-${b}`)).toBeVisible()
    await closeFromMenu()
    await page.getByTestId('close-ok').click()
    await expect(page.getByTestId(`session-${b}`)).toHaveCount(0)
    await expect(page.getByTestId('session-drawer'), '确认之后仍在列表里').toBeVisible()
    await expect(button, '关掉之后').toHaveText('1')
    expect(dialogs, '不用浏览器对话框').toBe(0)
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

  test('E2E-28 ⑥ 行操作：左滑 / 长按露出保持接收 · 改名 · 关闭；改名是叠在抽屉上的小 sheet（ADR-0039）', async ({ page }) => {
    await agent.open(page)
    const a = (await hooks.sid(page))!
    const b = await newSession(page)
    await openDrawer(page)
    const item = (sid: number) => page.getByTestId(`session-${sid}`).locator('xpath=..')

    // 左滑过半 → 停在打开；不到一半 → 弹回；打开后右滑 → 关上
    await swipeRow(page, b, -120)
    expect(await rowShift(page, b), '过半停在打开').toBe(-216)
    for (const t of ['row-pin', 'row-rename', 'row-close']) await expect(item(b).getByTestId(t)).toBeVisible()
    await swipeRow(page, b, 120)
    expect(await rowShift(page, b), '右滑关上').toBe(0)
    await swipeRow(page, b, -60)
    expect(await rowShift(page, b), '不到一半弹回').toBe(0)
    // 纵向拖不打开任何一行（往上拖：往下拖到顶会是下滑关抽屉）
    const rb = (await page.getByTestId(`session-${b}`).boundingBox())!
    await touchDrag(page, { x: rb.x + rb.width / 2, y: rb.y + 30 }, { x: rb.x + rb.width / 2 - 6, y: rb.y - 80 })
    expect(await rowShift(page, a)).toBe(0)
    expect(await rowShift(page, b)).toBe(0)

    // 长按 = 打开，不出锚定菜单；再左滑另一行 → 前一行关上
    const box = (await page.getByTestId(`session-${a}`).boundingBox())!
    await longPress(page, box.x + box.width / 2, box.y + box.height / 2)
    expect(await rowShift(page, a), '长按也打开').toBe(-216)
    await expect(page.getByTestId('session-menu'), '抽屉里不再弹锚定菜单').toHaveCount(0)
    await swipeRow(page, b, -150)
    expect(await rowShift(page, b)).toBe(-216)
    expect(await rowShift(page, a), '同一时间只开一行').toBe(0)
    // 点开着那行的正文：只关上，不切换
    const cur = await hooks.sid(page)
    // 行被推开了 216px：点它还露在屏幕上的那一段（元素坐标 216 之后）
    await page.getByTestId(`session-${b}`).click({ position: { x: 216 + 40, y: 20 } })
    expect(await rowShift(page, b)).toBe(0)
    expect(await hooks.sid(page), '点正文只关不切').toBe(cur)
    await expect(page.getByTestId('session-drawer')).toBeVisible()

    // 保持接收
    await swipeRow(page, b, -150)
    await item(b).getByTestId('row-pin').click()
    await expect(page.getByTestId(`session-${b}`).locator('.pin-mark'), '名前出现 ⇵').toBeVisible()
    expect(await rowShift(page, b), '点完按钮行关上').toBe(0)

    // 改名：叠在抽屉上的小 sheet，输入框有焦点、全选、16px
    await swipeRow(page, b, -150)
    await item(b).getByTestId('row-rename').click()
    const sheet = page.getByTestId('rename-sheet')
    await expect(sheet).toBeVisible()
    await expect(page.locator('.drawer'), '叠在抽屉上').toHaveCount(2)
    const input = page.getByTestId('rename-input')
    await expect(input).toBeFocused()
    const sel = await input.evaluate((el: HTMLInputElement) => ({ s: el.selectionStart, e: el.selectionEnd, n: el.value.length, fs: getComputedStyle(el).fontSize }))
    expect(sel, '打开时全选').toMatchObject({ s: 0, e: sel.n })
    expect(sel.fs).toBe('16px')
    await input.fill('RENAMED')
    await input.press('Enter')
    await expect(sheet).toHaveCount(0)
    await expect(page.getByTestId('session-drawer'), '改名不关抽屉').toBeVisible()
    await expect(page.getByTestId(`session-${b}`).locator('.sl-text')).toHaveText('RENAMED')
    // 清空保存 → 恢复自动命名；Esc → 只关改名
    await swipeRow(page, b, -150)
    await item(b).getByTestId('row-rename').click()
    await input.fill('')
    await page.getByTestId('rename-ok').click()
    await expect(page.getByTestId(`session-${b}`).locator('.sl-text')).not.toHaveText('RENAMED')
    await swipeRow(page, b, -150)
    await item(b).getByTestId('row-rename').click()
    await expect(sheet).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
    await expect(page.getByTestId('session-drawer'), 'Esc 只关改名').toBeVisible()
  })

  test('E2E-28 ⑨ 浮层跟着可视区：可视区变矮，改名 sheet 贴着它的底边（ADR-0039 §3）', async ({ page }) => {
    await agent.open(page)
    const sid = (await hooks.sid(page))!
    await openDrawer(page)
    await swipeRow(page, sid, -150)
    await page.getByTestId(`session-${sid}`).locator('xpath=..').getByTestId('row-rename').click()
    await settled(page, 'rename-sheet')
    const v = await vp(page)
    // 模拟键盘压缩可视视口：视口变矮，.app 的高度跟着 visualViewport 变
    await page.setViewportSize({ width: v.w, height: v.h - 300 })
    await waitFor(async () => {
      const app = (await rectOf(page, '.app'))!
      return Math.abs(app.bottom - (v.h - 300)) <= 1
    }, '.app 跟着变矮')
    await page.waitForTimeout(300)
    const app = (await rectOf(page, '.app'))!
    const sheet = (await rectOf(page, '[data-testid=rename-sheet]'))!
    const input = (await rectOf(page, '[data-testid=rename-input]'))!
    expect(Math.abs(sheet.bottom - app.bottom), 'sheet 贴着可见区底边').toBeLessThanOrEqual(1)
    expect(input.top).toBeGreaterThanOrEqual(app.top)
    expect(input.bottom, '输入框整个在可见区里').toBeLessThanOrEqual(app.bottom)
    const drawer = (await rectOf(page, '[data-testid=session-drawer]'))!
    expect(drawer.bottom - drawer.top, '抽屉不超过可见区的 80%').toBeLessThanOrEqual((app.bottom - app.top) * 0.8 + 1)
  })

  test('E2E-28 ⑦ 会话抽屉至少半屏；底部一行四周留白（ADR-0037 §5）', async ({ page }) => {
    await agent.open(page)
    await openDrawer(page)
    const v = await vp(page)
    const d = (await rectOf(page, '[data-testid=session-drawer]'))!
    expect(d.bottom - d.top, '只有 1 个会话也至少半屏').toBeGreaterThanOrEqual(v.h / 2 - 1)
    const foot = (await rectOf(page, '[data-testid=session-drawer] .drawer-foot'))!
    expect(Math.abs(foot.bottom - d.bottom), '底部一行贴着 sheet 底部').toBeLessThanOrEqual(1)
    const n = (await rectOf(page, '[data-testid=session-drawer] [data-testid=new-session]'))!
    const s = (await rectOf(page, '[data-testid=session-drawer] [data-testid=open-settings]'))!
    expect(d.bottom - n.bottom, '按钮与 sheet 底边留白').toBeGreaterThanOrEqual(16 - 0.5)
    expect(Math.abs(n.left - d.left - 16), '左边 16px').toBeLessThanOrEqual(1)
    expect(Math.abs(d.right - s.right - 16), '右边 16px').toBeLessThanOrEqual(1)
    expect(Math.abs(s.left - n.right - 12), '按钮之间 12px').toBeLessThanOrEqual(1)
    expect(Math.round(n.bottom - n.top)).toBe(48)
    expect(Math.round(s.bottom - s.top)).toBe(48)
    expect(Math.round(s.right - s.left), '设置是方块').toBe(48)
  })

  test('E2E-28 ⑧ 从抽屉进设置：抽屉关、设置是贴底 sheet，不套半屏最小高度，底部留白', async ({ page }) => {
    await agent.open(page)
    await openDrawer(page)
    await page.getByTestId('session-drawer').getByTestId('open-settings').click()
    await expect(page.getByTestId('session-drawer')).toHaveCount(0)
    await settled(page, 'settings')
    const v = await vp(page)
    const r = (await rectOf(page, '[data-testid=settings]'))!
    expect(Math.abs(r.bottom - v.h), '贴底').toBeLessThanOrEqual(1)
    expect(r.right - r.left, '整宽').toBeGreaterThanOrEqual(v.w)
    await expect(page.getByTestId('settings').locator('.drawer-grab')).toBeVisible()
    expect(r.bottom - r.top, '两行设置，不撑到半屏').toBeLessThan(v.h / 2)
    const inc = (await rectOf(page, '[data-testid=font-inc]'))!
    expect(r.bottom - inc.bottom, '底部留白').toBeGreaterThanOrEqual(16)
    await page.mouse.click(v.w / 2, 40) // 点遮罩
    await expect(page.getByTestId('settings')).toHaveCount(0)
  })
})
