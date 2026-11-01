/**
 * E2E-28 Sheets and the phone session drawer (AC-4.10 / AC-4.11 / AC-5.11 / AC-4.8).
 *
 * Phone session drawer: bottom-anchored, full width, grab handle, title bar with ✕; sheets overlay
 * the terminal instead of squeezing it; the sessions button shows the session count. At least half
 * the screen tall, bottom row padded on all sides (ADR-0037 §5); the close confirmation stacks on
 * the drawer (ADR-0038); settings opens from the drawer. The drawer has a ~170ms enter animation, so
 * wait for it to settle before measuring rects.
 */
import { mkdirSync, rmSync } from 'node:fs'

import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, FIXTURES, focusTerm, hooks, newSession, openDrawer, rectOf, settled, submit, waitFor } from './harness'

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

/** longPress performs a CDP touch long-press. */
async function longPress(page: Page, x: number, y: number, ms = 700) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  await page.waitForTimeout(ms)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

/** touchDrag performs a CDP touch drag: press, move to `to` in `steps` steps, release. */
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

/** swipeRow swipes a row horizontally by dx pixels, starting two thirds of the way across. */
async function swipeRow(page: Page, sid: number, dx: number) {
  const b = (await page.getByTestId(`session-${sid}`).boundingBox())!
  const from = { x: b.x + b.width * 0.66, y: b.y + b.height / 2 }
  await touchDrag(page, from, { x: from.x + dx, y: from.y })
}

/** rowShift returns a row body's current horizontal offset (open = -216) after the transition ends. */
async function rowShift(page: Page, sid: number): Promise<number> {
  await page.waitForTimeout(260)
  return page.getByTestId(`session-${sid}`).evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41)
}

/** termGeo captures terminal geometry: rect, cols/rows, resize count. */
async function termGeo(page: Page) {
  return { rect: await rectOf(page, '[data-testid=terminal]'), size: await hooks.size(page), resizes: await hooks.resizes(page) }
}

test.describe('Pixel 5', () => {
  test.use(PIXEL)

  test('E2E-28 (1)(2)(4) session drawer: session count, bottom-anchored full width, grab handle, ✕, fixed bottom row; focus moves into the sheet; terminal not squeezed', async ({ page }) => {
    await agent.open(page)
    await page.waitForTimeout(300) // let the first-screen resize debounce settle
    const before = await termGeo(page)
    const button = page.getByTestId('open-sessions')
    await expect(button, 'sessions button shows the session count').toHaveText('1')

    await button.click()
    await settled(page, 'session-drawer')
    const r = (await rectOf(page, '[data-testid=session-drawer]'))!
    const v = await vp(page)
    expect(Math.abs(r.bottom - v.h), 'anchored to the bottom').toBeLessThanOrEqual(1)
    expect(r.left).toBeLessThanOrEqual(0)
    expect(r.right, 'full width').toBeGreaterThanOrEqual(v.w)
    await expect(page.getByTestId('session-drawer').locator('.drawer-grab'), 'touch shows a grab handle').toBeVisible()
    await expect(page.getByTestId('session-drawer').getByTestId('drawer-close'), 'title bar has ✕').toBeVisible()
    // Fixed bottom row: new session and settings, each with a line icon (ADR-0037).
    const foot = page.getByTestId('session-drawer').locator('.drawer-foot')
    await expect(foot.getByTestId('new-session')).toBeVisible()
    await expect(foot.getByTestId('open-settings')).toBeVisible()
    await expect(foot.locator('button')).toHaveCount(2)
    await expect(foot.locator('button svg')).toHaveCount(2)
    expect(await activeInDrawer(page), 'focus moves into the sheet on open').toBe(true)

    expect(await termGeo(page), 'opening the drawer keeps terminal geometry and sends no resize').toEqual(before)
    await page.getByTestId('drawer-close').click()
    await expect(page.getByTestId('session-drawer')).toHaveCount(0)

    // The session count updates immediately on create and close.
    const b = await newSession(page)
    await expect(button, 'after creating').toHaveText('2')
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
    // Close confirmation: a bottom sheet stacked on the drawer; Esc closes only the top layer (AC-4.11).
    await closeFromMenu()
    const c = (await rectOf(page, '[data-testid=close-confirm]'))!
    expect(Math.abs(c.bottom - v.h), 'confirmation is a bottom sheet too').toBeLessThanOrEqual(1)
    expect(c.right - c.left, 'full width').toBeGreaterThanOrEqual(v.w)
    await expect(page.locator('.drawer'), 'stacked on the session drawer').toHaveCount(2)
    await expect(page.getByTestId('close-confirm')).toContainText('Close "')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('close-confirm')).toHaveCount(0)
    await expect(page.getByTestId('session-drawer'), 'Esc closes only the confirmation; the drawer stays').toBeVisible()
    await expect(page.getByTestId(`session-${b}`)).toBeVisible()
    await closeFromMenu()
    await page.getByTestId('close-ok').click()
    await expect(page.getByTestId(`session-${b}`)).toHaveCount(0)
    await expect(page.getByTestId('session-drawer'), 'still on the list after confirming').toBeVisible()
    await expect(button, 'after closing').toHaveText('1')
    expect(dialogs, 'no browser dialogs').toBe(0)
  })

  test('E2E-28 (3) five ways to close the session drawer: backdrop / Esc / ✕ / selecting a session / back button; history does not accumulate', async ({ page }) => {
    await agent.open(page)
    const sid = (await hooks.sid(page))!
    const h0 = await page.evaluate(() => history.length)
    const drawer = page.getByTestId('session-drawer')

    // Backdrop: tap the empty area above the drawer.
    await openDrawer(page)
    await page.getByTestId('drawer-backdrop').click({ position: { x: 20, y: 20 } })
    await expect(drawer).toHaveCount(0)

    // Esc.
    await openDrawer(page)
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)

    // ✕.
    await openDrawer(page)
    await page.getByTestId('drawer-close').click()
    await expect(drawer).toHaveCount(0)

    // Select a session.
    await openDrawer(page)
    await page.getByTestId(`session-${sid}`).click()
    await expect(drawer).toHaveCount(0)

    // System back button: closes only the drawer and stays on the page.
    await openDrawer(page)
    await page.goBack()
    await expect(drawer).toHaveCount(0)
    expect(new URL(page.url()).pathname, 'still on / after back').toBe('/')
    await expect(page.getByTestId('terminal')).toBeVisible()

    await page.waitForTimeout(300) // history.back() is async
    const h1 = await page.evaluate(() => history.length)
    expect(h1 - h0, `history.length went from ${h0} to ${h1} after five open/close cycles`).toBeLessThanOrEqual(1)
  })

  test("E2E-28 (5) focus restore: if the terminal had focus before opening the drawer, the selected session's terminal gets it; otherwise no one does", async ({ page }) => {
    await agent.open(page)
    const a = (await hooks.sid(page))!
    const b = await newSession(page)
    expect(b).not.toBe(a)

    // Terminal focused -> open drawer -> pick A -> focus on A's helper textarea.
    await focusTerm(page)
    await openDrawer(page)
    expect(await activeInDrawer(page)).toBe(true)
    await page.getByTestId(`session-${a}`).click()
    await waitFor(async () => (await hooks.sid(page)) === a, 'switched to A')
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest('.term-host')?.getAttribute('data-sid') ?? null))
      .toBe(String(a))
    expect(await activeClass(page)).toContain('xterm-helper-textarea')

    // Terminal blurred -> open drawer -> pick B -> focus is not in the terminal (focusing out of
    // nowhere on touch would pop the keyboard).
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await openDrawer(page)
    await page.getByTestId(`session-${b}`).click()
    await waitFor(async () => (await hooks.sid(page)) === b, 'switched to B')
    await page.waitForTimeout(200)
    expect(await activeClass(page), 'terminal was not focused before, so it must not get focus after switching').not.toContain('xterm-helper-textarea')
  })

  test('E2E-28 (6) row actions: swipe left / long-press reveals keep receiving, rename, close; rename is a small sheet stacked on the drawer (ADR-0039)', async ({ page }) => {
    await agent.open(page)
    const a = (await hooks.sid(page))!
    const b = await newSession(page)
    await openDrawer(page)
    const item = (sid: number) => page.getByTestId(`session-${sid}`).locator('xpath=..')

    // Swipe left past halfway -> stays open; less than halfway -> springs back; swipe right when open -> closes.
    await swipeRow(page, b, -120)
    expect(await rowShift(page, b), 'past halfway stays open').toBe(-216)
    for (const t of ['row-pin', 'row-rename', 'row-close']) await expect(item(b).getByTestId(t)).toBeVisible()
    await swipeRow(page, b, 120)
    expect(await rowShift(page, b), 'swipe right closes').toBe(0)
    await swipeRow(page, b, -60)
    expect(await rowShift(page, b), 'less than halfway springs back').toBe(0)
    // A vertical drag opens no row (drag up: dragging down at the top would close the drawer).
    const rb = (await page.getByTestId(`session-${b}`).boundingBox())!
    await touchDrag(page, { x: rb.x + rb.width / 2, y: rb.y + 30 }, { x: rb.x + rb.width / 2 - 6, y: rb.y - 80 })
    expect(await rowShift(page, a)).toBe(0)
    expect(await rowShift(page, b)).toBe(0)

    // Long-press = open, with no anchored menu; swiping another row closes the previous one.
    const box = (await page.getByTestId(`session-${a}`).boundingBox())!
    await longPress(page, box.x + box.width / 2, box.y + box.height / 2)
    expect(await rowShift(page, a), 'long-press also opens').toBe(-216)
    await expect(page.getByTestId('session-menu'), 'the drawer no longer shows an anchored menu').toHaveCount(0)
    await swipeRow(page, b, -150)
    expect(await rowShift(page, b)).toBe(-216)
    expect(await rowShift(page, a), 'only one row open at a time').toBe(0)
    // Tapping the open row's body only closes it; no switch.
    const cur = await hooks.sid(page)
    // The row is shifted 216px; tap the part still on screen (element x beyond 216).
    await page.getByTestId(`session-${b}`).click({ position: { x: 216 + 40, y: 20 } })
    expect(await rowShift(page, b)).toBe(0)
    expect(await hooks.sid(page), 'tapping the body closes without switching').toBe(cur)
    await expect(page.getByTestId('session-drawer')).toBeVisible()

    // Keep receiving.
    await swipeRow(page, b, -150)
    await item(b).getByTestId('row-pin').click()
    await expect(page.getByTestId(`session-${b}`).locator('.pin-mark svg'), 'a pin appears before the name (SVG, ADR-0042)').toBeVisible()
    expect(await rowShift(page, b), 'row closes after tapping an action').toBe(0)

    // Rename: a small sheet stacked on the drawer; the input is focused, fully selected, 16px.
    await swipeRow(page, b, -150)
    await item(b).getByTestId('row-rename').click()
    const sheet = page.getByTestId('rename-sheet')
    await expect(sheet).toBeVisible()
    await expect(page.locator('.drawer'), 'stacked on the drawer').toHaveCount(2)
    const input = page.getByTestId('rename-input')
    await expect(input).toBeFocused()
    const sel = await input.evaluate((el: HTMLInputElement) => ({ s: el.selectionStart, e: el.selectionEnd, n: el.value.length, fs: getComputedStyle(el).fontSize }))
    expect(sel, 'text fully selected on open').toMatchObject({ s: 0, e: sel.n })
    expect(sel.fs).toBe('16px')
    await input.fill('RENAMED')
    await input.press('Enter')
    await expect(sheet).toHaveCount(0)
    await expect(page.getByTestId('session-drawer'), 'renaming does not close the drawer').toBeVisible()
    await expect(page.getByTestId(`session-${b}`).locator('.sl-text')).toHaveText('RENAMED')
    // Saving empty restores the automatic name; Esc closes only the rename sheet.
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
    await expect(page.getByTestId('session-drawer'), 'Esc closes only the rename sheet').toBeVisible()
  })

  test('E2E-28 (9) sheets follow the visible area: when it shrinks, the rename sheet stays on its bottom edge (ADR-0039 §3)', async ({ page }) => {
    await agent.open(page)
    const sid = (await hooks.sid(page))!
    await openDrawer(page)
    await swipeRow(page, sid, -150)
    await page.getByTestId(`session-${sid}`).locator('xpath=..').getByTestId('row-rename').click()
    await settled(page, 'rename-sheet')
    const v = await vp(page)
    // Simulate the keyboard shrinking the visual viewport: the viewport gets shorter and .app follows visualViewport.
    await page.setViewportSize({ width: v.w, height: v.h - 300 })
    await waitFor(async () => {
      const app = (await rectOf(page, '.app'))!
      return Math.abs(app.bottom - (v.h - 300)) <= 1
    }, '.app shrinks with it')
    await page.waitForTimeout(300)
    const app = (await rectOf(page, '.app'))!
    const sheet = (await rectOf(page, '[data-testid=rename-sheet]'))!
    const input = (await rectOf(page, '[data-testid=rename-input]'))!
    expect(Math.abs(sheet.bottom - app.bottom), 'sheet sits on the bottom edge of the visible area').toBeLessThanOrEqual(1)
    expect(input.top).toBeGreaterThanOrEqual(app.top)
    expect(input.bottom, 'input is fully inside the visible area').toBeLessThanOrEqual(app.bottom)
    const drawer = (await rectOf(page, '[data-testid=session-drawer]'))!
    expect(drawer.bottom - drawer.top, 'drawer is at most 80% of the visible area').toBeLessThanOrEqual((app.bottom - app.top) * 0.8 + 1)
  })

  test('E2E-28 (7) session drawer is at least half the screen; bottom row padded on all sides (ADR-0037 §5)', async ({ page }) => {
    await agent.open(page)
    await openDrawer(page)
    const v = await vp(page)
    const d = (await rectOf(page, '[data-testid=session-drawer]'))!
    expect(d.bottom - d.top, 'at least half the screen even with one session').toBeGreaterThanOrEqual(v.h / 2 - 1)
    const foot = (await rectOf(page, '[data-testid=session-drawer] .drawer-foot'))!
    expect(Math.abs(foot.bottom - d.bottom), 'bottom row sits at the bottom of the sheet').toBeLessThanOrEqual(1)
    const n = (await rectOf(page, '[data-testid=session-drawer] [data-testid=new-session]'))!
    const s = (await rectOf(page, '[data-testid=session-drawer] [data-testid=open-settings]'))!
    expect(d.bottom - n.bottom, 'padding between buttons and the sheet bottom').toBeGreaterThanOrEqual(16 - 0.5)
    expect(Math.abs(n.left - d.left - 16), '16px on the left').toBeLessThanOrEqual(1)
    expect(Math.abs(d.right - s.right - 16), '16px on the right').toBeLessThanOrEqual(1)
    expect(Math.abs(s.left - n.right - 12), '12px between buttons').toBeLessThanOrEqual(1)
    expect(Math.round(n.bottom - n.top)).toBe(48)
    expect(Math.round(s.bottom - s.top)).toBe(48)
    expect(Math.round(s.right - s.left), 'settings button is square').toBe(48)
  })

  test('E2E-28 (8) settings from the drawer: drawer closes, settings is a bottom sheet without the half-screen minimum, bottom padding', async ({ page }) => {
    await agent.open(page)
    await openDrawer(page)
    await page.getByTestId('session-drawer').getByTestId('open-settings').click()
    await expect(page.getByTestId('session-drawer')).toHaveCount(0)
    await settled(page, 'settings')
    const v = await vp(page)
    const r = (await rectOf(page, '[data-testid=settings]'))!
    expect(Math.abs(r.bottom - v.h), 'anchored to the bottom').toBeLessThanOrEqual(1)
    expect(r.right - r.left, 'full width').toBeGreaterThanOrEqual(v.w)
    await expect(page.getByTestId('settings').locator('.drawer-grab')).toBeVisible()
    expect(r.bottom - r.top, 'two rows of settings, not stretched to half the screen').toBeLessThan(v.h / 2)
    const inc = (await rectOf(page, '[data-testid=font-inc]'))!
    expect(r.bottom - inc.bottom, 'bottom padding').toBeGreaterThanOrEqual(16)
    await page.mouse.click(v.w / 2, 40) // tap the backdrop
    await expect(page.getByTestId('settings')).toHaveCount(0)
  })

  test('E2E-28 (10) paths render left to right as-is and are clipped on the left when too long; the name takes priority (ADR-0042 §3)', async ({ page }) => {
    // A path that is long and outside the home directory: the leading segments do not fit, but the
    // name `project` must still be shown in full.
    const root = `/tmp/wt-e2e-${process.pid}-${Date.now()}`
    const deep = `${root}/aaaaaaaaaaaa/bbbbbbbbbbbb/cccccccccccc/dddddddddddd/project`
    mkdirSync(deep, { recursive: true })
    try {
      await agent.open(page)
      await submit(page, 'cd /usr/local/share')
      await newSession(page)
      await submit(page, `cd ${FIXTURES}`) // usually under the home directory, so shown as ~/...
      await newSession(page)
      await submit(page, `cd ${deep}`)
      await openDrawer(page)
      const metas = page.locator('.session-row .sl-meta')
      await expect
        .poll(() => metas.allTextContents(), { message: 'paths updated on all three rows' })
        .toEqual([expect.stringMatching(/\/usr\/local\/share$/), expect.stringMatching(/\/fixtures$/), expect.stringMatching(/\/project$/)])

      // Measure where characters are actually drawn: comparing textContent cannot detect rtl reversal.
      const geo = await metas.evaluateAll((els) =>
        els.map((meta) => {
          const node = meta.querySelector('bdi')?.firstChild ?? meta.firstChild!
          const text = node.textContent!
          const at = (i: number) => {
            const r = document.createRange()
            r.setStart(node, i)
            r.setEnd(node, i + 1)
            return r.getBoundingClientRect()
          }
          const box = meta.getBoundingClientRect()
          const first = at(0)
          const last = at(text.length - 1)
          return { text, firstLeft: first.left, lastLeft: last.left, lastRight: last.right, boxLeft: box.left, boxRight: box.right }
        }),
      )
      for (const g of geo) {
        expect(g.firstLeft, `${g.text}: first character is left of the last`).toBeLessThan(g.lastLeft)
        expect(g.lastRight, `${g.text}: end is visible`).toBeLessThanOrEqual(g.boxRight + 0.5)
        expect(g.lastLeft, `${g.text}: end is visible`).toBeGreaterThanOrEqual(g.boxLeft - 0.5)
      }
      expect(geo[2]!.firstLeft, 'long path does not fit: its start is clipped outside the box').toBeLessThan(geo[2]!.boxLeft)

      const names = await page.locator('.session-row .sl-text').evaluateAll((els) =>
        els.map((e) => ({ text: e.textContent, fits: e.scrollWidth <= e.clientWidth })),
      )
      expect(names.map((n) => n.text)).toEqual(['share', 'fixtures', 'project'])
      for (const n of names) expect(n.fits, `name "${n.text}" fully visible`).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
