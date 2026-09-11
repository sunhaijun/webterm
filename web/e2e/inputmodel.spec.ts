import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, terminalText, waitFor } from './harness'

/**
 * 底栏互切输入模型（ADR-0013+）：默认【终端输入】——终端铺满、点终端逐键直送，
 * 底栏只有互切键 + ⋯；一键切【编辑面板】整段编辑后发送。命令在跑挂功能键条；
 * 全屏 TUI 强制终端输入、互切键让位给退出键条。
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

/** 终端输入态没有 Composer：命令直接打进终端。 */
async function typeInTerm(page: Page, text: string) {
  const ta = page.locator('.xterm-helper-textarea')
  await ta.focus()
  await ta.pressSequentially(text)
  await ta.press('Enter')
}

test('默认终端输入；一键切编辑面板；命令在跑挂键条；全屏 TUI 强制终端', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  // 默认：终端输入。底栏只有互切键 + ⋯，没有输入框、没有功能键条
  expect(await has(page, 'term-bar')).toBe(true)
  expect(await has(page, 'to-edit')).toBe(true)
  expect(await has(page, 'composer')).toBe(false)
  expect(await has(page, 'keybar'), '提示符下不挂功能键条').toBe(false)

  // 一键切编辑面板：输入框出现，可切回终端
  await page.getByTestId('to-edit').click()
  await expect(page.getByTestId('composer')).toBeVisible()
  expect(await has(page, 'to-terminal')).toBe(true)
  expect(await has(page, 'term-bar')).toBe(false)
  await page.getByTestId('to-terminal').click()
  expect(await has(page, 'term-bar')).toBe(true)
  expect(await has(page, 'composer')).toBe(false)

  // 普通命令在跑（终端输入态）：功能键条出现（含 ^C）+ 互切键仍在，仍无输入框
  await typeInTerm(page, 'sleep 30')
  await expect(page.getByTestId('keybar')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('key-CtrlC')).toBeVisible()
  expect(await has(page, 'to-edit')).toBe(true)
  expect(await has(page, 'composer')).toBe(false)
  await page.getByTestId('key-CtrlC').click()
  await expect(page.getByTestId('keybar'), '回到提示符后键条退场').toHaveCount(0, { timeout: 8_000 })

  // 全屏 TUI（备用缓冲）：仍是终端输入、没有输入框，互切键让位给退出键条（不给 to-edit）
  await typeInTerm(page, "printf '\\033[?1049h'; sleep 30; printf '\\033[?1049l'")
  await waitFor(async () => (await alt(page)) === true, '进备用缓冲', 10_000)
  await page.waitForTimeout(400)
  expect(await has(page, 'term-bar')).toBe(true)
  expect(await has(page, 'composer')).toBe(false)
  expect(await has(page, 'to-edit'), '全屏 TUI 不给互切键').toBe(false)
})

test('点终端区打字 = 直送 PTY', async ({ page }) => {
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

test('切到编辑面板 = 整段编辑后发送', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await page.getByTestId('to-edit').click()
  await page.getByTestId('composer').fill('printf BAR-%s\\\\n SEND')
  await page.getByTestId('composer').press('Enter')
  await waitFor(async () => (await terminalText(page)).includes('BAR-SEND'), '编辑后发送', 6_000)
})
