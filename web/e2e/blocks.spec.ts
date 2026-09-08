import { expect, test } from '@playwright/test'

import { Agent, submit, terminalText, waitFor } from './harness'

/**
 * 命令块 —— docs/40-frontend/commands-ux.md。
 *
 * 【断言的是"输出真的被切对了"】，不只是面板打得开。块的全部价值在于
 * 边界准：一条命令的输出不能混进相邻的块，失败要一眼认出来。
 */
let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

test('每条命令一个块，输出不串味，失败的标出来', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  await submit(page, 'printf "AAA-%s\\n" ONE')
  await waitFor(async () => (await terminalText(page)).includes('AAA-ONE'), '第一条跑完')
  await submit(page, 'printf "BBB-%s\\n" TWO')
  await waitFor(async () => (await terminalText(page)).includes('BBB-TWO'), '第二条跑完')
  await submit(page, 'false')
  await waitFor(async () => (await terminalText(page)).includes('$'), '回到 prompt')

  await page.getByTestId('open-blocks').click()
  await expect(page.getByTestId('blocks-panel')).toBeVisible()

  const body = page.getByTestId('blocks-body')
  await expect(body).toContainText('AAA-')
  await expect(body).toContainText('false')

  // 展开第一条，它的输出里【只能】有自己的那行
  const first = body.locator('.block', { hasText: 'AAA-' }).first()
  await first.locator('.block-head').click()
  const out = first.locator('.block-out')
  await expect(out).toContainText('AAA-ONE')
  await expect(out).not.toContainText('BBB-TWO')

  // 失败的块要被标出来（默认还会自动展开）
  const bad = body.locator('.block[data-failed="true"]').first()
  await expect(bad).toBeVisible()
  await expect(bad).toContainText('false')
})

test('只看失败能把成功的滤掉', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  await submit(page, 'printf "OKMARK\\n"')
  await waitFor(async () => (await terminalText(page)).includes('OKMARK'), '成功那条跑完')
  await submit(page, 'false')
  await waitFor(async () => (await terminalText(page)).includes('$'), '失败那条跑完')

  await page.getByTestId('open-blocks').click()
  const body = page.getByTestId('blocks-body')
  await expect(body).toContainText('OKMARK')

  await page.getByTestId('blocks-only-failed').click()
  await expect(body).toContainText('false')
  await expect(body).not.toContainText('OKMARK')
})

test('填入命令把原文送回 Composer', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  await submit(page, 'printf "FILLME\\n"')
  await waitFor(async () => (await terminalText(page)).includes('FILLME'), '命令跑完')

  await page.getByTestId('open-blocks').click()
  const block = page.getByTestId('blocks-body').locator('.block', { hasText: 'FILLME' }).first()
  await block.locator('.block-head').click()
  await block.locator('button', { hasText: '填入命令' }).click()

  await expect(page.getByTestId('blocks-panel')).toHaveCount(0)
  await expect(page.getByTestId('composer')).toHaveValue(/FILLME/)
})
