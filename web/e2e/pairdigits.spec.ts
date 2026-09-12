import { expect, test } from '@playwright/test'

import { Agent } from './harness'

/**
 * E2E-27 手输数字配对码（ADR-0017，AC-1.15）。
 *
 * 扫不了码的人打开 /pair 输入终端里那 16 位数字。和二维码是同一次配对的两把钥匙：
 * 任一把用掉，另一把作废。
 */
let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

test('E2E-27 /pair 无 fragment 显示输入框；空格分隔的数字码能配上；之后二维码那把作废；输错可重试', async ({ page, browser }) => {
  const digits = await agent.pairDigits()
  expect(digits).toMatch(/^\d{4}-\d{4}-\d{4}-\d{4}$/)

  await page.goto(agent.baseURL + '/pair')
  const input = page.getByTestId('pair-code')
  const submit = page.getByTestId('pair-submit')
  await expect(input).toBeVisible()
  await expect(input).toHaveAttribute('inputmode', 'numeric')
  await expect(submit, '不足 16 位不能提交').toBeDisabled()

  // 先输一个 16 位但错误的码：401 提示，输入框还在
  const wrong = digits.replace(/\d$/, (d) => String((Number(d) + 1) % 10))
  await input.fill(wrong)
  await expect(submit).toBeEnabled()
  await submit.click()
  await expect(page.getByTestId('pair-status')).toContainText('无效')
  await expect(input, '输错后还能改').toBeVisible()

  // 用空格分隔粘进去 → 自动按 - 分组 → 配对成功跳到主界面
  await input.fill(digits.replace(/-/g, ' '))
  await expect(input).toHaveValue(digits)
  await submit.click()
  await page.waitForURL((u) => u.pathname === '/' && !u.hash, { timeout: 20_000 })
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  // 同一次配对的 URL 码（二维码那把）已经作废
  const ctx2 = await browser.newContext()
  const p2 = await ctx2.newPage()
  await p2.goto(agent.pairLink())
  await expect(p2.getByTestId('pair-status')).toContainText('无效')
  await ctx2.close()
})
