/**
 * E2E-45 拖动排序 —— AC-4.13，ADR-0040。
 *
 * 顺序存在 agent：client 发 session.move{sid, before}，agent 广播 session.order{sids}。
 * wide 鼠标按住标签横移；触屏 Pad 长按后移动；compact 抽屉用拖动柄。
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

/** 鼠标按住 from 标签的中心，分几步横移到 x，松手。 */
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

test.describe('wide 鼠标', () => {
  test.use(WIDE)

  test('E2E-45 ①②③⑥ 拖标签排序；Esc 取消；顺序在 agent 上（刷新、第二台设备）；键盘切换按新顺序', async ({ page, browser }) => {
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

    // ① C 拖过 A 的中线 → C A B；当前不变；发一条 session.move，收到 session.order
    await sent.clear()
    const ra = (await page.getByTestId(`tab-${a}`).boundingBox())!
    await mouseDragTab(page, c, ra.x + ra.width / 2 - 20)
    await expect.poll(() => tabOrder(page)).toEqual([c, a, b])
    const idxs = await Promise.all([c, a, b].map((s) => page.getByTestId(`tab-${s}-idx`).textContent()))
    expect(idxs, '标签上的编号跟着新顺序（ADR-0041）').toEqual(['[1]', '[2]', '[3]'])
    expect(await hooks.sid(page), '拖完不切换').toBe(c)
    const moves = (await sent.ctl()).filter((m) => m.t === 'session.move')
    expect(moves).toMatchObject([{ sid: c, before: a }])
    await expect.poll(() => orders.length, { message: '收到 session.order' }).toBeGreaterThan(0)
    expect(orders.at(-1)).toMatchObject({ sids: [c, a, b] })

    // 横移 3px 松手 = 点击（切到 B），不发 session.move
    await sent.clear()
    const rb = (await page.getByTestId(`tab-${b}`).boundingBox())!
    await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2)
    await page.mouse.down()
    await page.mouse.move(rb.x + rb.width / 2 + 3, rb.y + rb.height / 2)
    await page.mouse.up()
    await waitFor(async () => (await hooks.sid(page)) === b, '是点击：切到 B')
    expect((await sent.ctl()).filter((m) => m.t === 'session.move')).toHaveLength(0)

    // ② A 往右拖过 B，不松手按 Esc → 回到原位，不发
    await sent.clear()
    await mouseDragTab(page, a, rb.x + rb.width / 2 + 40, { escape: true })
    await page.waitForTimeout(300)
    expect(await tabOrder(page)).toEqual([c, a, b])
    expect((await sent.ctl()).filter((m) => m.t === 'session.move'), 'Esc 取消不发').toHaveLength(0)

    // ③ 刷新后仍是 C A B；第二台设备一样；在第一台再拖一次，第二台不刷新就跟上
    await page.reload()
    await expect.poll(() => tabOrder(page)).toEqual([c, a, b])
    const ctx2 = await browser.newContext({ viewport: WIDE.viewport, screen: WIDE.contextOptions.screen })
    const page2 = await ctx2.newPage()
    await agent.open(page2)
    await expect.poll(() => tabOrder(page2), { message: '第二台设备' }).toEqual([c, a, b])
    const strip = (await page.getByTestId('tabbar').boundingBox())!
    await mouseDragTab(page, a, strip.x + strip.width + 200) // 拖到最后
    await expect.poll(() => tabOrder(page)).toEqual([c, b, a])
    await expect.poll(() => tabOrder(page2), { message: '广播到第二台' }).toEqual([c, b, a])
    await ctx2.close()

    // ⑥ 键盘切换按新顺序：当前 C → Ctrl+Shift+↓ 到 B
    await page.getByTestId(`tab-${c}`).click()
    await waitFor(async () => (await hooks.sid(page)) === c, '切到 C')
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.press('Control+Shift+ArrowDown')
    await waitFor(async () => (await hooks.sid(page)) === b, '下一个是 B')
  })
})

test.describe('compact 拖动柄', () => {
  test.use(PIXEL)

  test('E2E-45 ④ 抽屉里按住拖动柄纵向拖；按住正文纵向拖是滚动、不改顺序', async ({ page }) => {
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
    await expect(page.getByTestId('session-drawer'), '拖完抽屉还在、没切会话').toBeVisible()

    // 按住正文往上拖：滚动列表，不改顺序
    const rb = (await page.getByTestId(`session-${b}`).boundingBox())!
    await touchDrag(page, { x: rb.x + 60, y: rb.y + 26 }, { x: rb.x + 64, y: rb.y - 60 })
    await page.waitForTimeout(300)
    expect(await rowOrder(page)).toEqual([c, a, b])
    await settled(page, 'session-drawer')
  })
})

test.describe('触屏 Pad', () => {
  test.use(IPAD)

  test('E2E-45 ⑤ 长按标签后不松手横移 = 拖；长按原地松手 = 会话菜单', async ({ page }) => {
    await agent.open(page)
    const a = (await hooks.sid(page))!
    const b = await newSession(page)
    expect(await tabOrder(page)).toEqual([a, b])
    const ra = (await page.getByTestId(`tab-${a}`).boundingBox())!
    const rb = (await page.getByTestId(`tab-${b}`).boundingBox())!
    await touchDrag(page, { x: ra.x + ra.width / 2, y: ra.y + ra.height / 2 }, { x: rb.x + rb.width - 10, y: rb.y + rb.height / 2 }, 700)
    await expect.poll(() => tabOrder(page)).toEqual([b, a])
    await expect(page.getByTestId('session-menu'), '拖了就不出菜单').toHaveCount(0)

    const r = (await page.getByTestId(`tab-${a}`).boundingBox())!
    await touchDrag(page, { x: r.x + r.width / 2, y: r.y + r.height / 2 }, { x: r.x + r.width / 2, y: r.y + r.height / 2 }, 700, 1)
    await expect(page.getByTestId('session-menu'), '原地松手 = 菜单').toBeVisible()
  })
})
