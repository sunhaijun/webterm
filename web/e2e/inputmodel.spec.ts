import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, terminalText, waitFor } from './harness'

/**
 * 底栏互切输入模型（ADR-0014）+ 单行键行（ADR-0015，E2E-25）：默认【终端输入】——
 * 终端铺满、点终端逐键直送，底栏一条键行：行首互切键 · 键区 · 行尾 ⋯；一键切【编辑面板】
 * 整段编辑后发送。键区按状态换内容（提示符键集 / 通用键集 / 程序键），高度恒等于槽位、不盖终端；
 * 全屏 TUI 强制终端输入。
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
const interactive = (p: Page) => p.evaluate(() => (window as unknown as { __webterm: { interactive(): boolean } }).__webterm.interactive())
/** 某个 testid 元素的第一个子元素的 testid —— 「互切键在行首」就看它。 */
const firstKey = (p: Page, tid: string) =>
  p.evaluate((t) => document.querySelector(`[data-testid="${t}"]`)?.firstElementChild?.getAttribute('data-testid') ?? null, tid)
/** 底栏比槽位高出多少像素 —— 终端态必须 ≤ 0（不盖终端，AC-3.14）。 */
const overlap = (p: Page) =>
  p.evaluate(() => {
    const b = document.querySelector('.bottom')!.getBoundingClientRect().height
    const s = document.querySelector('.bottom-slot')!.getBoundingClientRect().height
    return Math.round(b - s)
  })
const heightOf = (p: Page, tid: string) => p.getByTestId(tid).evaluate((el) => Math.round(el.getBoundingClientRect().height))

/** 终端输入态没有 Composer：命令直接打进终端。 */
async function typeInTerm(page: Page, text: string) {
  const ta = page.locator('.xterm-helper-textarea')
  await ta.focus()
  await ta.pressSequentially(text)
  await ta.press('Enter')
}

test('默认终端输入；一键切编辑面板；命令在跑换键区；全屏 TUI 强制终端 —— 键行始终一行、不盖终端', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  // 默认：终端输入。底栏一条键行：行首互切键、提示符键集（有 Tab 没 Esc）、行尾 ⋯；没有输入框
  expect(await has(page, 'term-bar')).toBe(true)
  expect(await has(page, 'composer')).toBe(false)
  await expect(page.getByTestId('keybar')).toBeVisible()
  expect(await firstKey(page, 'keybar'), '互切键是键行第一个键').toBe('to-edit')
  await expect(page.getByTestId('key-Tab'), '提示符键集：Tab 补全').toBeVisible()
  await expect(page.getByTestId('key-ArrowUp'), '提示符键集：翻历史').toBeVisible()
  expect(await has(page, 'key-Escape'), '提示符键集没有 Esc').toBe(false)
  await expect(page.getByTestId('open-more'), '行尾是 ⋯').toBeVisible()
  expect(await overlap(page), '键行不高于槽位：不盖终端').toBeLessThanOrEqual(0)
  const toggleH = await heightOf(page, 'to-edit')

  // 一键切编辑面板：输入框出现；互切键是编辑键行的第一个键、同尺寸；没有「收起」
  await page.getByTestId('to-edit').click()
  await expect(page.getByTestId('composer')).toBeVisible()
  expect(await has(page, 'term-bar')).toBe(false)
  expect(await firstKey(page, 'editkeys'), '互切键是编辑键行第一个键').toBe('to-terminal')
  expect(await heightOf(page, 'to-terminal'), '两种态的互切键同一尺寸').toBe(toggleH)
  expect(await has(page, 'sheet-close'), '面板头没有「收起」').toBe(false)
  expect(await has(page, 'keybar'), '编辑面板里没有第二条键条').toBe(false)
  await page.getByTestId('to-terminal').click()
  expect(await has(page, 'term-bar')).toBe(true)
  expect(await has(page, 'composer')).toBe(false)

  // 普通命令在跑（终端输入态）：键区换成通用键集（Esc ^C …），互切键仍在行首，仍无输入框，仍不盖终端
  await typeInTerm(page, 'sleep 30')
  await expect(page.getByTestId('key-Escape')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('key-CtrlC')).toBeVisible()
  expect(await firstKey(page, 'keybar')).toBe('to-edit')
  expect(await has(page, 'composer')).toBe(false)
  expect(await overlap(page), '命令在跑：键行仍不高于槽位').toBeLessThanOrEqual(0)
  await page.getByTestId('key-CtrlC').click()
  await expect(page.getByTestId('key-Escape'), '回到提示符后换回提示符键集').toHaveCount(0, { timeout: 8_000 })
  await expect(page.getByTestId('key-Tab')).toBeVisible()

  // 全屏 TUI（备用缓冲）：仍是终端输入、没有输入框，键区换成 TUI 键；互切键仍在；仍不盖终端
  await typeInTerm(page, "printf '\\033[?1049h'; sleep 30; printf '\\033[?1049l'")
  await waitFor(async () => (await alt(page)) === true, '进备用缓冲', 10_000)
  await page.waitForTimeout(400)
  expect(await has(page, 'term-bar')).toBe(true)
  expect(await has(page, 'composer'), '默认仍是终端输入，没有输入框').toBe(false)
  // 互切键【始终给】：claude / codex 也占屏，但它们最需要编辑面板发 prompt
  expect(await has(page, 'to-edit'), '备用缓冲下互切键仍在').toBe(true)
  await expect(page.getByTestId('keybar')).toHaveAttribute('data-context', /printf|tui/)
  expect(await overlap(page), 'TUI：键行仍不高于槽位').toBeLessThanOrEqual(0)
})

test('编辑态命令在跑：键行里并入 Esc ^C，只有一条键行；^C 回到提示符后退场', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  await typeInTerm(page, 'sleep 30')
  await expect(page.getByTestId('key-Escape')).toBeVisible({ timeout: 10_000 })
  await page.getByTestId('to-edit').click()
  await expect(page.getByTestId('composer')).toBeVisible()
  const row = page.getByTestId('editkeys')
  await expect(row.getByTestId('key-Escape'), '程序键并入编辑键行').toBeVisible()
  await expect(row.getByTestId('key-CtrlC')).toBeVisible()
  await expect(row.getByTestId('edit-Tab'), '编辑键还在').toBeVisible()
  await expect(row.getByTestId('send'), '行尾是发送').toBeVisible()
  await expect(page.getByTestId('keybar'), '没有第二条键条').toHaveCount(0)

  await row.getByTestId('key-CtrlC').click()
  await expect(row.getByTestId('key-Escape'), '回到提示符后程序键退场').toHaveCount(0, { timeout: 8_000 })
  await expect(page.getByTestId('composer'), '留在编辑面板').toBeVisible()
})

test('主屏占屏程序（富键盘协议，claude / codex 那类）在终端态也换上下文键条', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  await typeInTerm(page, "printf '\\033[>1u\\033[?25l'; sleep 30; printf '\\033[<u\\033[?25h'")
  await waitFor(async () => (await interactive(page)) === true, '占屏', 10_000)
  expect(await alt(page), '这类程序不切备用缓冲').toBe(false)
  // 之前终端态只看备用缓冲 → claude 在终端态拿到的是通用键、没有程序名（ADR-0015 顺手修）
  await expect(page.getByTestId('keybar')).not.toHaveAttribute('data-context', 'shell')
  await expect(page.getByTestId('keybar-context')).toHaveText('printf')
  expect(await overlap(page)).toBeLessThanOrEqual(0)
  await page.getByTestId('key-CtrlC').click()
  await waitFor(async () => (await interactive(page)) === false, '退出占屏', 10_000)
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
