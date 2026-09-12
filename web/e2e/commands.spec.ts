/**
 * E2E-14 命令历史与快捷命令 —— AC-6.1、AC-6.4 – AC-6.9。
 */
import { expect, test, type Page } from '@playwright/test'

import { Agent, submit, terminalText, waitFor } from './harness'

async function composerValue(page: Page): Promise<string> {
  return page.getByTestId('composer').inputValue()
}

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

async function seedHistory(page: Page) {
  await submit(page, 'printf "one-%s\\n" X')
  await waitFor(async () => (await terminalText(page)).includes('one-X'), '第一条')
  await submit(page, 'printf "two-%s\\n" X')
  await waitFor(async () => (await terminalText(page)).includes('two-X'), '第二条')
  await submit(page, 'false')
  await waitFor(async () => (await terminalText(page)).includes('$ false'), '第三条（失败）')
  // 前导空格的这条【不该】进历史
  await submit(page, ' printf "SECRET-%s\\n" TOKEN')
  await waitFor(async () => (await terminalText(page)).includes('SECRET-TOKEN'), '带空格的命令执行了')
  await page.waitForTimeout(500)
}

test('E2E-14 历史面板：记录、退出码、空格前缀、置顶、label、删除撤销', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await seedHistory(page)

  await page.getByTestId('open-history').click()
  const panel = page.getByTestId('history-panel')
  await expect(panel).toBeVisible()

  // AC-6.1：三条记录都在，退出码正确
  await expect(panel).toContainText('printf "one-%s\\n" X')
  await expect(panel).toContainText('false')

  // AC-6.2：以空格开头的命令【没有】被记下来
  await expect(panel, '前导空格的命令不该进历史').not.toContainText('SECRET')

  // 失败的那条用警示色标出来
  const failedRow = panel.locator('.cmd-exit[data-failed="true"]').first()
  await expect(failedRow).toBeVisible()
  await expect(failedRow).toHaveText('1')

  // AC-6.4：点击 = 填入 Composer，不执行
  const before = await terminalText(page)
  await panel.getByText('printf "one-%s\\n" X').first().click()
  await expect(page.getByTestId('history-panel')).toBeHidden()
  await waitFor(async () => (await composerValue(page)).includes('one-'), '填入了 Composer')
  expect(await terminalText(page), '点击不该直接执行').toBe(before)

  // AC-6.5：置顶
  await page.getByTestId('open-history').click()
  const star = page.locator('[data-testid$="-star"]').first()
  await star.click()
  await waitFor(async () => (await page.getByTestId('history-panel').textContent())!.includes('快捷命令'), '出现置顶区')

  // AC-6.6：设置 label
  page.once('dialog', (d) => void d.accept('我的命令'))
  await page.locator('[data-testid$="-label"]').first().click()
  await waitFor(
    async () => (await page.getByTestId('history-panel').textContent())!.includes('我的命令'),
    'label 生效',
  )

  // AC-6.9：删除单条，3 秒内可撤销
  const rows = page.locator('.cmd-row')
  const countBefore = await rows.count()
  await page.locator('[data-testid$="-delete"]').last().click()
  await expect(page.getByTestId('undo-delete')).toBeVisible()
  await page.getByTestId('undo-button').click()
  await waitFor(async () => (await rows.count()) === countBefore, '撤销之后记录回来了')
})

test('E2E-14 快捷命令：手机读视图里是写态 sheet 顶上的 ★ chip，点击填入', async ({ browser }) => {
  // 手机默认读视图（ADR-0011）：没有快捷命令条，pinned 作为 chips 出现在 sheet 里；
  // 历史面板从底栏的 ⋯ 菜单进。桌面上的快捷命令条走经典布局，另有测试。
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  const page = await ctx.newPage()
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  await submit(page, 'printf "quick-%s\\n" CMD')
  await waitFor(async () => (await terminalText(page)).includes('quick-CMD'), '命令执行了')
  await page.waitForTimeout(400)

  // 还没置顶：sheet 里没有 ★ chip（同目录历史 chip 可以有）
  await expect(page.getByTestId('quickbar')).toHaveCount(0)
  await page.getByTestId('to-edit').click()
  await expect(page.getByTestId('chips')).toBeVisible()
  await expect(page.getByTestId('chips').locator('[data-kind="pin"]')).toHaveCount(0)
  await page.getByTestId('to-terminal').click()

  await page.getByTestId('open-more').click()
  await page.getByTestId('open-history').click()
  await page.locator('[data-testid$="-star"]').first().click()
  await page.getByTestId('close-history').click()

  // 置顶之后 ★ chip 出现；点击 = 填入
  await page.getByTestId('to-edit').click()
  const pin = page.getByTestId('chips').locator('[data-kind="pin"]').first()
  await expect(pin).toBeVisible()
  await pin.click()
  await waitFor(async () => (await composerValue(page)).includes('quick-'), '点击填入 Composer')
  await expect(page.getByTestId('composer'), '点 chip 不抢焦点').toBeFocused()

  await ctx.close()
})

test('E2E-14 命令面板：模糊搜索、快捷命令优先、会话与动作', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await seedHistory(page)

  await page.keyboard.press('Control+k')
  await expect(page.getByTestId('palette')).toBeVisible()

  // 模糊搜索：子序列匹配
  await page.getByTestId('palette-input').fill('ptw')
  await waitFor(
    async () => ((await page.getByTestId('palette-list').textContent()) ?? '').includes('two-'),
    '模糊匹配到 printf two',
  )

  // 会话与动作也在同一个入口里
  await page.getByTestId('palette-input').fill('新建')
  await expect(page.getByTestId('palette-list')).toContainText('新建会话')

  // Enter = 填入 Composer，不执行
  await page.getByTestId('palette-input').fill('ptw')
  await waitFor(
    async () => ((await page.getByTestId('palette-list').textContent()) ?? '').includes('two-'),
    '候选就绪',
  )
  const before = await terminalText(page)
  await page.getByTestId('palette-input').press('Enter')
  await expect(page.getByTestId('palette')).toBeHidden()
  await waitFor(async () => (await composerValue(page)).includes('two-'), 'Enter 填入 Composer')
  expect(await terminalText(page), 'Enter 不该直接执行').toBe(before)

  // Esc 关闭
  await page.keyboard.press('Control+k')
  await expect(page.getByTestId('palette')).toBeVisible()
  await page.getByTestId('palette-input').press('Escape')
  await expect(page.getByTestId('palette')).toBeHidden()
})

test('E2E-14 清空历史保留快捷命令，并明确告知', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await seedHistory(page)

  await page.getByTestId('open-history').click()
  await page.locator('[data-testid$="-star"]').first().click()
  await page.waitForTimeout(300)

  const messages: string[] = []
  page.on('dialog', (d) => {
    messages.push(d.message())
    void d.accept()
  })
  await page.getByTestId('clear-history').click()

  await waitFor(async () => messages.length >= 2, '二次确认 + 结果告知')
  // 二次确认时就要说清楚会保留多少条快捷命令
  expect(messages[0]).toMatch(/保留 \d+ 条快捷命令/)
  expect(messages[1]).toMatch(/已删除 \d+ 条历史，保留 \d+ 条快捷命令/)

  // 置顶的那条还在
  await waitFor(
    async () => ((await page.getByTestId('history-panel').textContent()) ?? '').includes('快捷命令'),
    '置顶记录永不淘汰',
  )
})

test('设置页写明空格前缀规则 —— 用户不知道它就等于不存在', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await page.getByTestId('open-settings').click()
  await expect(page.getByTestId('privacy-note')).toContainText('以空格开头的命令不会被记录')
})
