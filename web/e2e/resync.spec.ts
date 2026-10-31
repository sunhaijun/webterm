/**
 * E2E-42 列数变了重发快照 —— AC-2.22（ADR-0026 §4）。
 *
 * 两边各自重排的结果不一致，以 agent 的为准：列数一变，agent 先改模拟器尺寸、生成快照发给
 * 订阅者，锁外才 TIOCSWINSZ。只改行数（软键盘）不发快照。
 */
import { expect, test } from '@playwright/test'

import { Agent, EMIT, count, framesSince, hooks, recordSent, submit, terminalText, waitFor, waitSnapshot, waitText } from './harness'

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

test('E2E-42 窗口变窄（列数变）→ resize 之后收到快照、终端列数对、内容只有一份；只改高度 → 不发快照', async ({ page }) => {
  const rec = await recordSent(page)
  await agent.open(page)
  const sid = (await hooks.sid(page))!

  // ①
  await submit(page, `${EMIT} 300 0`)
  await waitText(page, 'EMIT-DONE')
  await page.waitForTimeout(300)
  const before = await hooks.size(page)

  // ② 窗口 1280 → 1000 宽：列数变少。
  // 【别用 900】：那个宽度上 xterm 的 DOM 渲染器按当前列数反算 cell 宽，fit() 在 104 / 103
  // 之间来回翻，④ 只改高度也会改列数 —— 是 main 上就有的问题，另案处理
  await rec.clear()
  const read = await framesSince(page)
  const vp0 = page.viewportSize()!
  expect(vp0.width).toBe(1280)
  await page.setViewportSize({ width: 1000, height: vp0.height })

  await waitFor(async () => (await rec.ctl()).some((m) => m.t === 'resize'), '客户端发出 resize')
  const resize = (await rec.ctl()).find((m) => m.t === 'resize') as unknown as { cols: number; rows: number }
  expect(resize.cols, '列数变少了').toBeLessThan(before.cols)
  await waitSnapshot(read, sid, '列数变了 → agent 重发快照')

  // ③ 快照之后：终端列数 = 新 cols；最后一行内容还在，且只有一份
  await page.waitForTimeout(500)
  expect((await hooks.size(page)).cols).toBe(resize.cols)
  const text = await terminalText(page)
  expect(count(text, 'line 00300 '), '快照之后 line 00300 只有一份').toBe(1)
  expect(count(text, 'EMIT-DONE')).toBe(1)

  // ④ 只改高度（模拟软键盘）：发 resize，不发快照
  await rec.clear()
  const read2 = await framesSince(page)
  const vp = page.viewportSize()!
  await page.setViewportSize({ width: vp.width, height: vp.height - 200 })
  await waitFor(async () => (await rec.ctl()).some((m) => m.t === 'resize'), '只改高度也发 resize')
  const r2 = (await rec.ctl()).find((m) => m.t === 'resize') as unknown as { cols: number; rows: number }
  expect(r2.cols, '列数没变').toBe(resize.cols)
  expect(r2.rows, '行数变了').toBeLessThan(resize.rows)
  await page.waitForTimeout(1500)
  expect((await read2()).filter((f) => f.sid === sid && f.kind === 'SNAPSHOT'), '只改行数不该收到快照').toEqual([])
})
