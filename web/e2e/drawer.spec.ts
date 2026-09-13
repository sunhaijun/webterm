/**
 * E2E-28 浮层统一（ADR-0018 / AC-5.11）
 *
 * 会话 / 历史 / 命令面板 / 设置共用一个 Drawer：触屏贴底整宽 + 抓手 + 标题栏 + ✕，
 * 四种关法一致，且浮层【不挤终端】—— 老的设置横幅会把终端顶上去并触发 resize。
 */
import { devices, expect, test, type Browser, type Page } from '@playwright/test'

import { Agent } from './harness'

const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
test.setTimeout(60_000)

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
    return {
      left: Math.round(r.left),
      right: Math.round(r.right),
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      width: Math.round(r.width),
      height: Math.round(r.height),
      vw: window.innerWidth,
      vh: window.innerHeight,
    }
  }, sel)

/** ⋯ → 某一项（手机 / 平板的次要入口都在这里）。 */
async function openFromMore(page: Page, testid: string) {
  await page.getByTestId('open-more').click()
  await page.getByTestId(testid).click()
}

/** 等进场动画（sheet-up 180ms）落位再量 —— 动画途中量到的是半路的 transform。 */
async function settled(page: Page, sel: string, what: string) {
  await expect
    .poll(async () => {
      const r = await rect(page, sel)
      return r ? Math.abs(r.bottom - r.vh) : -1
    }, { message: `${what}：贴底` })
    .toBeLessThanOrEqual(1)
  return (await rect(page, sel))!
}

test.describe('Pixel 5', () => {
  test.use(PIXEL)

  test('⋯ 里四项打开的是同一种壳：贴底整宽 + 抓手 + 标题栏 + ✕', async ({ page }) => {
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')

    const entries: [string, string][] = [
      ['open-sessions', '会话'],
      ['open-history', '历史'],
      ['open-palette', '命令面板'],
      ['open-settings', '设置'],
    ]
    for (const [entry, title] of entries) {
      await openFromMore(page, entry)
      await expect(page.locator('.drawer')).toBeVisible()

      const r = await settled(page, '.drawer', title)
      expect(r.width, `${title}：整宽`).toBe(r.vw)
      expect(r.left, `${title}：左缘贴边`).toBe(0)

      await expect(page.locator('.drawer-grab'), `${title}：有抓手`).toBeVisible()
      await expect(page.locator('.drawer-title'), `${title}：标题`).toHaveText(title)
      await expect(page.getByTestId('drawer-close').or(page.getByTestId('close-history')), `${title}：有 ✕`).toBeVisible()

      // 统一的关法之一：点遮罩
      await page.locator('.drawer-backdrop').click({ position: { x: 5, y: 5 } })
      await expect(page.locator('.drawer')).toBeHidden()
    }
  })

  test('设置三种关法都生效：遮罩 / Esc / ✕', async ({ page }) => {
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')

    for (const close of ['backdrop', 'escape', 'x'] as const) {
      await openFromMore(page, 'open-settings')
      await expect(page.getByTestId('settings')).toBeVisible()
      // 模态浮层要把焦点收进来（无障碍；也让 Esc 有确定的接收者）
      await expect
        .poll(() => page.evaluate(() => !!document.activeElement?.closest('.drawer')), { message: '焦点进浮层' })
        .toBe(true)
      if (close === 'backdrop') await page.locator('.drawer-backdrop').click({ position: { x: 5, y: 5 } })
      else if (close === 'escape') await page.keyboard.press('Escape')
      else await page.getByTestId('drawer-close').click()
      await expect(page.getByTestId('settings'), `${close} 能关掉`).toBeHidden()
    }
  })

  test('浮层不挤终端：开设置前后终端矩形与 cols/rows 都不变', async ({ page }) => {
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')

    const size = () => page.evaluate(() => (window as unknown as { __webterm: { size(): { cols: number; rows: number } } }).__webterm.size())
    const before = { term: await rect(page, '.term'), size: await size() }

    await openFromMore(page, 'open-settings')
    await expect(page.getByTestId('settings')).toBeVisible()
    const during = { term: await rect(page, '.term'), size: await size() }

    expect(during.term, '终端矩形不动').toEqual(before.term)
    expect(during.size, 'PTY cols/rows 不动').toEqual(before.size)
  })

  test('设置内容完整：主题 / 字号 / 渲染器 / 隐私说明；改字号实时生效', async ({ page }) => {
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')

    await openFromMore(page, 'open-settings')
    await expect(page.getByTestId('theme-select')).toBeVisible()
    await expect(page.getByTestId('renderer')).toHaveText(/WebGL|Canvas/)
    await expect(page.getByTestId('privacy-note')).toContainText('以空格开头的命令不会被记录')

    await page.getByTestId('font-size').fill('18')
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __webterm: { fontSize(): number } }).__webterm.fontSize()))
      .toBe(18)
  })
})

test('平板（744×1133）上会话也从底部出来，不是左侧抽屉', async ({ browser }: { browser: Browser }) => {
  const ctx = await browser.newContext({
    viewport: { width: 744, height: 1133 },
    hasTouch: true,
    isMobile: true,
    userAgent:
      'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  })
  const page = await ctx.newPage()
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await page.getByTestId('conn-text').filter({ hasText: '在线' }).waitFor({ state: 'attached' })
  await expect(page.locator('.app')).toHaveAttribute('data-bp', 'tablet')

  await openFromMore(page, 'open-sessions')
  await expect(page.getByTestId('sidebar')).toBeVisible()
  const r = await settled(page, '[data-testid=sidebar]', '会话')
  expect(r.left, '左缘贴边（不是 280px 的左抽屉）').toBe(0)
  expect(r.width, '整宽').toBe(r.vw)
  await expect(page.getByTestId('new-session'), '列表内容还在').toBeVisible()
  await ctx.close()
})
