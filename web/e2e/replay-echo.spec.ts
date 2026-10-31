/**
 * 重连补课不回声 —— AC-2.15。E2E-30 ② 测的是切回（subscribe）那条路的增量补课，
 * 这条是同一条规则在【重连】（welcome.resumed[].status == "ok"）那条路上的对照；
 * 场景清单里没有单列编号（见交付说明里的文档问题）。
 *
 * 断线期间程序发出的终端查询（DSR / DA …）是【历史】：重连补课把它写进 xterm 时，
 * xterm 会自动应答 —— 那不是用户输入，必须被回放门拦下，否则前台程序收到一串乱码按键。
 */
import { expect, test } from '@playwright/test'

import { Agent, installWSControl, lastWelcome, recordSent, submit, waitOnline } from './harness'

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

test('AC-2.15 重连补课里的终端查询不被应答进 PTY', async ({ page }) => {
  const rec = await recordSent(page)
  const net = await installWSControl(page)
  await agent.open(page)

  // 命令 2s 后发一个 DSR 光标位置查询（\e[6n），然后一直挂着
  await submit(page, 'sleep 2; printf "\\033[6n"; sleep 30')
  await net.goOffline() // 立刻断线，让那个查询落在【离线窗口】—— 只会在重连补课时到达
  await page.waitForTimeout(3000)
  net.goOnline()
  await waitOnline(page)
  expect((await lastWelcome(page))!.resumed.every((r) => r.status === 'ok'), '这条测的是增量补课').toBe(true)
  await page.waitForTimeout(800) // 等补课灌进 xterm

  const cpr = (await rec.input()).some((s) => /\x1b\[\d+;\d+R/.test(s))
  expect(cpr, '补课里的 DSR 查询不该触发 xterm 应答被当成输入送进 PTY').toBe(false)
})
