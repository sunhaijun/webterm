import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, submit, terminalText, waitFor } from './harness'

/**
 * 无输入模式的底栏（ADR-0013+）：按触摸位置自动判定——点终端 = 逐键直送；用底部
 * 输入条 = 编辑后整段发送。底栏形态按「在跑什么」自动变，没有 Composer/Raw 开关。
 */
const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
test.use({ ...PIXEL, launchOptions: { args: ['--disable-webgl'] } })
test.setTimeout(90_000)

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

const has = (p: Page, tid: string) => p.getByTestId(tid).count().then((n) => n > 0)
const alt = (p: Page) => p.evaluate(() => (window as unknown as { __webterm: { altScreen(): boolean } }).__webterm.altScreen())

test('提示符=只输入框；命令在跑=输入框+键条；全屏 TUI=只键条；模式开关已删', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  // 提示符：只有输入框，没有键条，也没有模式切换
  expect(await has(page, 'composer')).toBe(true)
  expect(await has(page, 'keybar')).toBe(false)
  expect(await has(page, 'mode-toggle')).toBe(false)
  expect(await has(page, 'term-type')).toBe(false)

  // 普通命令在跑：输入框仍在 + 键条出现（含 ^C）
  await submit(page, 'sleep 30')
  await expect(page.getByTestId('keybar')).toBeVisible({ timeout: 10_000 })
  expect(await has(page, 'composer')).toBe(true)
  await expect(page.getByTestId('key-CtrlC')).toBeVisible()
  await page.getByTestId('key-CtrlC').click()
  await expect(page.getByTestId('keybar')).toHaveCount(0, { timeout: 8_000 })

  // 全屏 TUI（备用缓冲）：底部只有键条，没有输入框
  await submit(page, "printf '\\033[?1049h'; sleep 30; printf '\\033[?1049l'")
  await waitFor(async () => (await alt(page)) === true, '进备用缓冲', 10_000)
  await page.waitForTimeout(400)
  expect(await has(page, 'tui-bar')).toBe(true)
  expect(await has(page, 'composer')).toBe(false)
})

test('点终端区打字 = 直送 PTY（无需切模式）', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await page.locator('.xterm-screen').click()
  await page.waitForTimeout(150)
  expect(await page.evaluate(() => document.activeElement?.className ?? '')).toContain('xterm')
  await page.locator('.xterm-helper-textarea').pressSequentially('echo TAP-DIRECT')
  await page.locator('.xterm-helper-textarea').press('Enter')
  await waitFor(async () => (await terminalText(page)).includes('TAP-DIRECT'), '逐键直送并执行', 6_000)
})

test('用底部输入条 = 编辑后整段发送', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await page.getByTestId('composer').fill('printf BAR-%s\\\\n SEND')
  await page.getByTestId('composer').press('Enter')
  await waitFor(async () => (await terminalText(page)).includes('BAR-SEND'), '编辑后发送', 6_000)
})
