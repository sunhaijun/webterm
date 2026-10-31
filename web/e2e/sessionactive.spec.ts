/**
 * E2E-35 当前会话一眼可辨 —— AC-4.9。
 *
 * 1440×900（标签栏）与 Pixel 5（抽屉）。断言的是【看得出来】，所以量计算样式与矩形，
 * 不量 class 名。
 */
import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, focusTerm, hooks, newSession, openDrawer } from './harness'

const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

const bg = (p: Page, sel: string) => p.locator(sel).evaluate((el) => getComputedStyle(el).backgroundColor)
const accent = (p: Page) =>
  p.evaluate(() => {
    const d = document.createElement('div')
    d.style.color = 'var(--accent)'
    document.body.appendChild(d)
    const c = getComputedStyle(d).color
    d.remove()
    return c
  })

/** 一直按到当前会话落在标签的头 / 尾（Ctrl+Shift+↑/↓ 到头会回绕）。 */
async function stepUntil(page: Page, key: string, where: 'first' | 'last') {
  const target = Number(await page.locator('.tabbar .tab')[where]().getAttribute('data-sid'))
  for (let i = 0; i < 8 && (await hooks.sid(page)) !== target; i++) {
    await focusTerm(page)
    await page.keyboard.press(key)
    await page.waitForTimeout(150)
  }
  expect(await hooks.sid(page), `切到了${where === 'first' ? '第一个' : '最后一个'}会话`).toBe(target)
}

/** 当前标签整个落在标签条里。 */
const currentFullyVisible = (page: Page) =>
  page.evaluate(() => {
    const box = document.querySelector('[data-testid=tabbar]')!.getBoundingClientRect()
    const el = document.querySelector('.tabbar .tab[aria-current="true"]')!.getBoundingClientRect()
    return { inside: el.left >= box.left - 1 && el.right <= box.right + 1, scrollLeft: (document.querySelector('[data-testid=tabbar]') as HTMLElement).scrollLeft }
  })

test.describe('1440×900 标签栏', () => {
  test.use({ viewport: { width: 1440, height: 900 }, contextOptions: { screen: { width: 1440, height: 900 } } })

  test('E2E-35 ①–⑤ 只有一个当前；当前 ≠ hover ≠ 普通且带强调色下划线；跟着切换搬家；可见时不滚', async ({ page }) => {
    await agent.open(page)
    await newSession(page)
    await newSession(page)
    await expect(page.locator('.tabbar .tab')).toHaveCount(3)

    // ② 只有一个当前，且就是 __webterm.sid()
    const current = page.locator('.tabbar .tab[aria-current="true"]')
    await expect(current).toHaveCount(1)
    expect(await current.getAttribute('data-sid')).toBe(String(await hooks.sid(page)))

    // ③ 当前 / hover / 普通，两两不同
    const others = page.locator('.tabbar .tab:not([aria-current="true"])')
    await others.nth(0).hover()
    const sel = await bg(page, '.tabbar .tab[aria-current="true"]')
    const hov = await others.nth(0).evaluate((el) => getComputedStyle(el).backgroundColor)
    const plain = await others.nth(1).evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(sel, '当前与 hover 必须分得开').not.toBe(hov)
    expect(sel, '当前与普通必须分得开').not.toBe(plain)
    expect(hov, 'hover 与普通也要有区别').not.toBe(plain)
    const shadow = await current.evaluate((el) => getComputedStyle(el).boxShadow)
    expect(shadow, '当前标签有下划线（inset 阴影）').toContain('inset')
    expect(shadow, '下划线是强调色').toContain(await accent(page))

    // ④ 跟着切换搬家
    const before = await hooks.sid(page)
    await focusTerm(page)
    await page.keyboard.press('Control+Shift+ArrowDown')
    await expect.poll(() => hooks.sid(page)).not.toBe(before)
    await expect(current).toHaveCount(1)
    expect(await current.getAttribute('data-sid')).toBe(String(await hooks.sid(page)))
    await expect(page.locator(`.tabbar .tab[data-sid="${before}"]`)).not.toHaveAttribute('aria-current', 'true')

    // ⑤ 都看得见时来回切两次，标签条一次都不滚
    for (const k of ['Control+Shift+ArrowDown', 'Control+Shift+ArrowUp', 'Control+Shift+ArrowDown', 'Control+Shift+ArrowUp']) {
      await focusTerm(page)
      await page.keyboard.press(k)
      await page.waitForTimeout(100)
      expect(await page.getByTestId('tabbar').evaluate((el) => el.scrollLeft), '全可见时不滚').toBe(0)
    }
  })
})

test.describe('600×900 窄窗口（screen 1440×900）', () => {
  test.use({ viewport: { width: 600, height: 900 }, contextOptions: { screen: { width: 1440, height: 900 } } })

  test('E2E-35 ⑥ 当前标签被切到视区外时滚进来；切回第一个同样完整可见', async ({ page }) => {
    // 标签最窄 120px（ADR-0031）：600px 宽的窗口里 5 个放不下
    await agent.open(page)
    for (let i = 1; i < 5; i++) await newSession(page)
    await expect(page.locator('.tabbar .tab')).toHaveCount(5)
    const w = await page.getByTestId('tabbar').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }))
    expect(w.sw, '标签条确实放不下').toBeGreaterThan(w.cw)

    await stepUntil(page, 'Control+Shift+ArrowUp', 'first')
    await stepUntil(page, 'Control+Shift+ArrowDown', 'last')
    const last = await currentFullyVisible(page)
    expect(last.inside, '最后一个标签整个落在标签条里').toBe(true)
    expect(last.scrollLeft, '确实是靠滚动做到的').toBeGreaterThan(0)

    await stepUntil(page, 'Control+Shift+ArrowUp', 'first')
    expect((await currentFullyVisible(page)).inside, '切回第一个也完整可见').toBe(true)
  })
})

test.describe('Pixel 5 抽屉', () => {
  test.use(PIXEL)

  test('E2E-35 ⑦ 抽屉里同一套：当前行恰好一条、带强调色左条', async ({ page }) => {
    await agent.open(page)
    await newSession(page)
    await newSession(page)
    await openDrawer(page)
    const cur = page.locator('[data-testid=session-list] [aria-current="true"]')
    await expect(cur).toHaveCount(1)
    expect(await cur.getAttribute('data-sid')).toBe(String(await hooks.sid(page)))
    const shadow = await cur.evaluate((el) => getComputedStyle(el).boxShadow)
    expect(shadow, '当前行有左条（inset 阴影）').toContain('inset')
    expect(shadow, '左条是强调色').toContain(await accent(page))
    const other = page.locator('[data-testid=session-list] .session-row:not([aria-current="true"])').first()
    expect(await cur.evaluate((el) => getComputedStyle(el).backgroundColor), '当前行有底色').not.toBe(
      await other.evaluate((el) => getComputedStyle(el).backgroundColor),
    )
  })
})
