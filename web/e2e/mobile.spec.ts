/**
 * E2E-10 Phone layout and extra keys (AC-3.18 / AC-3.20, plus safe-area and landscape geometry,
 * layout.md "Safe area").
 *
 * Pixel 5 (touch). `WebSocket.send` is hooked to record INPUT frames, so assertions are on the bytes
 * on the wire. Assert sizes, not just existence: an element with the right class and text can still
 * be invisible to the user.
 */
import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, EMIT, focusTerm, hooks, recordSent, rectOf, submit, waitFor, waitText, type SentRecorder } from './harness'

const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
test.use(PIXEL)

/** DOM order: each row's seven keys, then that row's key of the last column (ADR-0054). */
const KEY_IDS = [
  'Escape',
  'Slash',
  'Minus',
  'Home',
  'ArrowUp',
  'End',
  'PageUp',
  'frequent',
  'Tab',
  'Ctrl',
  'Alt',
  'ArrowLeft',
  'ArrowDown',
  'ArrowRight',
  'PageDown',
  'combos',
]

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

/** keyOrder returns the key test IDs in the key area, in DOM order. */
const keyOrder = (p: Page) =>
  p.evaluate(() => [...document.querySelectorAll('[data-testid=extrakeys] .ek-key')].map((e) => (e as HTMLElement).dataset.testid))

/** allKeysVisible asserts all 16 keys (14 plus the last column's two) are inside the viewport and the key area does not scroll horizontally. */
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
  expect(g.scrollW, 'key area does not scroll horizontally').toBeLessThanOrEqual(g.clientW + 1)
  expect(g.out.length).toBe(16)
  for (const k of g.out) expect(k.ok, `${k.id} should lie entirely within the viewport (${k.r})`).toBe(true)
}

/** press taps an extra key and returns the INPUT frames it sent, concatenated as hex. */
async function press(page: Page, rec: SentRecorder, id: string): Promise<string> {
  const before = (await rec.inputHex()).length
  const n0 = (await hooks.inputStats(page)).data.n
  await page.getByTestId(`key-${id}`).tap()
  await waitFor(async () => (await rec.inputHex()).length > before, `key-${id} sent bytes`, 5_000)
  await page.waitForTimeout(50)
  expect((await hooks.inputStats(page)).data.n, `key-${id} goes out through onData (inputStats.data increases)`).toBeGreaterThan(n0)
  return (await rec.inputHex()).slice(before).join('')
}

const active = (p: Page) => p.evaluate(() => (document.activeElement as HTMLElement | null)?.className ?? '')

/** touch sends a real CDP touch sequence (start -> move* -> end). */
async function touch(page: Page, points: { x: number; y: number }[], holdMs = 0) {
  const cdp = await page.context().newCDPSession(page)
  const [first, ...rest] = points
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first!] })
  for (const p of rest) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] })
  if (holdMs) await page.waitForTimeout(holdMs)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

test('E2E-10 (1)(2) structure: compact, no tab bar, 80px extra keys below the terminal, all 16 keys visible without horizontal scrolling', async ({ page }) => {
  await agent.open(page)

  await expect(page.locator('.app')).toHaveAttribute('data-form', 'compact')
  await expect(page.getByTestId('tabbar')).toHaveCount(0)

  const term = (await rectOf(page, '[data-testid=terminal]'))!
  const keys = (await rectOf(page, '[data-testid=extrakeys]'))!
  expect(keys.height, 'extra keys area is 80px tall').toBe(80)
  expect(keys.top, 'extra keys are below the terminal').toBeGreaterThanOrEqual(term.bottom - 1)
  expect(term.height, 'terminal gets the remaining height').toBeGreaterThan(400)

  // Side column: sessions button on top, ✎ below.
  const side = await page.evaluate(() => [...document.querySelectorAll('.ek-side > *')].map((e) => (e as HTMLElement).dataset.testid))
  expect(side).toEqual(['open-sessions', 'toggle-text'])
  const sessions = (await rectOf(page, '[data-testid=open-sessions]'))!
  const toggle = (await rectOf(page, '[data-testid=toggle-text]'))!
  expect(sessions.top).toBeLessThan(toggle.top)
  expect(sessions.right, 'side column is left of the keys').toBeLessThanOrEqual((await rectOf(page, '[data-testid=key-Escape]'))!.left + 1)

  expect(await keyOrder(page)).toEqual(KEY_IDS.map((k) => `key-${k}`))
  await allKeysVisible(page)

  // The page does not scroll.
  const doc = await page.evaluate(() => ({ h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth, vh: innerHeight, vw: innerWidth }))
  expect(doc.h).toBeLessThanOrEqual(doc.vh + 1)
  expect(doc.w).toBeLessThanOrEqual(doc.vw + 1)
})

test('E2E-10 (3) static keys: layout unchanged while a command runs, while less is on screen, and after quitting less', async ({ page }) => {
  await agent.open(page)
  const want = KEY_IDS.map((k) => `key-${k}`)

  await submit(page, 'sleep 30')
  await page.waitForTimeout(500)
  expect(await keyOrder(page), 'sleep running').toEqual(want)
  await page.keyboard.press('Control+c')

  await submit(page, 'seq 1 500 | less')
  await waitFor(async () => hooks.altScreen(page), 'less on screen (alternate screen)')
  expect(await keyOrder(page), 'less on screen').toEqual(want)

  await page.keyboard.press('q')
  await waitFor(async () => !(await hooks.altScreen(page)), 'quit less')
  expect(await keyOrder(page), 'after quitting less').toEqual(want)
})

test('E2E-10 (4)(5) bytes: ESC, Up, and Up and HOME under DECCKM; keys do not steal focus', async ({ page }) => {
  const rec = await recordSent(page)
  await agent.open(page)

  // (5) No focus stealing: with the terminal focused, focus stays put after pressing TAB.
  await focusTerm(page)
  const before = await active(page)
  expect(before).toContain('xterm-helper-textarea')
  expect(await press(page, rec, 'Tab')).toBe('09')
  expect(await active(page), 'pressing an extra key must not move focus').toBe(before)
  await page.keyboard.press('Control+c') // clear anything Tab completion left behind

  // (4) Bytes.
  expect(await press(page, rec, 'Escape')).toBe('1b')
  expect(await press(page, rec, 'ArrowUp')).toBe('1b5b41')

  // With DECCKM on, arrows and HOME change (mode is read at keypress, not cached).
  await page.keyboard.press('Control+c')
  await submit(page, "printf '\\033[?1h'; printf 'CKM-%s\\n' ON")
  await waitText(page, /^CKM-ON/m)
  expect(await press(page, rec, 'ArrowUp'), 'Up under DECCKM = ESC O A').toBe('1b4f41')
  expect(await press(page, rec, 'Home'), 'HOME under DECCKM = ESC O H').toBe('1b4f48')

  await page.keyboard.press('Control+c')
  await submit(page, "printf '\\033[?1l'; printf 'CKM-%s\\n' OFF")
  await waitText(page, /^CKM-OFF/m)
  expect(await press(page, rec, 'ArrowUp'), 'after reset, Up = ESC [ A').toBe('1b5b41')
  expect(await press(page, rec, 'Home'), 'after reset, HOME = ESC [ H').toBe('1b5b48')
})

test('E2E-10 (6)(7) sticky CTRL: a tap applies to the next key only (on-screen keyboard included), long-press locks, another tap unlocks', async ({ page }) => {
  const rec = await recordSent(page)
  await agent.open(page)
  await focusTerm(page)
  const ctrl = page.getByTestId('key-Ctrl')

  // (6) Tap -> armed; type c on the on-screen keyboard -> 0x03, then it disarms.
  await ctrl.tap()
  await expect(ctrl).toHaveAttribute('data-sticky', 'armed')
  let n = (await rec.inputHex()).length
  await page.keyboard.type('c')
  await waitFor(async () => (await rec.inputHex()).length > n, 'bytes sent')
  expect((await rec.inputHex()).slice(n).join('')).toBe('03')
  await expect(ctrl).toHaveAttribute('data-sticky', 'off')

  // Tap CTRL then Left -> ESC[1;5D.
  await ctrl.tap()
  await expect(ctrl).toHaveAttribute('data-sticky', 'armed')
  expect(await press(page, rec, 'ArrowLeft')).toBe('1b5b313b3544')
  await expect(ctrl).toHaveAttribute('data-sticky', 'off')

  // (7) Long-press (> 500ms) -> locked; c then u -> 03 15. (Not d: ^D at an empty prompt exits bash.)
  const box = (await ctrl.boundingBox())!
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await touch(page, [at], 700)
  await expect(ctrl).toHaveAttribute('data-sticky', 'locked')
  n = (await rec.inputHex()).length
  await page.keyboard.type('c')
  await page.keyboard.type('u')
  await waitFor(async () => (await rec.inputHex()).length >= n + 2, 'both keys sent')
  expect((await rec.inputHex()).slice(n)).toEqual(['03', '15'])
  await expect(ctrl, 'locked state applies to every key').toHaveAttribute('data-sticky', 'locked')

  await ctrl.tap()
  await expect(ctrl).toHaveAttribute('data-sticky', 'off')
})

test('E2E-10 (8) tapping the terminal: tap focuses, tap again blurs, a drag is not a tap; with mouse tracking on, taps go to the program', async ({ page }) => {
  const rec = await recordSent(page)
  await agent.open(page)
  const t = (await rectOf(page, '[data-testid=terminal]'))!
  const mid = { x: t.left + t.width / 2, y: t.top + t.height / 2 }

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  expect(await active(page)).not.toContain('xterm-helper-textarea')

  await touch(page, [mid])
  await expect.poll(() => active(page), { message: "tap -> focus moves to xterm's helper textarea" }).toContain('xterm-helper-textarea')
  await touch(page, [mid])
  await expect.poll(() => active(page), { message: 'tap again -> focus leaves' }).not.toContain('xterm-helper-textarea')

  // A 30px vertical drag scrolls and does not change focus.
  const off = await active(page)
  await touch(page, [mid, { x: mid.x, y: mid.y + 10 }, { x: mid.x, y: mid.y + 20 }, { x: mid.x, y: mid.y + 30 }])
  await page.waitForTimeout(200)
  expect(await active(page), 'a drag is not a tap').toBe(off)

  // Mouse tracking on: a tap is reported by xterm and focus does not change.
  await focusTerm(page)
  await submit(page, "printf '\\033[?1000h'; printf 'MOUSE-%s\\n' ON")
  await waitText(page, /^MOUSE-ON/m)
  const focusedBefore = await active(page)
  const n = (await rec.inputHex()).length
  await touch(page, [mid])
  await waitFor(async () => (await rec.inputHex()).slice(n).some((h) => h.startsWith('1b5b4d')), 'mouse report (ESC [ M) in INPUT frames', 5_000)
  expect(await active(page), 'with mouse tracking, tapping the terminal does not toggle focus').toBe(focusedBefore)

  // Reset: first clear the bytes the report left on the command line.
  await page.keyboard.press('Control+c')
  await submit(page, "printf '\\033[?1000l'")
})

test('E2E-10 (8) continued: vertical drag uses xterm touch scrolling and scrolls the full distance, not just the first frame', async ({ page }) => {
  await agent.open(page)
  await submit(page, `${EMIT} 300 0`)
  await waitText(page, 'EMIT-DONE')
  const t = (await rectOf(page, '[data-testid=terminal]'))!
  const x = t.left + t.width / 2
  const y0 = t.top + 60
  const before = (await hooks.viewport(page)).y
  // Drag down 160px (20 frames of 8px): content scrolls back. The DOM renderer replaces the row
  // element under the finger while scrolling; once the touch target leaves the document, later
  // touchmoves never reach xterm (before the fix, only the first frame scrolled).
  const pts = Array.from({ length: 21 }, (_, i) => ({ x, y: y0 + i * 8 }))
  await touch(page, pts)
  await page.waitForTimeout(300)
  const rowH = t.height / (await hooks.size(page)).rows
  const moved = before - (await hooks.viewport(page)).y
  expect(moved, `dragged 160px (~${Math.round(160 / rowH)} rows) but scrolled only ${moved} rows`).toBeGreaterThanOrEqual(Math.floor(160 / rowH) - 2)
})

test('E2E-10 (9) safe area: --sa-top / --sa-bottom apply to .app, the terminal shrinks by exactly 81px, the page does not overflow', async ({ page }) => {
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
  expect(inset.appH, '.app height unchanged').toBe(base.appH)
  expect(inset.appBottom - inset.keysBottom, 'extra keys bottom edge is 34px above the .app bottom').toBe(34)
  expect(base.termH - inset.termH, 'terminal is exactly 47 + 34 shorter').toBe(81)
  expect(inset.scrollH, 'page does not overflow').toBeLessThanOrEqual(inset.vh + 1)

  await page.evaluate(() => (document.querySelector('.app') as HTMLElement).style.removeProperty('--sa-bottom'))
  await expect.poll(async () => (await geo()).keysBottom).toBe(base.keysBottom)
  expect((await geo()).termH, 'with --sa-bottom cleared only the 47px top inset remains').toBe(base.termH - 47)
})

test('E2E-10 (10) landscape (viewport and screen both 851×393): still compact, 80px extra keys, all 16 keys visible', async ({ browser }) => {
  const ctx = await browser.newContext({ ...PIXEL, viewport: { width: 851, height: 393 }, screen: { width: 851, height: 393 } })
  const page = await ctx.newPage()
  await agent.open(page)
  await expect(page.locator('.app')).toHaveAttribute('data-form', 'compact')
  expect((await rectOf(page, '[data-testid=extrakeys]'))!.height).toBe(80)
  await allKeysVisible(page)
  await ctx.close()
})
