import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, submit, waitFor } from './harness'

/**
 * 软键盘几何（E2E-21）—— layout-responsive.md §高度计算。
 *
 * 键盘一弹，输入控件必须还在可视区里。两种浏览器模型都得对：
 *  - 布局视口一起缩（老 Android Chrome 的 resizes-content）：真的把 Playwright 视口缩小；
 *  - 只缩可视视口、浏览器把可视区上推露出输入框（iOS Safari、Chrome ≥108 的 resizes-visual）：
 *    用假 visualViewport 精确重放，其中 Safari 语义下 window.innerHeight 也跟着变矮 ——
 *    这正是曾让闸门永远关着、把整个 .app 推出可视区的坑。
 */
const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
test.use({ ...PIXEL, launchOptions: { args: ['--disable-webgl'] } })
test.setTimeout(90_000)

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

interface Rect { top: number; bottom: number }
const geo = (p: Page) =>
  p.evaluate(() => {
    const app = document.querySelector('.app') as HTMLElement
    const r = app.getBoundingClientRect()
    const q = (sel: string): Rect | null => {
      const e = document.querySelector(sel) as HTMLElement | null
      if (!e || e.hidden) return null
      const b = e.getBoundingClientRect()
      return { top: Math.round(b.top), bottom: Math.round(b.bottom) }
    }
    return {
      appH: app.style.height,
      appTf: app.style.transform,
      app: { top: Math.round(r.top), bottom: Math.round(r.bottom) },
      composer: q('[data-testid=composer]'),
      keybar: q('[data-testid=keybar]'),
      active: document.activeElement?.className ?? '',
    }
  })
const settle = (p: Page) =>
  p.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 200)))))
const within = (r: Rect | null, top: number, bottom: number) => !!r && r.top >= top && r.bottom <= bottom

/** 假 visualViewport：可控高度 / offsetTop；innerTracks=true 模拟 Safari（innerHeight = 可视视口高度）。 */
const installFakeViewport = (p: Page) =>
  p.addInitScript(() => {
    const realInner = Object.getOwnPropertyDescriptor(Window.prototype, 'innerHeight')
    const fake = new EventTarget() as EventTarget & Record<string, unknown>
    let h = 727
    let top = 0
    let inner: number | null = null
    const def = (k: string, get: () => number) => Object.defineProperty(fake, k, { get })
    def('height', () => h)
    def('offsetTop', () => top)
    def('pageTop', () => top)
    def('width', () => 393)
    def('offsetLeft', () => 0)
    def('pageLeft', () => 0)
    def('scale', () => 1)
    Object.defineProperty(window, 'visualViewport', { get: () => fake, configurable: true })
    Object.defineProperty(window, 'innerHeight', {
      get: () => inner ?? (realInner?.get ? (realInner.get.call(window) as number) : 727),
      configurable: true,
    })
    ;(window as unknown as { __vv(h: number, top: number, inner: number | null): void }).__vv = (nh, ntop, ninner) => {
      h = nh
      top = ntop
      inner = ninner
      fake.dispatchEvent(new Event('resize'))
      fake.dispatchEvent(new Event('scroll'))
      window.dispatchEvent(new Event('resize'))
    }
  })
const setViewport = (p: Page, h: number, top: number, inner: number | null) =>
  p.evaluate(([h, top, inner]) => (window as unknown as { __vv(h: number, top: number, inner: number | null): void }).__vv(h, top, inner), [h, top, inner] as const)

test('布局视口一起缩（resizes-content）：读视图 Composer 仍在可视区', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await settle(page)
  await page.getByTestId('to-edit').click()
  await page.setViewportSize({ width: 393, height: 450 }) // 键盘占掉 277px
  await settle(page)
  const g = await geo(page)
  expect(g.appH).toBe('450px')
  expect(g.appTf, '布局视口一起缩时没有上推，不该有 translateY').toBe('')
  expect(within(g.composer, 0, 450), `Composer ${JSON.stringify(g.composer)} 应在 [0,450]`).toBe(true)
})

test('占屏程序「⌨ 打字」后键条仍在可视区', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await submit(page, "printf '\\033[>1u'; sleep 60")
  await waitFor(async () => (await page.evaluate(() => (window as unknown as { __webterm: { interactive(): boolean } }).__webterm.interactive())) === true, '占屏', 10_000)
  await settle(page)
  await page.locator('.xterm-screen').click()
  await page.setViewportSize({ width: 393, height: 450 })
  await settle(page)
  const g = await geo(page)
  expect(g.active).toContain('xterm')
  expect(within(g.keybar, 0, 450), `键条 ${JSON.stringify(g.keybar)} 应在 [0,450]`).toBe(true)
})

for (const innerTracks of [true, false]) {
  test(`只缩可视视口 + 上推（${innerTracks ? 'Safari：innerHeight 跟着变矮' : 'Chrome：innerHeight 恒定'}）：.app 对齐可视区，Composer 可见`, async ({ page }) => {
    await installFakeViewport(page)
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')
    await settle(page)
    await page.getByTestId('to-edit').click()
    // 键盘弹起：可视 727→400；浏览器把可视区上推 327px 露出底部输入框
    await setViewport(page, 400, 327, innerTracks ? 400 : null)
    await settle(page)
    const g = await geo(page)
    expect(g.appH).toBe('400px')
    expect(g.appTf, '必须用 translateY 把 .app 对齐到被上推的可视区').toBe('translateY(327px)')
    expect(g.app.top).toBe(327)
    expect(within(g.composer, 327, 727), `Composer ${JSON.stringify(g.composer)} 应在可视区 [327,727]`).toBe(true)
    // 键盘收起：全部复位
    await setViewport(page, 727, 0, innerTracks ? 727 : null)
    await settle(page)
    const g2 = await geo(page)
    expect(g2.appH).toBe('727px')
    expect(g2.appTf).toBe('')
  })
}

test('普通回弹（offsetTop 变、高度不变）不补偿 —— 防拖动抖动环', async ({ page }) => {
  await installFakeViewport(page)
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await settle(page)
  await setViewport(page, 727, -40, null) // 顶部回弹
  await settle(page)
  expect((await geo(page)).appTf).toBe('')
  await setViewport(page, 727, 60, null) // 拖动中的 offsetTop 漂移
  await settle(page)
  expect((await geo(page)).appTf).toBe('')
})
