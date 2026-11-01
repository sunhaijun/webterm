/**
 * E2E-41 宽屏标签栏 —— AC-4.10 / AC-4.11 / AC-5.11（另含 AC-4.8 的「切换不改几何」）；
 * `+` 的位置见 ADR-0035，⚙ 与设置浮窗见 ADR-0037，关闭确认见 ADR-0038。
 *
 * 1440×900 鼠标；第 7 步用 iPad Mini 设备描述（触屏 wide）。
 */
import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, EMIT, focusTerm, framesSince, hooks, newSession, rectOf, submit, switchTo, waitFor, waitText } from './harness'

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
/** `+` 的左边缘到标签条右边缘的间隔（ADR-0035 §2）。 */
const plusGap = async (p: Page) => {
  const strip = (await p.getByTestId('tabbar').boundingBox())!
  const plus = (await p.getByTestId('new-session').boundingBox())!
  return plus.x - (strip.x + strip.width)
}

test.describe('1440×900 鼠标', () => {
  test.use(WIDE)

  test('E2E-41 ①② 结构；新建与切换不改终端几何', async ({ page }) => {
    await agent.open(page)
    const a = (await hooks.sid(page))!

    // ① 顶栏在终端上方；标签条里一个标签；`+` 在标签条外；右侧钉住状态点与 ⚙（⚙ 在最右）；没有会话按钮、没有附加键
    await expect(page.locator('.app')).toHaveAttribute('data-form', 'wide')
    const bar = (await rectOf(page, '.topbar'))!
    const term = (await rectOf(page, '[data-testid=terminal]'))!
    expect(bar.bottom).toBeLessThanOrEqual(term.top + 1)
    expect(bar.height, '标签栏 36px（鼠标）').toBe(36)
    const tabbar = page.getByTestId('tabbar')
    await expect(tabbar.locator('.tab')).toHaveCount(1)
    await expect(tabbar.getByTestId('new-session'), '`+` 不在滚动的标签条里（ADR-0035）').toHaveCount(0)
    await expect(page.locator('.topbar').getByTestId('new-session')).toBeVisible()
    expect(Math.abs((await plusGap(page)) - 12), '`+` 前留 12px').toBeLessThanOrEqual(0.5)
    await expect(tabbar.getByTestId('conn-dot'), '状态点不在可滚动的标签条里').toHaveCount(0)
    await expect(page.locator('.topbar').getByTestId('conn-dot')).toHaveAttribute('data-state', 'online')
    await expect(tabbar.getByTestId('open-settings'), '⚙ 不在标签条里').toHaveCount(0)
    const dot = (await rectOf(page, '[data-testid=conn-dot]'))!
    const gear = (await rectOf(page, '[data-testid=open-settings]'))!
    const strip = (await rectOf(page, '[data-testid=tabbar]'))!
    expect(dot.left, '状态点在标签条右边').toBeGreaterThanOrEqual(strip.right - 1)
    expect(Math.abs(bar.right - gear.right), '⚙ 在最右').toBeLessThanOrEqual(1)
    expect(gear.left - dot.right, '状态点紧挨在 ⚙ 左边（只隔外边距）').toBeLessThanOrEqual(6)
    expect(gear.left).toBeGreaterThanOrEqual(dot.right)
    // `+` 与 ⚙ 是同一套线条图标、按几何中心居中：和状态点在同一条水平线上（ADR-0035 §3、ADR-0037 §3）
    const mid = await page.evaluate(() => {
      const r = (s: string) => document.querySelector(s)!.getBoundingClientRect()
      const c = (s: string) => r(s).top + r(s).height / 2
      return {
        plus: c('[data-testid=new-session] svg'),
        gear: c('[data-testid=open-settings] svg'),
        dot: c('[data-testid=conn-dot]'),
        plusW: r('[data-testid=new-session] svg').width,
        gearW: r('[data-testid=open-settings] svg').width,
      }
    })
    const m = JSON.stringify(mid)
    expect(Math.abs(mid.plus - mid.dot), `\`+\` 与状态点垂直对齐：${m}`).toBeLessThanOrEqual(0.5)
    expect(Math.abs(mid.gear - mid.dot), `⚙ 与状态点垂直对齐：${m}`).toBeLessThanOrEqual(0.5)
    expect(mid.gearW, `两个图标一样大：${m}`).toBe(mid.plusW)
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

  test('E2E-41 ③ 关闭：悬停出 ✕、在跑先弹自己的确认浮窗；中键同样；Ctrl+Shift+W 再 Enter', async ({ page }) => {
    await agent.open(page)
    const a = (await hooks.sid(page))!
    const b = await newSession(page)
    const c = await newSession(page)

    // 非当前标签：平时 ✕ 隐藏，悬停才出现
    expect(await closeVisible(page, a)).toBe(false)
    await page.getByTestId(`tab-${a}`).hover()
    expect(await closeVisible(page, a), '悬停出 ✕').toBe(true)

    let dialogs = 0
    page.on('dialog', (d) => {
      dialogs++
      void d.dismiss()
    })
    const confirm = page.getByTestId('close-confirm')
    await page.getByTestId(`tab-${a}-close`).click()
    await expect(confirm, '会话在跑：先弹确认（自己的浮层，ADR-0038）').toBeVisible()
    // wide：居中浮窗，没有抓手
    const r = (await rectOf(page, '[data-testid=close-confirm]'))!
    expect(Math.abs((r.left + r.right) / 2 - 720), '水平居中').toBeLessThanOrEqual(1)
    expect(Math.abs((r.top + r.bottom) / 2 - 450), '垂直居中').toBeLessThanOrEqual(1)
    await expect(confirm.locator('.drawer-grab')).toBeHidden()
    await expect(page.getByTestId(`tab-${a}`), '确认之前不关').toBeVisible()
    await page.getByTestId('close-ok').click()
    await expect(confirm).toHaveCount(0)
    await expect(page.getByTestId(`tab-${a}`)).toHaveCount(0)
    expect(await hooks.sid(page), '关的不是当前标签，当前不变').toBe(c)

    // 中键点标签 = 关闭，同样先确认；取消就不关
    await page.getByTestId(`tab-${b}`).click({ button: 'middle' })
    await expect(confirm).toBeVisible()
    await page.getByTestId('close-cancel').click()
    await expect(confirm).toHaveCount(0)
    await expect(page.getByTestId(`tab-${b}`), '取消了就不关').toBeVisible()
    await page.getByTestId(`tab-${b}`).click({ button: 'middle' })
    await page.getByTestId('close-ok').click()
    await expect(page.getByTestId(`tab-${b}`)).toHaveCount(0)

    // 键盘：焦点在终端里 Ctrl+Shift+W → 确认（焦点在「关闭」上）→ Enter 关掉；焦点回到新当前会话的终端
    const d = await newSession(page)
    await focusTerm(page)
    await page.keyboard.press('Control+Shift+W')
    await expect(confirm).toBeVisible()
    await expect(page.getByTestId('close-ok'), '打开时焦点在「关闭」上').toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId(`tab-${d}`)).toHaveCount(0)
    await waitFor(async () => (await hooks.sid(page)) === c, '切到相邻会话')
    await expect(page.locator('.xterm-helper-textarea'), '焦点回到新当前会话的终端').toBeFocused()
    expect(dialogs, '不用浏览器对话框').toBe(0)
  })

  test('E2E-41 ④ 改名：双击 → 输入框 → 回车；清空回车恢复自动命名；改名前后都带编号', async ({ page }) => {
    await agent.open(page)
    const sid = (await hooks.sid(page))!
    const auto = (await tabName(page, sid))!
    expect(auto, '自动命名 = CWD 的 basename（家目录是 ~）').toBe('~')
    const idx = page.getByTestId(`tab-${sid}-idx`)
    await expect(idx, '标签带编号（ADR-0041）').toHaveText('[1]')

    await page.getByTestId(`tab-${sid}`).dblclick()
    const input = page.getByTestId('rename-input')
    await expect(input).toBeFocused()
    await input.fill('RENAMED')
    await input.press('Enter')
    await expect.poll(() => tabName(page, sid)).toBe('RENAMED')
    await expect(idx, '改过名的也带编号，同抽屉').toHaveText('[1]')

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

  test('E2E-41 ⑧ 等宽与滚动：等分 240px 封顶；窄窗口里停在 120px、横向滚动、滚轮横着滚；放宽恢复', async ({ page }) => {
    await agent.open(page)
    await newSession(page)
    await newSession(page)
    const tabs = page.locator('.tabbar .tab')
    await expect(tabs).toHaveCount(3)
    const widths = () => tabs.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width))
    const strip = page.getByTestId('tabbar')
    const scroll = () => strip.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, left: el.scrollLeft }))

    // 3 个：等宽，都封顶 240px；标签条正好是三个标签宽；`+` 跟在最后一个后面、隔 12px；不滚动
    for (const w of await widths()) expect(Math.abs(w - 240), `标签宽 ${w}`).toBeLessThanOrEqual(1)
    const last = (await tabs.last().boundingBox())!
    const plus = (await page.getByTestId('new-session').boundingBox())!
    expect(Math.abs(plus.x - (last.x + last.width) - 12), '`+` 跟在最后一个标签后面，隔 12px').toBeLessThanOrEqual(1)
    let s = await scroll()
    expect(s.sw, '放得下时不滚动').toBe(s.cw)
    expect(Math.abs(s.cw - 720), `标签条正好三个标签宽：${s.cw}`).toBeLessThanOrEqual(1)

    // 窗口改窄、建到 5 个：每个停在 120px，标签条放不下，当前（最后建的）整个可见
    await page.setViewportSize({ width: 600, height: 900 })
    await newSession(page)
    const cur = await newSession(page)
    await expect(tabs).toHaveCount(5)
    for (const w of await widths()) expect(Math.abs(w - 120), `标签宽 ${w}`).toBeLessThanOrEqual(1)
    s = await scroll()
    expect(s.sw, '放不下').toBeGreaterThan(s.cw)
    const box = (await strip.boundingBox())!
    const curBox = (await page.getByTestId(`tab-${cur}`).boundingBox())!
    expect(curBox.x >= box.x - 1 && curBox.x + curBox.width <= box.x + box.width + 1, '当前标签整个可见').toBe(true)
    expect(s.left, '当前在最后，标签条已经滚到右边').toBeGreaterThan(0)

    // 放不下时 `+` 不跟着滚：整个在顶栏里、点得到，离标签条 12px；标签条滚到最左它也不动（ADR-0035）
    const pinned = (await page.getByTestId('new-session').boundingBox())!
    expect(pinned.x + pinned.width, '`+` 整个在 600px 宽的顶栏里').toBeLessThanOrEqual(600)
    expect(Math.abs((await plusGap(page)) - 12), '放不下时仍隔 12px').toBeLessThanOrEqual(0.5)
    const hit = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid=new-session]') !== null,
      { x: pinned.x + pinned.width / 2, y: pinned.y + pinned.height / 2 },
    )
    expect(hit, '`+` 的中心点得到它自己').toBe(true)
    await strip.evaluate((el) => (el.scrollLeft = 0))
    await expect.poll(async () => (await scroll()).left).toBe(0)
    expect(await page.getByTestId('new-session').boundingBox(), '标签条滚动，`+` 不动').toEqual(pinned)

    // 鼠标滚轮纵向滚 = 横着滚标签条
    await page.mouse.move(box.x + 60, box.y + box.height / 2)
    await page.mouse.wheel(0, 200)
    await expect.poll(async () => (await scroll()).left, { message: '滚轮向下 → 往右滚' }).toBeGreaterThan(0)
    const before = (await scroll()).left
    await page.mouse.wheel(0, -200)
    await expect.poll(async () => (await scroll()).left, { message: '滚轮向上 → 往左滚' }).toBeLessThan(before)

    // 放宽：5 个都回到 240px，不再滚动
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect.poll(async () => (await widths()).every((w) => Math.abs(w - 240) <= 1)).toBe(true)
    s = await scroll()
    expect(s.sw, '放宽后不滚动').toBe(s.cw)
  })

  test('E2E-41 ⑨ `+` 前的间隔点上去什么都不做，也不抢终端的焦点', async ({ page }) => {
    await agent.open(page)
    await newSession(page)
    const cur = (await hooks.sid(page))!
    const tabs = page.locator('.tabbar .tab')
    await expect(tabs).toHaveCount(2)
    await page.locator('.xterm-helper-textarea').focus()

    const last = (await tabs.last().boundingBox())!
    const plus = (await page.getByTestId('new-session').boundingBox())!
    const gap = { x: (last.x + last.width + plus.x) / 2, y: plus.y + plus.height / 2 }
    expect(plus.x - (last.x + last.width), '间隔有 12px').toBeGreaterThanOrEqual(11)
    await page.mouse.click(gap.x, gap.y)
    await page.waitForTimeout(400)
    await expect(tabs, '没有新建').toHaveCount(2)
    expect(await hooks.sid(page), '当前会话不变').toBe(cur)
    expect(
      await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false),
      '焦点还在终端里',
    ).toBe(true)
  })

  test('E2E-41 ⑩ 设置是居中浮窗：不改终端几何，Esc 关掉后焦点回终端（ADR-0037 §4）', async ({ page }) => {
    await agent.open(page)
    await focusTerm(page)
    await page.waitForTimeout(300)
    const g0 = await geo(page)
    await page.getByTestId('open-settings').click()
    const st = page.getByTestId('settings')
    await expect(st).toBeVisible()
    const r = (await rectOf(page, '[data-testid=settings]'))!
    expect(Math.abs((r.left + r.right) / 2 - 720), '水平居中').toBeLessThanOrEqual(1)
    expect(Math.abs((r.top + r.bottom) / 2 - 450), '垂直居中').toBeLessThanOrEqual(1)
    expect(r.right - r.left, '宽 420px').toBe(420)
    await expect(st.locator('.drawer-grab'), '居中浮窗没有抓手').toBeHidden()
    expect(await geo(page), '开设置不改终端几何').toEqual(g0)
    await page.keyboard.press('Escape')
    await expect(st).toHaveCount(0)
    await expect(page.locator('.xterm-helper-textarea'), '关掉后焦点回到终端').toBeFocused()
    await page.keyboard.type('echo SETTINGS-BACK')
    await waitText(page, 'echo SETTINGS-BACK', '打字有回显')
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
    expect(Math.abs((await plusGap(page)) - 16), '触屏上 `+` 前留 16px').toBeLessThanOrEqual(0.5)

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
