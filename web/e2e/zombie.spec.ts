/**
 * E2E-33 僵尸连接：回到前台立刻戳穿（AC-2.20，ADR-0020）。
 *
 * 僵尸连接 = 线路断了但【没有 onclose】。手机息屏、切 App、Wi-Fi 切蜂窝、
 * NAT / 反向代理静默回收 —— TCP 上都没有 FIN，浏览器那边 readyState 一直是
 * OPEN。页面自认在线，用户打的字全写进一条死 socket，屏幕上什么都不变。
 *
 * 改之前唯一的暴露渠道是心跳：30 秒 ping + 10 秒 pong 超时 = 最坏 40 秒。
 * 现在 online / 页面重新可见会立刻探活一次，2 秒没有 pong 就判死。
 */
import { expect, test } from '@playwright/test'

import { Agent, installWSControl, terminalText, waitFor } from './harness'

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

test('E2E-33 线断了却没有 onclose：回到前台 5 秒内判死重连，僵尸期间的输入不丢', async ({
  page,
}) => {
  await agent.pair(page)
  const net = await installWSControl(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  // 先确认这条路是通的 —— 后面"打字没反应"才有对照
  await page.getByTestId('terminal').click({ position: { x: 60, y: 60 } })
  await page.keyboard.type('echo ALIVE')
  await page.keyboard.press('Enter')
  await waitFor(async () => (await terminalText(page)).includes('ALIVE'), 'ALIVE 回显')

  net.goZombie()

  // 僵尸期间敲一行：字进了重发队列、也写进了那条死 socket，但一个字节都到不了 agent
  await page.keyboard.type('echo ZOMBIE')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)
  await expect(
    page.getByTestId('conn-text'),
    '这就是问题的样子：线断了，页面还以为自己在线',
  ).toHaveText('在线')
  expect(await terminalText(page), '死 socket，连回显都没有').not.toContain('ZOMBIE')

  // 用户把应用切回前台
  const t0 = Date.now()
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))

  await expect(page.getByTestId('conn-text'), '探活应当立刻戳穿它').not.toHaveText('在线', {
    timeout: 5_000,
  })
  const detectMs = Date.now() - t0
  expect(detectMs, `改之前要等 30s 心跳 + 10s pong；实测 ${detectMs}ms`).toBeLessThan(5_000)

  net.goOnline()
  await expect(page.getByTestId('conn-text')).toHaveText('在线', { timeout: 40_000 })

  // 探活不能把输入弄丢：僵尸期间敲的那行按 in_ack 重发，最终要执行（AC-2.4）
  await waitFor(async () => (await terminalText(page)).includes('ZOMBIE'), 'ZOMBIE 重连后执行')
})
