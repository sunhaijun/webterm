/**
 * E2E-42 Column change resends a snapshot (AC-2.22, ADR-0026 §4).
 *
 * The agent and the browser reflow differently, and the agent wins: when the column count changes,
 * the agent resizes its emulator, sends subscribers a snapshot, and only then (outside the lock)
 * calls TIOCSWINSZ. A rows-only change (on-screen keyboard) sends no snapshot.
 */
import { expect, test } from '@playwright/test'

import { Agent, EMIT, count, framesSince, hooks, recordSent, submit, terminalText, waitFor, waitSnapshot, waitText } from './harness'

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

test('E2E-42 narrower window (columns change) -> snapshot after resize, correct columns, content appears once; height-only change -> no snapshot, stable columns', async ({ page }) => {
  const rec = await recordSent(page)
  await agent.open(page)
  const sid = (await hooks.sid(page))!

  // (1)
  await submit(page, `${EMIT} 300 0`)
  await waitText(page, 'EMIT-DONE')
  await page.waitForTimeout(300)
  const before = await hooks.size(page)

  // (2) Window 1280 -> 1000 wide: fewer columns.
  await rec.clear()
  const read = await framesSince(page)
  const vp0 = page.viewportSize()!
  expect(vp0.width).toBe(1280)
  await page.setViewportSize({ width: 1000, height: vp0.height })

  await waitFor(async () => (await rec.ctl()).some((m) => m.t === 'resize'), 'client sent resize')
  const resize = (await rec.ctl()).find((m) => m.t === 'resize') as unknown as { cols: number; rows: number }
  expect(resize.cols, 'fewer columns').toBeLessThan(before.cols)
  await waitSnapshot(read, sid, 'columns changed -> agent resends a snapshot')

  // (3) After the snapshot: terminal columns = new cols; the last line is present exactly once.
  await page.waitForTimeout(500)
  expect((await hooks.size(page)).cols).toBe(resize.cols)
  const text = await terminalText(page)
  expect(count(text, 'line 00300 '), 'line 00300 appears once after the snapshot').toBe(1)
  expect(count(text, 'EMIT-DONE')).toBe(1)

  // (4) Height-only change (simulated on-screen keyboard): resize is sent, no snapshot.
  await rec.clear()
  const read2 = await framesSince(page)
  const vp = page.viewportSize()!
  await page.setViewportSize({ width: vp.width, height: vp.height - 200 })
  await waitFor(async () => (await rec.ctl()).some((m) => m.t === 'resize'), 'height-only change still sends resize')
  const r2 = (await rec.ctl()).find((m) => m.t === 'resize') as unknown as { cols: number; rows: number }
  expect(r2.cols, 'columns unchanged').toBe(resize.cols)
  expect(r2.rows, 'rows changed').toBeLessThan(resize.rows)
  await page.waitForTimeout(1500)
  expect((await read2()).filter((f) => f.sid === sid && f.kind === 'SNAPSHOT'), 'a rows-only change must not send a snapshot').toEqual([])

  // (5) Stable columns (ADR-0033). With FitAddon, every fit at 900px wide flipped between 104 and
  // 103 columns, so even a height-only change altered the column count. Sweep a range of widths and
  // change only the height once at each.
  for (let w = 860; w <= 940; w += 4) {
    await page.setViewportSize({ width: w, height: 720 })
    await page.waitForTimeout(250)
    const before = await hooks.size(page)
    await page.setViewportSize({ width: w, height: 520 })
    await waitFor(async () => (await hooks.size(page)).rows !== before.rows, `${w}px: rows follow the height`)
    expect((await hooks.size(page)).cols, `${w}px wide, height-only change must keep columns`).toBe(before.cols)
  }
})
