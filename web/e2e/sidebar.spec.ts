/**
 * E2E-32 侧栏拖宽与收起（AC-5.12）
 *
 * 核心断言不是「宽度变了」，而是【拖动期间什么都没重排】—— 侧栏是主栅格的一列，
 * 拖它就是在改终端几何。所以拖动只让分隔条自己跟手（transform 预览），
 * 松手才落一次宽度、补一条 resize（ADR-0021 / layout-responsive.md §desktop）。
 */
import { expect, test, type Page } from '@playwright/test'

import { Agent } from './harness'

type Hooks = { __webterm: { resizes(): number; size(): { cols: number; rows: number } } }
const resizes = (p: Page) => p.evaluate(() => (window as unknown as Hooks).__webterm.resizes())
const cols = (p: Page) => p.evaluate(() => (window as unknown as Hooks).__webterm.size().cols)

const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

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
    return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) }
  }, sel)

const sidebarWidth = async (p: Page) => (await rect(p, '.sidebar'))?.width ?? -1
const state = (p: Page) => p.evaluate(() => document.querySelector('.app')?.getAttribute('data-sidebar') ?? '')

/** 分隔条中点（收起时它贴在左缘）。 */
async function handleAt(p: Page): Promise<{ x: number; y: number }> {
  const r = (await rect(p, '.sidebar-resizer'))!
  return { x: Math.round((r.left + r.right) / 2), y: 400 }
}

/**
 * 分隔条【视觉上】在哪儿 —— 拖动中它就是预览线（ADR-0021）。
 * 量的是屏幕位置，所以 transform 平移算数；`.sidebar` 的宽度不算。
 */
async function edgeAt(p: Page): Promise<number> {
  const r = (await rect(p, '.sidebar-resizer'))!
  return Math.round((r.left + r.right) / 2)
}

async function open(page: Page) {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await expect(page.locator('.app')).toHaveAttribute('data-bp', 'desktop')
  // 等首轮布局的 resize 落定，后面数条数才有意义
  await expect.poll(async () => {
    const a = await resizes(page)
    await page.waitForTimeout(250)
    return (await resizes(page)) === a
  }).toBe(true)
}

test.describe('1440×900 鼠标键盘', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('拖分隔条只预览：拖动中一点不重排，松手才落宽度，全程只发一条 resize', async ({ page }) => {
    await open(page)
    expect(await sidebarWidth(page)).toBe(240)
    const before = await resizes(page)
    const wide = await cols(page)

    const h = await handleAt(page)
    const e0 = await edgeAt(page)
    await page.mouse.move(h.x, h.y)
    await page.mouse.down()
    await page.mouse.move(h.x + 120, h.y, { steps: 12 })

    // 松手【之前】：跟着指针走的只有分隔条自己，侧栏与终端一点没动
    expect(await edgeAt(page), '预览线跟着指针走').toBe(e0 + 120)
    expect(await sidebarWidth(page), '拖动中侧栏不重排').toBe(240)
    expect(await cols(page), '拖动中终端不重排').toBe(wide)
    expect(await resizes(page), '拖动中不发 resize').toBe(before)

    await page.mouse.up()
    // 落点就是刚才预览线所在的位置
    await expect.poll(() => sidebarWidth(page)).toBe(360)
    await expect.poll(() => resizes(page), { message: '松手后补发一条' }).toBe(before + 1)
    // 再等一拍，确认没有第二条追进来
    await page.waitForTimeout(400)
    expect(await resizes(page)).toBe(before + 1)
    expect(await cols(page), '终端变窄了').toBeLessThan(wide)
    expect(await edgeAt(page), '松手后清掉 transform，分隔条回到列边界上').toBe(e0 + 120)
  })

  test('预览 = 松手结果：吸附与收起判定在拖动中就看得见', async ({ page }) => {
    await open(page)
    const e0 = await edgeAt(page)

    // 拖 10px：过了「算拖不算点」的 6px 门槛，又在吸附区（≤12px）里 ——
    // 预览线【当场】吸附回 240，不等松手
    let h = await handleAt(page)
    await page.mouse.move(h.x, h.y)
    await page.mouse.down()
    await page.mouse.move(h.x + 10, h.y, { steps: 3 })
    expect(await edgeAt(page), '预览线吸附回 240').toBe(e0)
    await page.mouse.up()
    await expect.poll(() => sidebarWidth(page)).toBe(240)

    // 往左拖过收起门槛（200 × 0.6 = 120）：预览线【当场】贴到左缘
    h = await handleAt(page)
    await page.mouse.move(h.x, h.y)
    await page.mouse.down()
    await page.mouse.move(100, h.y, { steps: 8 })
    expect(await edgeAt(page), '预览线贴左缘 = 松手会收起').toBe(e0 - 240)
    expect(await sidebarWidth(page), '但此刻还没收起').toBe(240)
    await page.mouse.up()
    await expect.poll(() => state(page)).toBe('closed')
  })

  test('上下限：右拖撞 480，左拖过门槛即收起', async ({ page }) => {
    await open(page)
    let h = await handleAt(page)
    await page.mouse.move(h.x, h.y)
    await page.mouse.down()
    await page.mouse.move(1430, h.y, { steps: 10 })
    await page.mouse.up()
    // min(480, 1440 × 40% = 576) = 480
    await expect.poll(() => sidebarWidth(page)).toBe(480)

    h = await handleAt(page)
    await page.mouse.move(h.x, h.y)
    await page.mouse.down()
    await page.mouse.move(100, h.y, { steps: 10 }) // 200 × 0.6 = 120 以下
    await page.mouse.up()
    await expect.poll(() => state(page)).toBe('closed')
    expect(await sidebarWidth(page)).toBe(0)

    // 收起时宽度保持拖动前的 480，展开回得去
    await page.getByTestId('sidebar-resizer').click()
    await expect.poll(() => state(page)).toBe('open')
    expect(await sidebarWidth(page)).toBe(480)
  })

  test('点一下收起 / 展开，收起后仍能从左缘把手拖出来', async ({ page }) => {
    await open(page)
    const narrow = await cols(page)

    await page.getByTestId('sidebar-resizer').click()
    await expect.poll(() => state(page)).toBe('closed')
    await expect.poll(() => cols(page), { message: '终端吃掉整屏' }).toBeGreaterThan(narrow)

    // 收起态的把手贴在左缘，直接拖出来
    const h = await handleAt(page)
    expect(h.x, '把手在左缘').toBeLessThan(16)
    await page.mouse.move(h.x, h.y)
    await page.mouse.down()
    await page.mouse.move(320, h.y, { steps: 10 })
    // 拖动中【不提前展开】：统一走预览，松手才落地（ADR-0021）
    expect(await state(page), '拖动中还是收起态').toBe('closed')
    expect(await edgeAt(page), '预览线已经跟到指针').toBe(320)
    await page.mouse.up()
    await expect.poll(() => state(page)).toBe('open')
    // 【拖的是相对位移】：抓住哪儿哪儿跟手，所以落点是「拖到的位置 − 起手点」，
    // 不是拖到的位置本身（展开态抓的正好是列边界，两者才重合）
    await expect.poll(() => sidebarWidth(page)).toBe(320 - h.x)
  })

  test('键盘：← / → 步进，Home / End 到边界', async ({ page }) => {
    await open(page)
    const bar = page.getByTestId('sidebar-resizer')
    await bar.focus()
    await bar.press('ArrowRight')
    await bar.press('ArrowRight')
    await bar.press('ArrowRight')
    await expect.poll(() => sidebarWidth(page)).toBe(288) // 240 + 16×3
    await bar.press('Shift+ArrowLeft')
    await expect.poll(() => sidebarWidth(page)).toBe(224) // −64
    await bar.press('Home')
    await expect.poll(() => sidebarWidth(page)).toBe(200)
    await bar.press('End')
    await expect.poll(() => sidebarWidth(page)).toBe(480)
  })

  test('持久化：刷新还在；窗口变窄按上下限夹紧，但不写坏存储', async ({ page }) => {
    await open(page)
    const bar = page.getByTestId('sidebar-resizer')
    await bar.focus()
    await bar.press('End')
    await expect.poll(() => sidebarWidth(page)).toBe(480)

    await page.reload()
    await expect(page.getByTestId('conn-text')).toHaveText('在线')
    expect(await sidebarWidth(page), '刷新后宽度还在').toBe(480)

    // 缩到 1024：上限变成 40% = 410，当前宽度被夹下去
    await page.setViewportSize({ width: 1024, height: 900 })
    await expect.poll(() => sidebarWidth(page)).toBe(410)
    // 夹紧【不回写存储】：回到大窗口刷新一次，480 还在
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.reload()
    await expect(page.getByTestId('conn-text')).toHaveText('在线')
    expect(await sidebarWidth(page)).toBe(480)

    // 收起状态也记住
    await page.getByTestId('sidebar-resizer').click()
    await expect.poll(() => state(page)).toBe('closed')
    await page.reload()
    await expect(page.getByTestId('conn-text')).toHaveText('在线')
    expect(await state(page)).toBe('closed')
  })
})

test.describe('phone 390×844', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('侧栏偏好只在 desktop 生效：手机既不自己弹浮层，也没有分隔条', async ({ page }) => {
    // 存储里躺着「展开」，手机也不能拿它当浮层开关（会话浮层会自己弹出来）
    await page.addInitScript(() => {
      try {
        localStorage.setItem('webterm.sidebar.open', '1')
        localStorage.setItem('webterm.sidebar.w', '400')
      } catch {
        /* 隐私窗口，忽略 */
      }
    })
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')
    await expect(page.locator('.app')).toHaveAttribute('data-bp', 'phone')
    expect(await state(page)).toBe('closed')
    await expect(page.getByTestId('sidebar-resizer')).toHaveCount(0)
  })
})

test.describe('iPad 横屏 1133×744 触屏', () => {
  test.use({ viewport: { width: 1133, height: 744 }, hasTouch: true, isMobile: true, userAgent: IPAD_UA })

  test('触屏的最小宽更大（三个 44px 图标就占 132px），收起后把手不贴屏幕左缘', async ({ page }) => {
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text').filter({ hasText: '在线' })).toBeAttached()
    await expect(page.locator('.app')).toHaveAttribute('data-bp', 'desktop')

    const bar = page.getByTestId('sidebar-resizer')
    await bar.focus()
    await bar.press('Home')
    await expect.poll(() => sidebarWidth(page), { message: '触屏最小宽 260 而不是 200' }).toBe(260)
    await bar.press('End')
    // min(480, 1133 × 40% = 453) = 453
    await expect.poll(() => sidebarWidth(page)).toBe(453)

    await bar.click()
    await expect.poll(() => state(page)).toBe('closed')
    const h = (await rect(page, '.sidebar-resizer'))!
    // 贴着屏幕左缘起手会被 Safari / PWA 当成返回手势，留 8px
    expect(h.left, '把手离左缘 8px').toBeGreaterThanOrEqual(8)
    expect(h.width, '触屏命中区 ≥ 24px').toBeGreaterThanOrEqual(24)
  })
})
