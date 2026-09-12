/**
 * 重连 / 刷新回放不能把历史里的终端查询应答当成输入送进 PTY。
 *
 * 缓冲区被重放进 xterm 时，历史输出里程序（claude 等）发过的查询（DSR/DA…）
 * 会被 xterm 再次自动应答 —— 那不是用户输入。回放期间必须抑制（见 store 的
 * replayDepth 与 conn/connection.ts 的 catchupTo）；否则刷新后 claude 会收到
 * 一串乱码"输入"。字节级连续性（AC-2.1）不受影响：所有输出照写，抑制的只是
 * xterm 往 PTY 回的应答。
 */
import { expect, test, type Page } from '@playwright/test'

import { Agent, installWSControl, submit } from './harness'

async function recordInput(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __sent: string[] }
    w.__sent = []
    const orig = WebSocket.prototype.send
    WebSocket.prototype.send = function (data: unknown) {
      if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
        const b = data instanceof Uint8Array ? data : new Uint8Array(data)
        if (b[0] === 0x02) w.__sent.push(new TextDecoder().decode(b.subarray(12)))
      }
      return orig.call(this, data as never)
    }
  })
  return () => page.evaluate(() => (window as unknown as { __sent: string[] }).__sent)
}

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

test('重连回放不把历史里的终端查询应答送进 PTY', async ({ page }) => {
  const sent = await recordInput(page)
  const net = await installWSControl(page)
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  // 命令 2s 后发一个 DSR 光标位置查询（\e[6n），然后一直挂着
  await submit(page, 'sleep 2; printf "\\033[6n"; sleep 30')
  await net.goOffline() // 立刻断线，让那个查询落在【离线窗口】—— 只会在重连回放时到达
  await page.waitForTimeout(3000)
  net.goOnline()
  await expect(page.getByTestId('conn-text')).toHaveText('在线', { timeout: 30_000 })
  await page.waitForTimeout(800) // 等回放灌进 xterm

  const cpr = (await sent()).some((s) => /\x1b\[\d+;\d+R/.test(s))
  expect(cpr, '回放的 DSR 查询不该触发 xterm 应答被当成输入送进 PTY').toBe(false)
})
