/**
 * E2E-21 On-screen keyboard geometry: extra keys stay visible when the keyboard opens (AC-3.8,
 * layout.md "Height").
 *
 * Both browser models must work:
 *  - The layout viewport shrinks too (resizes-content, older Android Chrome): shrink the Playwright
 *    viewport for real.
 *  - Only the visual viewport shrinks and the browser pushes it up (iOS Safari, Chrome >= 108
 *    resizes-visual): replay it with a fake visualViewport. Under Safari semantics
 *    window.innerHeight shrinks as well; that once kept the gate permanently closed and pushed the
 *    whole .app out of view.
 */
import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, focusTerm, hooks } from './harness'

const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
test.use(PIXEL)

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

interface Rect {
  top: number
  bottom: number
}
const geo = (p: Page) =>
  p.evaluate(() => {
    const app = document.querySelector('.app') as HTMLElement
    const r = app.getBoundingClientRect()
    const q = (sel: string): Rect | null => {
      const e = document.querySelector(sel) as HTMLElement | null
      if (!e) return null
      const b = e.getBoundingClientRect()
      return { top: Math.round(b.top), bottom: Math.round(b.bottom) }
    }
    return {
      appH: app.style.height,
      appTf: app.style.transform,
      app: { top: Math.round(r.top), bottom: Math.round(r.bottom) },
      keys: q('[data-testid=extrakeys]'),
      form: app.dataset.form,
      active: document.activeElement?.className ?? '',
    }
  })
const settle = (p: Page) =>
  p.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 200)))))
const within = (r: Rect | null, top: number, bottom: number) => !!r && r.top >= top && r.bottom <= bottom

/**
 * installFakeViewport installs a fake visualViewport with controllable height and offsetTop. A
 * non-null `inner` simulates Safari, where innerHeight equals the visual viewport height.
 */
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
  p.evaluate(
    ([h, top, inner]) => (window as unknown as { __vv(h: number, top: number, inner: number | null): void }).__vv(h, top, inner),
    [h, top, inner] as const,
  )

test('E2E-21 (1) layout viewport shrinks (resizes-content): .app shrinks, extra keys visible, form unchanged, fewer rows', async ({ page }) => {
  await agent.open(page)
  await settle(page)
  await focusTerm(page)
  const rows0 = (await hooks.size(page)).rows
  const resizes0 = await hooks.resizes(page)

  await page.setViewportSize({ width: 393, height: 450 }) // keyboard takes 277px
  await settle(page)
  const g = await geo(page)
  expect(g.appH).toBe('450px')
  expect(g.appTf, 'no push-up when the layout viewport shrinks, so no translateY').toBe('')
  expect(within(g.keys, 0, 450), `extra keys ${JSON.stringify(g.keys)} should be within [0,450]`).toBe(true)
  expect(g.form, 'form unchanged').toBe('compact')
  await expect.poll(() => hooks.resizes(page), { message: 'resize sent' }).toBeGreaterThan(resizes0)
  expect((await hooks.size(page)).rows, 'terminal shrinks instead of being covered').toBeLessThan(rows0)
})

for (const innerTracks of [true, false]) {
  test(`E2E-21 (2) only the visual viewport shrinks and is pushed up (${innerTracks ? 'Safari: innerHeight shrinks too' : 'Chrome: innerHeight constant'}): .app aligns with the visible area, extra keys visible`, async ({ page }) => {
    await installFakeViewport(page)
    await agent.open(page)
    await settle(page)
    await focusTerm(page)

    // Keyboard opens: visible height 727 -> 400; the browser pushes the visible area up 327px.
    await setViewport(page, 400, 327, innerTracks ? 400 : null)
    await settle(page)
    const g = await geo(page)
    expect(g.appH).toBe('400px')
    expect(g.appTf, '.app must use translateY to follow the pushed-up visible area').toBe('translateY(327px)')
    expect(g.app.top).toBe(327)
    expect(within(g.keys, 327, 727), `extra keys ${JSON.stringify(g.keys)} should be within the visible area [327,727]`).toBe(true)

    // Keyboard closes: everything resets.
    await setViewport(page, 727, 0, innerTracks ? 727 : null)
    await settle(page)
    const g2 = await geo(page)
    expect(g2.appH).toBe('727px')
    expect(g2.appTf).toBe('')

    // Same with the text page focused.
    await page.getByTestId('toggle-text').tap()
    await expect(page.getByTestId('textinput')).toBeFocused()
    await setViewport(page, 400, 327, innerTracks ? 400 : null)
    await settle(page)
    const g3 = await geo(page)
    expect(g3.appTf).toBe('translateY(327px)')
    expect(within(g3.keys, 327, 727), `text page ${JSON.stringify(g3.keys)} should be within the visible area [327,727]`).toBe(true)
    await setViewport(page, 727, 0, innerTracks ? 727 : null)
    await settle(page)
    expect((await geo(page)).appTf).toBe('')
  })
}

test('E2E-21 (3) plain overscroll bounce (offsetTop changes, height does not) is not compensated, avoiding a drag jitter loop', async ({ page }) => {
  await installFakeViewport(page)
  await agent.open(page)
  await settle(page)
  await setViewport(page, 727, -40, null) // bounce at the top
  await settle(page)
  expect((await geo(page)).appTf).toBe('')
  await setViewport(page, 727, 60, null) // offsetTop drift during a drag
  await settle(page)
  expect((await geo(page)).appTf).toBe('')
})
