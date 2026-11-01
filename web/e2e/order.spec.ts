/**
 * E2E-45 Drag to reorder (AC-4.13, ADR-0040).
 *
 * The order lives on the agent: the client sends session.move{sid, before} and the agent broadcasts
 * session.order{sids}. Wide with a mouse: press a tab and move sideways. Touch tablet: long-press,
 * then move. Compact: use the drag handle in the drawer.
 */
import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, hooks, newSession, openDrawer, recordSent, settled, waitFor } from './harness'

const WIDE = { viewport: { width: 1440, height: 900 }, contextOptions: { screen: { width: 1440, height: 900 } } }
const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
const { defaultBrowserType: _q, ...IPAD } = devices['iPad Mini']!
test.setTimeout(120_000)

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

const tabOrder = (p: Page) => p.locator('.tabbar .tab').evaluateAll((els) => els.map((e) => Number((e as HTMLElement).dataset.sid)))
const rowOrder = (p: Page) => p.locator('.session-list .session-row').evaluateAll((els) => els.map((e) => Number((e as HTMLElement).dataset.sid)))

/** mouseDragTab presses the center of tab `sid`, moves to x in a few steps, and releases. */
async function mouseDragTab(page: Page, sid: number, toX: number, opts: { escape?: boolean } = {}) {
  const b = (await page.getByTestId(`tab-${sid}`).boundingBox())!
  const y = b.y + b.height / 2
  await page.mouse.move(b.x + b.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(toX, y, { steps: 12 })
  if (opts.escape) await page.keyboard.press('Escape')
  await page.mouse.up()
}

async function touchDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, holdMs = 0, steps = 10) {
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

test.describe('wide, mouse', () => {
  test.use(WIDE)

  test('E2E-45 (1)(2)(3)(6) drag tabs to reorder; Esc cancels; order lives on the agent (reload, second device); keyboard switching follows the new order', async ({ page, browser }) => {
    const sent = await recordSent(page)
    const orders: { sids: number[] }[] = []
    page.on('websocket', (ws) =>
      ws.on('framereceived', (f) => {
        if (typeof f.payload === 'string' && f.payload.includes('"session.order"')) orders.push(JSON.parse(f.payload))
      }),
    )
    await agent.open(page)
    const a = (await hooks.sid(page))!
    const b = await newSession(page)
    const c = await newSession(page)
    expect(await tabOrder(page)).toEqual([a, b, c])

    // (1) Drag C past A's midline -> C A B; current session unchanged; one session.move sent, session.order received.
    await sent.clear()
    const ra = (await page.getByTestId(`tab-${a}`).boundingBox())!
    await mouseDragTab(page, c, ra.x + ra.width / 2 - 20)
    await expect.poll(() => tabOrder(page)).toEqual([c, a, b])
    const idxs = await Promise.all([c, a, b].map((s) => page.getByTestId(`tab-${s}-idx`).textContent()))
    expect(idxs, 'tab numbers follow the new order (ADR-0041)').toEqual(['[1]', '[2]', '[3]'])
    expect(await hooks.sid(page), 'dragging does not switch sessions').toBe(c)
    const moves = (await sent.ctl()).filter((m) => m.t === 'session.move')
    expect(moves).toMatchObject([{ sid: c, before: a }])
    await expect.poll(() => orders.length, { message: 'session.order received' }).toBeGreaterThan(0)
    expect(orders.at(-1)).toMatchObject({ sids: [c, a, b] })

    // Moving 3px and releasing is a click (switches to B) and sends no session.move.
    await sent.clear()
    const rb = (await page.getByTestId(`tab-${b}`).boundingBox())!
    await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2)
    await page.mouse.down()
    await page.mouse.move(rb.x + rb.width / 2 + 3, rb.y + rb.height / 2)
    await page.mouse.up()
    await waitFor(async () => (await hooks.sid(page)) === b, 'it was a click: switched to B')
    expect((await sent.ctl()).filter((m) => m.t === 'session.move')).toHaveLength(0)

    // (2) Drag A right past B and press Esc before releasing -> back in place, nothing sent.
    await sent.clear()
    await mouseDragTab(page, a, rb.x + rb.width / 2 + 40, { escape: true })
    await page.waitForTimeout(300)
    expect(await tabOrder(page)).toEqual([c, a, b])
    expect((await sent.ctl()).filter((m) => m.t === 'session.move'), 'Esc cancels without sending').toHaveLength(0)

    // (3) Still C A B after reload and on a second device; another drag on the first device reaches
    // the second without a reload.
    await page.reload()
    await expect.poll(() => tabOrder(page)).toEqual([c, a, b])
    const ctx2 = await browser.newContext({ viewport: WIDE.viewport, screen: WIDE.contextOptions.screen })
    const page2 = await ctx2.newPage()
    await agent.open(page2)
    await expect.poll(() => tabOrder(page2), { message: 'second device' }).toEqual([c, a, b])
    const strip = (await page.getByTestId('tabbar').boundingBox())!
    await mouseDragTab(page, a, strip.x + strip.width + 200) // drag to the end
    await expect.poll(() => tabOrder(page)).toEqual([c, b, a])
    await expect.poll(() => tabOrder(page2), { message: 'broadcast to the second device' }).toEqual([c, b, a])
    await ctx2.close()

    // (6) Keyboard switching follows the new order: from C, Ctrl+Shift+Down goes to B.
    await page.getByTestId(`tab-${c}`).click()
    await waitFor(async () => (await hooks.sid(page)) === c, 'switched to C')
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.press('Control+Shift+ArrowDown')
    await waitFor(async () => (await hooks.sid(page)) === b, 'next is B')
  })
})

test.describe('compact, drag handle', () => {
  test.use(PIXEL)

  test('E2E-45 (4) vertical drag on the drawer handle reorders; vertical drag on the row body scrolls without reordering', async ({ page }) => {
    await agent.open(page)
    const a = (await hooks.sid(page))!
    const b = await newSession(page)
    const c = await newSession(page)
    await openDrawer(page)
    expect(await rowOrder(page)).toEqual([a, b, c])
    for (const sid of [a, b, c]) await expect(page.getByTestId(`session-${sid}-grip`)).toBeVisible()

    const g = (await page.getByTestId(`session-${c}-grip`).boundingBox())!
    const ra = (await page.getByTestId(`session-${a}`).boundingBox())!
    await touchDrag(page, { x: g.x + g.width / 2, y: g.y + g.height / 2 }, { x: g.x + g.width / 2, y: ra.y + 4 })
    await expect.poll(() => rowOrder(page)).toEqual([c, a, b])
    await expect(page.getByTestId(`session-${c}`).locator('.sl-idx')).toHaveText('[1]')
    await expect(page.getByTestId('session-drawer'), 'drawer stays open and the session does not switch').toBeVisible()

    // Drag the row body upward: scrolls the list, order unchanged.
    const rb = (await page.getByTestId(`session-${b}`).boundingBox())!
    await touchDrag(page, { x: rb.x + 60, y: rb.y + 26 }, { x: rb.x + 64, y: rb.y - 60 })
    await page.waitForTimeout(300)
    expect(await rowOrder(page)).toEqual([c, a, b])
    await settled(page, 'session-drawer')
  })
})

test.describe('touch tablet', () => {
  test.use(IPAD)

  test('E2E-45 (5) long-press a tab then move without releasing = drag; long-press and release in place = session menu', async ({ page }) => {
    await agent.open(page)
    const a = (await hooks.sid(page))!
    const b = await newSession(page)
    expect(await tabOrder(page)).toEqual([a, b])
    const ra = (await page.getByTestId(`tab-${a}`).boundingBox())!
    const rb = (await page.getByTestId(`tab-${b}`).boundingBox())!
    await touchDrag(page, { x: ra.x + ra.width / 2, y: ra.y + ra.height / 2 }, { x: rb.x + rb.width - 10, y: rb.y + rb.height / 2 }, 700)
    await expect.poll(() => tabOrder(page)).toEqual([b, a])
    await expect(page.getByTestId('session-menu'), 'a drag opens no menu').toHaveCount(0)

    const r = (await page.getByTestId(`tab-${a}`).boundingBox())!
    await touchDrag(page, { x: r.x + r.width / 2, y: r.y + r.height / 2 }, { x: r.x + r.width / 2, y: r.y + r.height / 2 }, 700, 1)
    await expect(page.getByTestId('session-menu'), 'release in place = menu').toBeVisible()
  })
})
