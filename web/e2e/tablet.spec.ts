import { expect, test, type Browser, type Page } from '@playwright/test'

import { Agent } from './harness'

/**
 * iPad mini（E2E-25 第 5–6 条，ADR-0015 ⑥⑦⑧）：宽度决定栅格，触摸决定输入层。
 *
 * 横屏 1133×744 落进 desktop 断点 —— 之前触屏在这里拿到的是给鼠标键盘设计的经典底栏
 * （模式条 + 常驻输入框 + 键条），键盘一弹终端只剩 14 行。现在：侧栏照样常驻，底栏是键行。
 * 竖屏 744×1133 是 tablet：⋯ 不再是整宽 258px 的底部表单，半屏不再吃掉 521px。
 */
const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const ipad = (width: number, height: number) => ({ viewport: { width, height }, hasTouch: true, isMobile: true, userAgent: IPAD_UA })

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

const rect = (p: Page, sel: string) =>
  p.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) }
  }, sel)
const firstKey = (p: Page, tid: string) =>
  p.evaluate((t) => document.querySelector(`[data-testid="${t}"]`)?.firstElementChild?.getAttribute('data-testid') ?? null, tid)

async function openPaired(browser: Browser, opts: ReturnType<typeof ipad>) {
  const ctx = await browser.newContext(opts)
  const page = await ctx.newPage()
  await agent.pair(page)
  await page.goto(agent.baseURL)
  // 横屏 + 触屏时状态栏可能被 short 规则藏起来，等 attached 即可
  await page.getByTestId('conn-text').filter({ hasText: '在线' }).waitFor({ state: 'attached' })
  return { ctx, page }
}

test('iPad 横屏（1133×744，触屏）：侧栏常驻，但底栏是键行不是经典底栏；⋯ 是右下角弹出菜单', async ({ browser }) => {
  const { ctx, page } = await openPaired(browser, ipad(1133, 744))

  await expect(page.locator('.app')).toHaveAttribute('data-bp', 'desktop')
  const side = await rect(page, '.sidebar')
  expect(side!.width, '桌面宽度：侧栏常驻').toBeGreaterThanOrEqual(200)

  // 触屏 → 输入层是键行 / 编辑面板：没有模式条、没有常驻 Composer；互切键在行首；不盖终端
  await expect(page.getByTestId('modebar'), '触屏没有经典底栏的模式条').toHaveCount(0)
  await expect(page.getByTestId('composer'), '默认终端输入，没有常驻输入框').toHaveCount(0)
  await expect(page.getByTestId('term-bar')).toBeVisible()
  expect(await firstKey(page, 'keybar')).toBe('to-edit')
  await expect(page.getByTestId('key-Tab'), '提示符键集').toBeVisible()
  const bottom = await rect(page, '.bottom')
  const slot = await rect(page, '.bottom-slot')
  expect(bottom!.height, '键行不高于槽位').toBeLessThanOrEqual(slot!.height)

  // ⋯ → 锚在键行右上方的弹出菜单，不是整宽表单；里面能进设置
  await page.getByTestId('open-more').click()
  const menu = await rect(page, '[data-testid=more-menu]')
  const main = await rect(page, '.main')
  expect(menu!.width, '弹出菜单不是整宽').toBeLessThanOrEqual(320)
  expect(main!.right - menu!.right, '贴着主区右缘').toBeLessThanOrEqual(16)
  await page.getByTestId('open-settings').click()
  await expect(page.getByTestId('settings')).toBeVisible()
  // 设置是模态浮层（ADR-0018）：关掉它再继续
  await page.getByTestId('drawer-close').click()
  await expect(page.getByTestId('settings')).toBeHidden()

  // 一键切编辑面板照样能用；互切键回终端
  await page.getByTestId('to-edit').click()
  await expect(page.getByTestId('composer')).toBeVisible()
  expect(await firstKey(page, 'editkeys')).toBe('to-terminal')
  await page.getByTestId('to-terminal').click()
  await expect(page.getByTestId('term-bar')).toBeVisible()
  await ctx.close()
})

test('iPad 竖屏（744×1133）：提示符键集全部免滚；半屏不超过 420px；⋯ 是弹出菜单', async ({ browser }) => {
  const { ctx, page } = await openPaired(browser, ipad(744, 1133))

  await expect(page.locator('.app')).toHaveAttribute('data-bp', 'tablet')
  const scroll = await page.evaluate(() => {
    const el = document.querySelector('.keybar .keybar-scroll')!
    return { scrollW: el.scrollWidth, clientW: el.clientWidth }
  })
  expect(scroll.scrollW, '744px 宽下 12 个提示符键全部免滚').toBeLessThanOrEqual(scroll.clientW + 1)

  await page.getByTestId('open-more').click()
  const menu = await rect(page, '[data-testid=more-menu]')
  expect(menu!.width, '平板上 ⋯ 不是整宽表单').toBeLessThanOrEqual(320)
  await page.getByTestId('more-backdrop').click()
  await expect(page.getByTestId('more-menu')).toHaveCount(0)

  await page.getByTestId('to-edit').click()
  await page.locator('.bottom[data-sheet=half]').waitFor()
  await page.waitForTimeout(250)
  const half = await rect(page, '.bottom')
  expect(half!.height, '半屏有上限，多出来的留给终端').toBeLessThanOrEqual(420)
  expect(half!.height).toBeGreaterThanOrEqual(190)
  const composer = await rect(page, '[data-testid=composer]')
  expect(composer!.height, '输入框仍有足够行数').toBeGreaterThan(200)
  await ctx.close()
})
