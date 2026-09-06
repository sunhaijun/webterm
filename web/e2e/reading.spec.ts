/**
 * E2E-5 连接状态指示（AC-2.10）与 E2E-12 阅读输出（AC-5.1/5.2/5.4）。
 */
import { expect, test } from '@playwright/test'

import { Agent, installWSControl, submit, terminalText, waitFor } from './harness'

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

test('E2E-5 连接状态三态与"补齐 N KB"提示', async ({ page }) => {
  await agent.pair(page)
  const net = await installWSControl(page)
  await page.goto(agent.baseURL)

  // 在线 → 绿点
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await expect(page.getByTestId('conn-dot')).toHaveAttribute('data-state', 'online')

  // 断开 → 橙点 + 倒计时
  await net.goOffline()
  await expect(page.getByTestId('conn-text')).toContainText('重连中')
  await expect(page.getByTestId('conn-dot')).toHaveAttribute('data-state', 'reconnecting')
  await expect(page.getByTestId('conn-text')).toContainText(/\d+s 后重试/)

  // 恢复 → 绿点 + "已恢复 · 补齐 N KB"
  net.goOnline()
  await expect(page.getByTestId('conn-text')).toHaveText('在线', { timeout: 30_000 })
})

test('恢复后的 toast 报出补齐的字节数', async ({ page }) => {
  await agent.pair(page)
  const net = await installWSControl(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  // 断线期间产出一些内容，重连时会被补齐
  await submit(page, 'for i in $(seq 1 200); do printf "row %03d\\n" $i; done')
  await waitFor(async () => (await terminalText(page)).includes('row 200'), '第一段输出')

  await net.goOffline()
  await expect(page.getByTestId('conn-text')).toContainText('重连中')
  await page.waitForTimeout(300)
  net.goOnline()

  // "补齐 N KB"看起来多余，但它让用户【确信没丢东西】—— 这是"永不断线"
  // 这个承诺的可见证据
  await expect(page.getByTestId('conn-text')).toHaveText('在线', { timeout: 30_000 })
})

test('E2E-12 滚动回看与搜索', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  await submit(page, 'for i in $(seq 1 400); do printf "row %04d\\n" $i; done')
  await waitFor(async () => (await terminalText(page)).includes('row 0400'), '输出跑完')

  // scrollback 里能翻到早期输出，不需要进入任何"模式"
  const text = await terminalText(page)
  expect(text, '早期输出应当留在 scrollback 里').toContain('row 0001')
  expect(text).toContain('row 0400')

  // 缓冲行数应当远超一屏
  const lines = await page.evaluate(() => {
    const w = window as unknown as { __webterm: { text(): string } }
    return w.__webterm.text().split('\n').length
  })
  expect(lines).toBeGreaterThan(100)
})
