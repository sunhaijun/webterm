/**
 * E2E-58 Swiping between sessions (AC-4.15, AC-4.8, AC-3.26), ADR-0067.
 *
 * Real CDP touch drags; `WebSocket.send` is hooked to record INPUT frames. A swipe must never
 * send anything to the program, change the terminal size, or switch when it shouldn't.
 */
import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, hooks, newSession, openDrawer, recordSent, submit, switchTo, waitFor } from './harness'

const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
const { defaultBrowserType: _q, ...IPAD } = devices['iPad Mini']!

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

type Pt = { x: number; y: number }

/**
 * touch sends a CDP touch: down at `from`, then one move to each point 16ms apart, then
 * `during` (while the finger is still down), then up.
 */
async function touch(page: Page, from: Pt, path: Pt[], during?: () => Promise<void>) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] })
  for (const p of path) {
    await page.waitForTimeout(16)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] })
  }
  if (during) await during()
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

/** line returns `n` evenly spaced points from `from` (exclusive) to `from + (dx, dy)`. */
function line(from: Pt, dx: number, dy = 0, n = 10): Pt[] {
  return Array.from({ length: n }, (_, i) => ({ x: from.x + (dx * (i + 1)) / n, y: from.y + (dy * (i + 1)) / n }))
}

async function termBox(page: Page) {
  return (await page.getByTestId('terminal').boundingBox())!
}

/** A flick: 140px in ten moves 16ms apart, released at once, through the terminal's middle. */
async function flick(page: Page, dir: 'left' | 'right', dist = 140) {
  const t = await termBox(page)
  const cx = t.x + t.width / 2
  const from = { x: dir === 'left' ? cx + dist / 2 : cx - dist / 2, y: t.y + t.height / 2 }
  await touch(page, from, line(from, dir === 'left' ? -dist : dist))
}

/** A slow drag: like a flick, then 300ms holding still (running `during`), then the release. */
async function slow(page: Page, dx: number, during?: () => Promise<void>) {
  const t = await termBox(page)
  const cx = t.x + t.width / 2
  const from = { x: cx - dx / 2, y: t.y + t.height / 2 }
  await touch(page, from, line(from, dx), async () => {
    await page.waitForTimeout(300)
    if (during) await during()
  })
}

/** hostState reads the mounted terminal host: its transform, running animations and x offset from its resting place. */
async function hostState(page: Page) {
  return page.evaluate(() => {
    const term = document.querySelector('.term') as HTMLElement
    const host = term.querySelector('.term-host') as HTMLElement
    const pad = parseFloat(getComputedStyle(term).paddingLeft)
    return {
      transform: host.style.transform,
      swiping: host.dataset.swiping ?? null,
      animations: host.getAnimations().length,
      offset: host.getBoundingClientRect().left - term.getBoundingClientRect().left - pad,
    }
  })
}

/** settledHost waits until the host is at rest: no transform, no animation. */
async function settledHost(page: Page) {
  await waitFor(async () => {
    const h = await hostState(page)
    return h.transform === '' && h.swiping === null && h.animations === 0 && Math.abs(h.offset) < 0.5
  }, 'terminal host at rest', 3_000)
}

async function expectCurrent(page: Page, sid: number, what: string) {
  await waitFor(async () => (await hooks.sid(page)) === sid, what, 3_000)
  await page.waitForTimeout(150)
  expect(await hooks.sid(page), what).toBe(sid)
}

/** stays asserts the current session is still `sid` a moment after a gesture. */
async function stays(page: Page, sid: number, what: string) {
  await page.waitForTimeout(350)
  expect(await hooks.sid(page), what).toBe(sid)
  await settledHost(page)
}

async function closeDrawer(page: Page) {
  if (await page.getByTestId('session-drawer').count()) {
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('session-drawer')).toHaveCount(0)
  }
}

/** Three sessions A, B, C in that order, B current. */
async function threeSessions(page: Page) {
  const a = (await hooks.sid(page))!
  const b = await newSession(page)
  const c = await newSession(page)
  await switchTo(page, b)
  await closeDrawer(page)
  await settledHost(page)
  return { a, b, c }
}

test.describe('Pixel 5', () => {
  test.use(PIXEL)

  test('E2E-58 (1)-(5) next and previous, no wrapping, the label and distance, changing your mind, and what is not a swipe', async ({ page }) => {
    const rec = await recordSent(page)
    await agent.open(page)
    const { a, b, c } = await threeSessions(page)
    const peek = page.getByTestId('swipe-peek')
    const resizes = await hooks.resizes(page)
    const sent = (await rec.input()).length

    // (1) Flick left: next; flick right: previous
    await flick(page, 'left')
    await expectCurrent(page, c, 'flick left: next session')
    await settledHost(page)
    await expect(peek).toBeHidden()
    await flick(page, 'right')
    await expectCurrent(page, b, 'flick right: previous session')
    await flick(page, 'right')
    await expectCurrent(page, a, 'flick right again: the first session')
    await settledHost(page)
    expect(await hooks.resizes(page), 'switching by swipe sends no resize').toBe(resizes)
    expect((await rec.input()).slice(sent), 'a swipe sends nothing to the program').toEqual([])

    // (2) The ends resist and don't wrap
    const t = await termBox(page)
    let from = { x: t.x + 100, y: t.y + t.height / 2 }
    await touch(page, from, line(from, 150), async () => {
      const h = await hostState(page)
      expect(h.offset, `resisting at the first session (${h.offset}px)`).toBeGreaterThan(0)
      expect(h.offset).toBeLessThan(75)
      await expect(peek).toBeHidden()
    })
    await stays(page, a, 'no session before the first: no wrap')
    await flick(page, 'left')
    await expectCurrent(page, b, 'to B')
    await flick(page, 'left')
    await expectCurrent(page, c, 'to C')
    from = { x: t.x + t.width - 100, y: t.y + t.height / 2 }
    await touch(page, from, line(from, -150), async () => {
      const h = await hostState(page)
      expect(h.offset, `resisting at the last session (${h.offset}px)`).toBeLessThan(0)
      expect(h.offset).toBeGreaterThan(-75)
    })
    await stays(page, c, 'no session after the last: no wrap')

    // (3) The label, and switching by distance (98px on a 393px phone)
    await switchTo(page, a)
    await closeDrawer(page)
    await openDrawer(page)
    const bName = (await page.getByTestId(`session-${b}`).locator('.sl-text').textContent())!.trim()
    await closeDrawer(page)
    await slow(page, -60, async () => {
      await expect(peek).toBeVisible()
      await expect(peek).toContainText('[2]')
      await expect(peek).toContainText(bName)
      await expect(peek).not.toHaveAttribute('data-ready', 'true')
    })
    await stays(page, a, '60px held still: not far enough')
    await slow(page, -130, async () => {
      await expect(peek).toHaveAttribute('data-ready', 'true')
    })
    await expectCurrent(page, b, '130px held still: far enough')
    await settledHost(page)

    // (4) Changing your mind: far enough, but heading back at release. Two big steps back, so
    // the speed reads as heading back even where CDP moves land 60-100ms apart.
    from = { x: t.x + t.width - 60, y: t.y + t.height / 2 }
    const out = line(from, -220)
    await touch(page, from, [...out, ...line(out.at(-1)!, 100, 0, 2)])
    await stays(page, b, 'released while heading back')

    // (5) Not a swipe: diagonal, from the edges, too short, a second finger
    from = { x: t.x + t.width / 2 + 60, y: t.y + 120 }
    await touch(page, from, line(from, -120, 70), async () => {
      expect((await hostState(page)).transform, 'a diagonal drag moves nothing').toBe('')
    })
    await stays(page, b, 'diagonal')
    const vw = page.viewportSize()!.width
    from = { x: vw - 10, y: t.y + t.height / 2 }
    await touch(page, from, line(from, -140))
    await stays(page, b, 'from the right edge')
    from = { x: 10, y: t.y + t.height / 2 }
    await touch(page, from, line(from, 140))
    await stays(page, b, 'from the left edge')
    await flick(page, 'left', 30)
    await stays(page, b, 'a 30px flick')
    from = { x: t.x + t.width / 2 + 65, y: t.y + t.height / 2 }
    const path = line(from, -130)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] })
    for (const p of path) {
      await page.waitForTimeout(16)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] })
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [path.at(-1)!, { x: from.x, y: from.y + 150 }] })
    await page.waitForTimeout(50)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await cdp.detach()
    await stays(page, b, 'a second finger cancels')

    expect(await hooks.resizes(page), 'no resize from any of it').toBe(resizes)
    expect((await rec.input()).slice(sent), 'nothing sent to the program').toEqual([])
  })

  test('E2E-58 (6)-(8) focus follows, the collapsed keys keep their band, and mouse tracking sees nothing', async ({ page }) => {
    const rec = await recordSent(page)
    await agent.open(page)
    const { b, c } = await threeSessions(page)
    const t = await termBox(page)
    const centre = { x: t.x + t.width / 2, y: t.y + t.height / 2 }
    const inMountedTextarea = () =>
      page.evaluate(() => {
        const el = document.activeElement
        return !!el && el.classList.contains('xterm-helper-textarea') && el.closest('.term-host') === document.querySelector('.term .term-host')
      })
    const anyTextarea = () => page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea') === true)

    // (6) Focus follows the session
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await touch(page, centre, [])
    await waitFor(inMountedTextarea, 'a tap focuses the terminal', 3_000)
    await flick(page, 'left')
    await expectCurrent(page, c, 'flick left to C')
    expect(await inMountedTextarea(), "focus moved to C's terminal").toBe(true)
    await touch(page, centre, [])
    await waitFor(async () => !(await anyTextarea()), 'a tap blurs', 3_000)
    await flick(page, 'right')
    await expectCurrent(page, b, 'flick right to B')
    expect(await anyTextarea(), 'not focused before, not focused after').toBe(false)

    // (7) Collapsed keys: the bottom band restores them; above it, the swipe switches
    const ek = page.getByTestId('extrakeys')
    const collapse = async () => {
      const k = (await page.locator('.ek-main').boundingBox())!
      const from = { x: k.x + 40, y: k.y + k.height / 2 }
      await touch(page, from, line(from, 140))
      await expect(ek).toHaveAttribute('data-collapsed', 'true')
      await page.waitForTimeout(300)
    }
    await collapse()
    let box = await termBox(page)
    let from = { x: 200, y: box.y + box.height - 30 }
    await touch(page, from, line(from, -140))
    await expect(ek).not.toHaveAttribute('data-collapsed', 'true')
    await stays(page, b, 'the restore band restores, it does not switch')
    await collapse()
    await flick(page, 'left')
    await expectCurrent(page, c, 'above the band, a swipe switches')
    const rb = (await page.getByTestId('keys-restore').boundingBox())!
    await touch(page, { x: rb.x + rb.width / 2, y: rb.y + rb.height / 2 }, [])
    await expect(ek).not.toHaveAttribute('data-collapsed', 'true')

    // (8) Under mouse tracking a swipe still switches and sends nothing
    await switchTo(page, b)
    await closeDrawer(page)
    await submit(page, "printf '\\033[?1000h\\033[?1006h'; sleep 60")
    await page.waitForTimeout(800)
    const n = (await rec.input()).length
    await flick(page, 'left')
    await expectCurrent(page, c, 'swipe under mouse tracking')
    await page.waitForTimeout(300)
    expect((await rec.input()).slice(n), 'no mouse report, no wheel').toEqual([])
  })
})

test.describe('iPad Mini', () => {
  test.use(IPAD)

  test('E2E-58 (9) a touch tablet swipes too, and the tab follows', async ({ page }) => {
    await agent.open(page)
    const first = (await hooks.sid(page))!
    const second = await newSession(page)
    expect(await hooks.form(page)).toBe('wide')
    await settledHost(page)
    // 768px wide: switching by distance needs 160px; 200px is far enough whatever the speed
    await flick(page, 'right', 200)
    await expectCurrent(page, first, 'flick right to the first session')
    await expect(page.getByTestId(`tab-${first}`)).toHaveAttribute('aria-current', 'true')
    await expect(page.getByTestId(`tab-${second}`)).not.toHaveAttribute('aria-current', 'true')
  })
})

test('E2E-58 (10) a mouse drag across the terminal is not a swipe', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await agent.open(page)
  await newSession(page)
  const sid = (await hooks.sid(page))!
  const t = await termBox(page)
  await page.mouse.move(t.x + t.width / 2 + 100, t.y + t.height / 2)
  await page.mouse.down()
  await page.mouse.move(t.x + t.width / 2 - 100, t.y + t.height / 2, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(350)
  expect(await hooks.sid(page)).toBe(sid)
})
