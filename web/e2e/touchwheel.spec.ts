/**
 * E2E-44 Vertical touch drag becomes mouse wheel (AC-3.21 / ADR-0029 / ADR-0032).
 *
 * Pixel 5 with real CDP touch events; `WebSocket.send` is hooked to record INPUT frames. xterm 5.5
 * ignores touch while a program has mouse tracking on, so this path used to send nothing at all.
 * The fixture scroller.py scrolls N lines per wheel event. The test asserts one wheel event per row
 * height of finger travel, so content moves about (rows dragged × N) lines.
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

/** drag sends a real CDP touch sequence from `from` to `to` in `steps` steps, `stepMs` apart, like a finger. */
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

/** sentSince returns the INPUT frames sent since index `from`, decoded and concatenated. */
async function sentSince(rec: SentRecorder, from: number): Promise<string> {
  await new Promise((r) => setTimeout(r, 300))
  const hex = (await rec.inputHex()).slice(from).join('')
  return Buffer.from(hex, 'hex').toString('latin1')
}

/** wheelReports matches SGR wheel reports: button 64 = up, 65 = down. */
const wheelReports = (s: string, button: 64 | 65) => [...s.matchAll(new RegExp(`\\x1b\\[<${button};(\\d+);(\\d+)M`, 'g'))]

/** topLine returns the number of the fixture's top screen line (L001 -> 1). */
async function topLine(page: Page): Promise<number> {
  const m = (await terminalText(page)).match(/^L(\d{3})/m)
  return m ? Number(m[1]) : NaN
}

/** settled waits until the fixture has finished drawing and its top line stops changing. */
async function settled(page: Page): Promise<number> {
  let prev = NaN
  await waitFor(async () => {
    await page.waitForTimeout(150)
    const now = await topLine(page)
    const same = now === prev
    prev = now
    return same && !Number.isNaN(now)
  }, 'fixture finished drawing', 5_000)
  return prev
}

const active = (p: Page) => p.evaluate(() => (document.activeElement as HTMLElement | null)?.className ?? '')

test('E2E-44 with mouse tracking, vertical drag sends one wheel event per row height; horizontal drag and no mouse tracking send nothing', async ({ page }) => {
  const rec = await recordSent(page)
  await agent.open(page)

  // (1) A fake full-screen program that scrolls 5 lines per wheel step.
  await submit(page, `python3 -I ${FIXTURES}/scroller.py 5`)
  await waitText(page, /^L300/m, 'fixture is up')
  const screen = (await rectOf(page, '.xterm-screen'))!
  const { rows } = await hooks.size(page)
  const row = screen.height / rows
  const x = screen.left + screen.width / 2
  const y0 = screen.top + row * 3
  const focus = await active(page)

  // (2) One per row height: dragging down 10 rows -> 10 ± 1 wheel events; a step-5 program moves ~50 lines.
  let top = await settled(page)
  let n = (await rec.inputHex()).length
  await drag(page, { x, y: y0 }, { x, y: y0 + row * 10 })
  let s = await sentSince(rec, n)
  let now = await settled(page)
  const up = wheelReports(s, 64)
  expect(Math.abs(up.length - 10), `dragged down 10 rows, sent ${up.length} wheel events`).toBeLessThanOrEqual(1)
  expect(Math.abs(top - now - 50), `dragged down 10 rows, content moved ${top - now} lines`).toBeLessThanOrEqual(5)
  expect(wheelReports(s, 65)).toHaveLength(0)
  for (const m of up) expect(Number(m[2]) >= 1 && Number(m[2]) <= rows, `row within 1..${rows}: ${m[2]}`).toBe(true)
  expect(await active(page), 'a drag is not a tap; focus unchanged').toBe(focus)

  // (3) Dragging up 6 rows -> 6 ± 1 wheel-down events; content moves back ~30 lines.
  top = now
  n = (await rec.inputHex()).length
  await drag(page, { x, y: y0 + row * 10 }, { x, y: y0 + row * 4 })
  s = await sentSince(rec, n)
  now = await settled(page)
  const down = wheelReports(s, 65)
  expect(Math.abs(down.length - 6), `dragged up 6 rows, sent ${down.length} wheel events`).toBeLessThanOrEqual(1)
  expect(Math.abs(now - top - 30), `dragged up 6 rows, content moved ${now - top} lines`).toBeLessThanOrEqual(5)
  expect(wheelReports(s, 64)).toHaveLength(0)

  // (4) Step 1: content follows the finger line by line.
  await page.keyboard.press('q')
  await submit(page, `python3 -I ${FIXTURES}/scroller.py 1`)
  await waitText(page, /^L300/m, 'step-1 fixture is up')
  top = await settled(page)
  await drag(page, { x, y: y0 }, { x, y: y0 + row * 10 })
  now = await settled(page)
  expect(Math.abs(top - now - 10), `step 1, dragged down 10 rows, content moved ${top - now} lines`).toBeLessThanOrEqual(2)

  // (5) Horizontal drag of 120px -> nothing sent.
  n = (await rec.inputHex()).length
  await drag(page, { x: x - 60, y: y0 + row * 4 }, { x: x + 60, y: y0 + row * 4 + 5 })
  expect(await sentSince(rec, n), 'horizontal drag sends no wheel events').toBe('')
  await page.keyboard.press('q')

  // (6) Alternate screen without mouse tracking -> vertical drag sends nothing, not even arrow keys (ADR-0024 §4).
  await submit(page, "printf '\\033[?1049h'; echo NO-MOUSE; sleep 60")
  await waitText(page, /^NO-MOUSE/m)
  expect(await hooks.altScreen(page), 'on the alternate screen').toBe(true)
  n = (await rec.inputHex()).length
  await drag(page, { x, y: y0 }, { x, y: y0 + row * 6 })
  expect(await sentSince(rec, n), 'alternate screen without mouse tracking: a drag sends no bytes').toBe('')
  await page.keyboard.press('Control+c')
  await submit(page, "printf '\\033[?1049l'")
})
