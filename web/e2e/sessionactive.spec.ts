/**
 * E2E-35 The current session is obvious at a glance (AC-4.9).
 *
 * Runs at 1440×900 (tab bar) and on Pixel 5 (drawer). The point is that it is visible, so the test
 * measures computed styles and rects rather than class names.
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

/** stepUntil presses `key` until the current session is the first or last tab (Ctrl+Shift+Up/Down wraps around). */
async function stepUntil(page: Page, key: string, where: 'first' | 'last') {
  const target = Number(await page.locator('.tabbar .tab')[where]().getAttribute('data-sid'))
  for (let i = 0; i < 8 && (await hooks.sid(page)) !== target; i++) {
    await focusTerm(page)
    await page.keyboard.press(key)
    await page.waitForTimeout(150)
  }
  expect(await hooks.sid(page), `switched to the ${where} session`).toBe(target)
}

/** currentFullyVisible reports whether the current tab lies entirely within the tab strip. */
const currentFullyVisible = (page: Page) =>
  page.evaluate(() => {
    const box = document.querySelector('[data-testid=tabbar]')!.getBoundingClientRect()
    const el = document.querySelector('.tabbar .tab[aria-current="true"]')!.getBoundingClientRect()
    return { inside: el.left >= box.left - 1 && el.right <= box.right + 1, scrollLeft: (document.querySelector('[data-testid=tabbar]') as HTMLElement).scrollLeft }
  })

test.describe('1440×900 tab bar', () => {
  test.use({ viewport: { width: 1440, height: 900 }, contextOptions: { screen: { width: 1440, height: 900 } } })

  test('E2E-35 (1)-(5) exactly one current tab; current, hover and plain all differ, with an accent underline; follows switching; no scroll when all visible', async ({ page }) => {
    await agent.open(page)
    await newSession(page)
    await newSession(page)
    await expect(page.locator('.tabbar .tab')).toHaveCount(3)

    // (2) Exactly one current tab, and it is __webterm.sid().
    const current = page.locator('.tabbar .tab[aria-current="true"]')
    await expect(current).toHaveCount(1)
    expect(await current.getAttribute('data-sid')).toBe(String(await hooks.sid(page)))

    // (3) Current, hover and plain are pairwise distinct.
    const others = page.locator('.tabbar .tab:not([aria-current="true"])')
    await others.nth(0).hover()
    const sel = await bg(page, '.tabbar .tab[aria-current="true"]')
    const hov = await others.nth(0).evaluate((el) => getComputedStyle(el).backgroundColor)
    const plain = await others.nth(1).evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(sel, 'current must differ from hover').not.toBe(hov)
    expect(sel, 'current must differ from plain').not.toBe(plain)
    expect(hov, 'hover must differ from plain').not.toBe(plain)
    const shadow = await current.evaluate((el) => getComputedStyle(el).boxShadow)
    expect(shadow, 'current tab has an underline (inset shadow)').toContain('inset')
    expect(shadow, 'underline uses the accent color').toContain(await accent(page))

    // (4) The marker follows switching.
    const before = await hooks.sid(page)
    await focusTerm(page)
    await page.keyboard.press('Control+Shift+ArrowDown')
    await expect.poll(() => hooks.sid(page)).not.toBe(before)
    await expect(current).toHaveCount(1)
    expect(await current.getAttribute('data-sid')).toBe(String(await hooks.sid(page)))
    await expect(page.locator(`.tabbar .tab[data-sid="${before}"]`)).not.toHaveAttribute('aria-current', 'true')

    // (5) With all tabs visible, switching back and forth twice never scrolls the strip.
    for (const k of ['Control+Shift+ArrowDown', 'Control+Shift+ArrowUp', 'Control+Shift+ArrowDown', 'Control+Shift+ArrowUp']) {
      await focusTerm(page)
      await page.keyboard.press(k)
      await page.waitForTimeout(100)
      expect(await page.getByTestId('tabbar').evaluate((el) => el.scrollLeft), 'no scroll when all tabs are visible').toBe(0)
    }
  })
})

test.describe('600×900 narrow window (screen 1440×900)', () => {
  test.use({ viewport: { width: 600, height: 900 }, contextOptions: { screen: { width: 1440, height: 900 } } })

  test('E2E-35 (6) a current tab outside the strip scrolls into view; switching back to the first is fully visible too', async ({ page }) => {
    // Tabs are at least 120px wide (ADR-0031), so 5 do not fit in a 600px window.
    await agent.open(page)
    for (let i = 1; i < 5; i++) await newSession(page)
    await expect(page.locator('.tabbar .tab')).toHaveCount(5)
    const w = await page.getByTestId('tabbar').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }))
    expect(w.sw, 'tabs overflow the strip').toBeGreaterThan(w.cw)

    await stepUntil(page, 'Control+Shift+ArrowUp', 'first')
    await stepUntil(page, 'Control+Shift+ArrowDown', 'last')
    const last = await currentFullyVisible(page)
    expect(last.inside, 'last tab lies entirely within the strip').toBe(true)
    expect(last.scrollLeft, 'achieved by scrolling').toBeGreaterThan(0)

    await stepUntil(page, 'Control+Shift+ArrowUp', 'first')
    expect((await currentFullyVisible(page)).inside, 'first tab is fully visible after switching back').toBe(true)
  })
})

test.describe('Pixel 5 drawer', () => {
  test.use(PIXEL)

  test('E2E-35 (7) same rules in the drawer: exactly one current row, with an accent left bar', async ({ page }) => {
    await agent.open(page)
    await newSession(page)
    await newSession(page)
    await openDrawer(page)
    const cur = page.locator('[data-testid=session-list] [aria-current="true"]')
    await expect(cur).toHaveCount(1)
    expect(await cur.getAttribute('data-sid')).toBe(String(await hooks.sid(page)))
    const shadow = await cur.evaluate((el) => getComputedStyle(el).boxShadow)
    expect(shadow, 'current row has a left bar (inset shadow)').toContain('inset')
    expect(shadow, 'left bar uses the accent color').toContain(await accent(page))
    const other = page.locator('[data-testid=session-list] .session-row:not([aria-current="true"])').first()
    expect(await cur.evaluate((el) => getComputedStyle(el).backgroundColor), 'current row has a background').not.toBe(
      await other.evaluate((el) => getComputedStyle(el).backgroundColor),
    )
  })
})
