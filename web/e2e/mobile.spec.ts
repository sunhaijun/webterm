/**
 * E2E-10 手机布局与附加键 —— AC-3.18 / AC-3.20（另含安全区与横屏的几何，layout.md §安全区）。
 *
 * Pixel 5（触屏）。hook `WebSocket.send` 记 INPUT 帧，断言的是线上的字节。
 * 【断言尺寸，不只断言存在】：元素在、类名对、文本对，都不代表用户看得见东西。
 */
import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, EMIT, focusTerm, hooks, recordSent, rectOf, submit, waitFor, waitText, type SentRecorder } from './harness'

const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
test.use(PIXEL)

const KEY_IDS = [
  'Escape',
  'Slash',
  'Minus',
  'Home',
  'ArrowUp',
  'End',
  'PageUp',
  'Tab',
  'Ctrl',
  'Alt',
  'ArrowLeft',
  'ArrowDown',
  'ArrowRight',
  'PageDown',
]

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

/** 键区里键的 testid 序列（DOM 顺序）。 */
const keyOrder = (p: Page) =>
  p.evaluate(() => [...document.querySelectorAll('[data-testid=extrakeys] .ek-key')].map((e) => (e as HTMLElement).dataset.testid))

/** 14 个键全在视口内、键区不横向滚动。 */
async function allKeysVisible(page: Page) {
  const g = await page.evaluate(() => {
    const keys = document.querySelector('.ek-keys') as HTMLElement
    const vw = window.innerWidth
    const vh = window.innerHeight
    const out = [...keys.querySelectorAll('.ek-key')].map((e) => {
      const r = e.getBoundingClientRect()
      return {
        id: (e as HTMLElement).dataset.testid,
        ok: r.left >= 0 && r.right <= vw + 0.5 && r.top >= 0 && r.bottom <= vh + 0.5 && r.width > 0,
        r: `${r.left},${r.top},${r.right},${r.bottom} / ${vw}x${vh}`,
      }
    })
    return { scrollW: keys.scrollWidth, clientW: keys.clientWidth, out }
  })
  expect(g.scrollW, '键区不横向滚动').toBeLessThanOrEqual(g.clientW + 1)
  expect(g.out.length).toBe(14)
  for (const k of g.out) expect(k.ok, `${k.id} 应当完整落在视口内（${k.r}）`).toBe(true)
}

/** 按一下附加键（触屏点按）并返回这一下发出的 INPUT 帧（十六进制，拼起来）。 */
async function press(page: Page, rec: SentRecorder, id: string): Promise<string> {
  const before = (await rec.inputHex()).length
  const n0 = (await hooks.inputStats(page)).data.n
  await page.getByTestId(`key-${id}`).tap()
  await waitFor(async () => (await rec.inputHex()).length > before, `key-${id} 发出了字节`, 5_000)
  await page.waitForTimeout(50)
  expect((await hooks.inputStats(page)).data.n, `key-${id} 走 onData 出口（inputStats.data 涨）`).toBeGreaterThan(n0)
  return (await rec.inputHex()).slice(before).join('')
}

const active = (p: Page) => p.evaluate(() => (document.activeElement as HTMLElement | null)?.className ?? '')

/** CDP 发一次真实的触摸序列（start → move* → end）。 */
async function touch(page: Page, points: { x: number; y: number }[], holdMs = 0) {
  const cdp = await page.context().newCDPSession(page)
  const [first, ...rest] = points
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first!] })
  for (const p of rest) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] })
  if (holdMs) await page.waitForTimeout(holdMs)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

test('E2E-10 ①② 结构：compact、无标签栏、附加键 80px 在终端下方、14 键全可见不横滑', async ({ page }) => {
  await agent.open(page)

  await expect(page.locator('.app')).toHaveAttribute('data-form', 'compact')
  await expect(page.getByTestId('tabbar')).toHaveCount(0)

  const term = (await rectOf(page, '[data-testid=terminal]'))!
  const keys = (await rectOf(page, '[data-testid=extrakeys]'))!
  expect(keys.height, '附加键区高 80px').toBe(80)
  expect(keys.top, '附加键在终端下方').toBeGreaterThanOrEqual(term.bottom - 1)
  expect(term.height, '终端拿到了剩余的高度').toBeGreaterThan(400)

  // 左列：☰ 在上、✎ 在下
  const side = await page.evaluate(() => [...document.querySelectorAll('.ek-side > *')].map((e) => (e as HTMLElement).dataset.testid))
  expect(side).toEqual(['open-sessions', 'toggle-text'])
  const sessions = (await rectOf(page, '[data-testid=open-sessions]'))!
  const toggle = (await rectOf(page, '[data-testid=toggle-text]'))!
  expect(sessions.top).toBeLessThan(toggle.top)
  expect(sessions.right, '左列在键区左边').toBeLessThanOrEqual((await rectOf(page, '[data-testid=key-Escape]'))!.left + 1)

  expect(await keyOrder(page)).toEqual(KEY_IDS.map((k) => `key-${k}`))
  await allKeysVisible(page)

  // 页面不滚
  const doc = await page.evaluate(() => ({ h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth, vh: innerHeight, vw: innerWidth }))
  expect(doc.h).toBeLessThanOrEqual(doc.vh + 1)
  expect(doc.w).toBeLessThanOrEqual(doc.vw + 1)
})

test('E2E-10 ③ 静态：命令在跑、less 占屏、退出 less 之后键位都不变', async ({ page }) => {
  await agent.open(page)
  const want = KEY_IDS.map((k) => `key-${k}`)

  await submit(page, 'sleep 30')
  await page.waitForTimeout(500)
  expect(await keyOrder(page), 'sleep 在跑').toEqual(want)
  await page.keyboard.press('Control+c')

  await submit(page, 'seq 1 500 | less')
  await waitFor(async () => hooks.altScreen(page), 'less 占屏（备用屏）')
  expect(await keyOrder(page), 'less 占屏').toEqual(want)

  await page.keyboard.press('q')
  await waitFor(async () => !(await hooks.altScreen(page)), '退出 less')
  expect(await keyOrder(page), '退出 less 之后').toEqual(want)
})

test('E2E-10 ④⑤ 字节：ESC / ↑ / DECCKM 下的 ↑ 与 HOME；按键不抢焦点', async ({ page }) => {
  const rec = await recordSent(page)
  await agent.open(page)

  // ⑤ 不抢焦点：先让终端有焦点，按 TAB 之后焦点还在原处
  await focusTerm(page)
  const before = await active(page)
  expect(before).toContain('xterm-helper-textarea')
  expect(await press(page, rec, 'Tab')).toBe('09')
  expect(await active(page), '按附加键不该改变焦点').toBe(before)
  await page.keyboard.press('Control+c') // 清掉 Tab 补全可能留下的东西

  // ④ 字节
  expect(await press(page, rec, 'Escape')).toBe('1b')
  expect(await press(page, rec, 'ArrowUp')).toBe('1b5b41')

  // DECCKM 打开：方向键与 HOME 跟着变（按键时现读，不缓存）
  await page.keyboard.press('Control+c')
  await submit(page, "printf '\\033[?1h'; printf 'CKM-%s\\n' ON")
  await waitText(page, /^CKM-ON/m)
  expect(await press(page, rec, 'ArrowUp'), 'DECCKM 下 ↑ = ESC O A').toBe('1b4f41')
  expect(await press(page, rec, 'Home'), 'DECCKM 下 HOME = ESC O H').toBe('1b4f48')

  await page.keyboard.press('Control+c')
  await submit(page, "printf '\\033[?1l'; printf 'CKM-%s\\n' OFF")
  await waitText(page, /^CKM-OFF/m)
  expect(await press(page, rec, 'ArrowUp'), '复原之后 ↑ = ESC [ A').toBe('1b5b41')
  expect(await press(page, rec, 'Home'), '复原之后 HOME = ESC [ H').toBe('1b5b48')
})

test('E2E-10 ⑥⑦ 粘滞 CTRL：点一下只管下一个键（含软键盘），长按锁定，再点解锁', async ({ page }) => {
  const rec = await recordSent(page)
  await agent.open(page)
  await focusTerm(page)
  const ctrl = page.getByTestId('key-Ctrl')

  // ⑥ 点一下 → armed；软键盘打 c → 0x03，自动取消
  await ctrl.tap()
  await expect(ctrl).toHaveAttribute('data-sticky', 'armed')
  let n = (await rec.inputHex()).length
  await page.keyboard.type('c')
  await waitFor(async () => (await rec.inputHex()).length > n, '发出了字节')
  expect((await rec.inputHex()).slice(n).join('')).toBe('03')
  await expect(ctrl).toHaveAttribute('data-sticky', 'off')

  // 点 CTRL 再点 ← → ESC[1;5D
  await ctrl.tap()
  await expect(ctrl).toHaveAttribute('data-sticky', 'armed')
  expect(await press(page, rec, 'ArrowLeft')).toBe('1b5b313b3544')
  await expect(ctrl).toHaveAttribute('data-sticky', 'off')

  // ⑦ 长按（> 500ms）→ locked；连续 c u → 03 15（不用 d：空提示符下 ^D 会让 bash 退出）
  const box = (await ctrl.boundingBox())!
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await touch(page, [at], 700)
  await expect(ctrl).toHaveAttribute('data-sticky', 'locked')
  n = (await rec.inputHex()).length
  await page.keyboard.type('c')
  await page.keyboard.type('u')
  await waitFor(async () => (await rec.inputHex()).length >= n + 2, '两下都发出了')
  expect((await rec.inputHex()).slice(n)).toEqual(['03', '15'])
  await expect(ctrl, '锁定态连续生效').toHaveAttribute('data-sticky', 'locked')

  await ctrl.tap()
  await expect(ctrl).toHaveAttribute('data-sticky', 'off')
})

test('E2E-10 ⑧ 点按终端：点一下聚焦、再点失焦、拖动不算点；开了鼠标跟踪就交给程序', async ({ page }) => {
  const rec = await recordSent(page)
  await agent.open(page)
  const t = (await rectOf(page, '[data-testid=terminal]'))!
  const mid = { x: t.left + t.width / 2, y: t.top + t.height / 2 }

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  expect(await active(page)).not.toContain('xterm-helper-textarea')

  await touch(page, [mid])
  await expect.poll(() => active(page), { message: '点一下 → 焦点进 xterm 的 helper textarea' }).toContain('xterm-helper-textarea')
  await touch(page, [mid])
  await expect.poll(() => active(page), { message: '再点一下 → 焦点离开' }).not.toContain('xterm-helper-textarea')

  // 纵向拖 30px 是滚动，不改焦点
  const off = await active(page)
  await touch(page, [mid, { x: mid.x, y: mid.y + 10 }, { x: mid.x, y: mid.y + 20 }, { x: mid.x, y: mid.y + 30 }])
  await page.waitForTimeout(200)
  expect(await active(page), '拖动不算点').toBe(off)

  // 开鼠标跟踪：点一下交给 xterm 上报，焦点不变
  await focusTerm(page)
  await submit(page, "printf '\\033[?1000h'; printf 'MOUSE-%s\\n' ON")
  await waitText(page, /^MOUSE-ON/m)
  const focusedBefore = await active(page)
  const n = (await rec.inputHex()).length
  await touch(page, [mid])
  await waitFor(async () => (await rec.inputHex()).slice(n).some((h) => h.startsWith('1b5b4d')), 'INPUT 帧里出现鼠标上报（ESC [ M）', 5_000)
  expect(await active(page), '鼠标跟踪下点终端不切换焦点').toBe(focusedBefore)

  // 复原：先把上报留在命令行上的字节清掉
  await page.keyboard.press('Control+c')
  await submit(page, "printf '\\033[?1000l'")
})

test('E2E-10 ⑧ 续：纵向拖是 xterm 自带的触摸滚动 —— 拖多远滚多远，不只滚第一帧', async ({ page }) => {
  await agent.open(page)
  await submit(page, `${EMIT} 300 0`)
  await waitText(page, 'EMIT-DONE')
  const t = (await rectOf(page, '[data-testid=terminal]'))!
  const x = t.left + t.width / 2
  const y0 = t.top + 60
  const before = (await hooks.viewport(page)).y
  // 手指往下拖 160px（20 帧，每帧 8px）：内容往回滚。DOM 渲染器滚动时会换掉手指下面那一行的元素 ——
  // touch 的 target 一脱离文档，后面的 touchmove 就到不了 xterm（修复前只滚第一帧）
  const pts = Array.from({ length: 21 }, (_, i) => ({ x, y: y0 + i * 8 }))
  await touch(page, pts)
  await page.waitForTimeout(300)
  const rowH = t.height / (await hooks.size(page)).rows
  const moved = before - (await hooks.viewport(page)).y
  expect(moved, `拖 160px（约 ${Math.round(160 / rowH)} 行）只滚了 ${moved} 行`).toBeGreaterThanOrEqual(Math.floor(160 / rowH) - 2)
})

test('E2E-10 ⑨ 安全区：--sa-top / --sa-bottom 落在 .app 上，终端正好矮 81px，页面不溢出', async ({ page }) => {
  await agent.open(page)
  const geo = () =>
    page.evaluate(() => {
      const r = (s: string) => (document.querySelector(s) as HTMLElement).getBoundingClientRect()
      const app = r('.app')
      const term = r('.term')
      const keys = r('[data-testid=extrakeys]')
      return {
        appH: Math.round(app.height),
        appBottom: Math.round(app.bottom),
        termTop: Math.round(term.top),
        termH: Math.round(term.height),
        keysBottom: Math.round(keys.bottom),
        scrollH: document.documentElement.scrollHeight,
        vh: innerHeight,
      }
    })
  const base = await geo()

  await page.evaluate(() => {
    const app = document.querySelector('.app') as HTMLElement
    app.style.setProperty('--sa-top', '47px')
    app.style.setProperty('--sa-bottom', '34px')
  })
  await expect.poll(async () => (await geo()).termTop).toBe(47)
  const inset = await geo()
  expect(inset.appH, '.app 高度不变').toBe(base.appH)
  expect(inset.appBottom - inset.keysBottom, '附加键底边离 .app 底边 34px').toBe(34)
  expect(base.termH - inset.termH, '终端正好矮 47 + 34').toBe(81)
  expect(inset.scrollH, '页面不溢出').toBeLessThanOrEqual(inset.vh + 1)

  await page.evaluate(() => (document.querySelector('.app') as HTMLElement).style.removeProperty('--sa-bottom'))
  await expect.poll(async () => (await geo()).keysBottom).toBe(base.keysBottom)
  expect((await geo()).termH, '清掉 --sa-bottom：只剩顶部 47px').toBe(base.termH - 47)
})

test('E2E-10 ⑩ 横屏（viewport 与 screen 都是 851×393）：仍是 compact，附加键 80px、14 键全可见', async ({ browser }) => {
  const ctx = await browser.newContext({ ...PIXEL, viewport: { width: 851, height: 393 }, screen: { width: 851, height: 393 } })
  const page = await ctx.newPage()
  await agent.open(page)
  await expect(page.locator('.app')).toHaveAttribute('data-form', 'compact')
  expect((await rectOf(page, '[data-testid=extrakeys]'))!.height).toBe(80)
  await allKeysVisible(page)
  await ctx.close()
})
