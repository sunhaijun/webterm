/**
 * E2E-44 触屏纵向拖转滚轮 —— AC-3.21 / ADR-0029。
 *
 * Pixel 5，CDP 发真实触摸。hook `WebSocket.send` 记 INPUT 帧。xterm 5.5 在程序开了
 * 鼠标跟踪时不处理触摸，这条路以前一个字节都不发。夹具 scroller.py 每次滚轮滚 N 行，
 * 断言「内容走的行数 ≈ 手指走的行数」—— 跟手，而不是每行一次滚轮（那样是 N 倍）。
 */
import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, FIXTURES, hooks, recordSent, rectOf, submit, terminalText, waitFor, waitText, type SentRecorder } from './harness'

const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
test.use(PIXEL)

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

/** CDP 发一次真实的触摸序列：从 from 到 to，分 steps 步，每步隔 stepMs（像人手）。 */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 20, stepMs = 30) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] })
  for (let i = 1; i <= steps; i++) {
    const p = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] })
    await page.waitForTimeout(stepMs)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

/** 这一步新发出的 INPUT 帧，解成字符串拼起来。 */
async function sentSince(rec: SentRecorder, from: number): Promise<string> {
  await new Promise((r) => setTimeout(r, 300))
  const hex = (await rec.inputHex()).slice(from).join('')
  return Buffer.from(hex, 'hex').toString('latin1')
}

/** SGR 滚轮上报：按钮 64 = 向上，65 = 向下。 */
const wheelReports = (s: string, button: 64 | 65) => [...s.matchAll(new RegExp(`\\x1b\\[<${button};(\\d+);(\\d+)M`, 'g'))]

/** 夹具屏幕顶行的编号（L001 → 1）。 */
async function topLine(page: Page): Promise<number> {
  const m = (await terminalText(page)).match(/^L(\d{3})/m)
  return m ? Number(m[1]) : NaN
}

/** 等夹具画完、顶行不再变。 */
async function settled(page: Page): Promise<number> {
  let prev = NaN
  await waitFor(async () => {
    await page.waitForTimeout(150)
    const now = await topLine(page)
    const same = now === prev
    prev = now
    return same && !Number.isNaN(now)
  }, '夹具画完', 5_000)
  return prev
}

const active = (p: Page) => p.evaluate(() => (document.activeElement as HTMLElement | null)?.className ?? '')

test('E2E-44 鼠标跟踪时纵向拖转滚轮并跟手；横向拖与没开鼠标跟踪时不发', async ({ page }) => {
  const rec = await recordSent(page)
  await agent.open(page)

  // ① 步长 5 的假全屏程序（tmux copy-mode 的步长）
  await submit(page, `python3 -I ${FIXTURES}/scroller.py 5`)
  await waitText(page, /^L300/m, '夹具起来了')
  const screen = (await rectOf(page, '.xterm-screen'))!
  const { rows } = await hooks.size(page)
  const row = screen.height / rows
  const x = screen.left + screen.width / 2
  const y0 = screen.top + row * 3
  const focus = await active(page)

  // ② 跟手：手指向下拖 10 行高 → 内容走 10 ± 5 行（每行一次的话是 50 行）
  let top = await settled(page)
  let n = (await rec.inputHex()).length
  await drag(page, { x, y: y0 }, { x, y: y0 + row * 10 })
  let s = await sentSince(rec, n)
  let now = await settled(page)
  expect(Math.abs(top - now - 10), `向下拖 10 行，内容走了 ${top - now} 行`).toBeLessThanOrEqual(5)
  const up = wheelReports(s, 64)
  expect(up.length, `都是滚轮向上：${JSON.stringify(s)}`).toBeGreaterThan(0)
  expect(wheelReports(s, 65)).toHaveLength(0)
  for (const m of up) expect(Number(m[2]) >= 1 && Number(m[2]) <= rows, `行号在 1…${rows} 之内：${m[2]}`).toBe(true)
  expect(await active(page), '拖动不是点，焦点不变').toBe(focus)

  // ③ 手指向上拖 6 行高 → 内容往回走 6 ± 5 行，都是滚轮向下
  top = now
  n = (await rec.inputHex()).length
  await drag(page, { x, y: y0 + row * 10 }, { x, y: y0 + row * 4 })
  s = await sentSince(rec, n)
  now = await settled(page)
  expect(Math.abs(now - top - 6), `向上拖 6 行，内容走了 ${now - top} 行`).toBeLessThanOrEqual(5)
  expect(wheelReports(s, 65).length).toBeGreaterThan(0)
  expect(wheelReports(s, 64)).toHaveLength(0)

  // ④ 步长 1：逐行跟手
  await page.keyboard.press('q')
  await submit(page, `python3 -I ${FIXTURES}/scroller.py 1`)
  await waitText(page, /^L300/m, '步长 1 的夹具起来了')
  top = await settled(page)
  await drag(page, { x, y: y0 }, { x, y: y0 + row * 10 })
  now = await settled(page)
  expect(Math.abs(top - now - 10), `步长 1、向下拖 10 行，内容走了 ${top - now} 行`).toBeLessThanOrEqual(2)

  // ⑤ 横向拖 120px → 什么都不发
  n = (await rec.inputHex()).length
  await drag(page, { x: x - 60, y: y0 + row * 4 }, { x: x + 60, y: y0 + row * 4 + 5 })
  expect(await sentSince(rec, n), '横向拖不发滚轮').toBe('')
  await page.keyboard.press('q')

  // ⑥ 没开鼠标跟踪的备用屏 → 纵向拖什么都不发，也不发方向键（ADR-0024 §4）
  await submit(page, "printf '\\033[?1049h'; echo NO-MOUSE; sleep 60")
  await waitText(page, /^NO-MOUSE/m)
  expect(await hooks.altScreen(page), '在备用屏').toBe(true)
  n = (await rec.inputHex()).length
  await drag(page, { x, y: y0 }, { x, y: y0 + row * 6 })
  expect(await sentSince(rec, n), '没开鼠标跟踪的备用屏：拖动不发任何字节').toBe('')
  await page.keyboard.press('Control+c')
  await submit(page, "printf '\\033[?1049l'")
})
