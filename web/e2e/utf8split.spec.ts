/**
 * E2E-43 切开的 UTF-8 不丢字 —— AC-2.23（ADR-0026 §7，layout.md §渲染）。
 *
 * xterm.js 的 `write(Uint8Array)` 在第 2 字节是 0x80 的三字节字符被切在第 2 字节之后时
 * 整个丢掉（`。` `…` `—`）。浏览器每会话用流式 TextDecoder 先解成字符串再写。
 */
import { expect, test } from '@playwright/test'

import { Agent, hooks, submit, terminalText, waitFor, waitOnline } from './harness'

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

const LINE = '。…—END'
const hasLine = async (page: Parameters<typeof terminalText>[0]) =>
  (await terminalText(page)).split('\n').some((l) => l.trimEnd() === LINE)

test('E2E-43 三个字符各被切在第 2 字节之后、落在不同的 OUTPUT 帧里，终端里照样是「。…—END」；刷新后仍是', async ({ page }) => {
  await agent.open(page)
  const sid = (await hooks.sid(page))!

  // 每段之间 sleep 0.3：PTY 读边界就落在 printf 之间，每段是单独的 OUTPUT 帧
  const n0 = (await hooks.frames(page)).length
  await submit(page, "printf '\\xe3\\x80'; sleep 0.3; printf '\\x82\\xe2\\x80'; sleep 0.3; printf '\\xa6\\xe2\\x80'; sleep 0.3; printf '\\x94END\\n'")
  await waitFor(() => hasLine(page), `终端那一行是 ${LINE}`, 10_000)

  // 确实被切开了：输出段落在至少 4 个 OUTPUT 帧里（2 字节、3 字节、3 字节、5 字节）
  const fs = (await hooks.frames(page)).slice(n0).filter((f) => f.sid === sid && f.kind === 'OUTPUT')
  const sizes = fs.map((f) => f.bytes)
  expect(sizes.includes(2) && sizes.filter((b) => b === 3).length >= 2, `帧长 ${sizes.join(',')}`).toBe(true)

  // 刷新（走快照）后同一行仍在
  await page.reload()
  await waitOnline(page)
  await waitFor(async () => (await hooks.frames(page)).some((f) => f.sid === sid && f.kind === 'SNAPSHOT'), '刷新后走快照')
  await waitFor(() => hasLine(page), `刷新之后那一行仍是 ${LINE}`, 10_000)
})
