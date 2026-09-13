import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, submit, terminalText, waitFor } from './harness'

/**
 * 编辑面板 sheet（ADR-0014 互切输入模型 + ADR-0015 键行，E2E-19 / E2E-25）。
 *
 * 默认终端输入（底栏一条键行：互切键 · 键区 · ⋯）；点互切键升起编辑面板，半屏 / 全屏两档，
 * 面板键行行首的 `✎ 终端` 回终端输入（没有「收起」）。sheet 盖在终端上而不挤画布：
 * xterm 尺寸在各档之间一个字都不变。全屏时输入框填满面板。
 * chips：空输入给同目录历史，敲 `cd s` 给真实存在的路径，点一下补进去。
 */
const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
test.use(PIXEL)

type Hooks = { __webterm: { sheet(): string; size(): { cols: number; rows: number } } }
const sheet = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__webterm.sheet())
const ptySize = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__webterm.size())
const rect = (page: Page, sel: string) =>
  page.evaluate((s) => {
    const r = document.querySelector(s)!.getBoundingClientRect()
    return { top: Math.round(r.top), height: Math.round(r.height), bottom: Math.round(r.bottom) }
  }, sel)
const firstKey = (p: Page, tid: string) =>
  p.evaluate((t) => document.querySelector(`[data-testid="${t}"]`)?.firstElementChild?.getAttribute('data-testid') ?? null, tid)

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

test('一键升编辑面板(半屏)，抓手到全屏且输入框填满，互切键回终端输入；画布几何与 PTY 尺寸全程不变', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  // 默认终端输入：一条键行，互切键在行首、⋯ 在行尾，没有输入框 / 编辑键；键行不高于槽位
  expect(await sheet(page)).toBe('closed')
  const closedBar = await rect(page, '.bottom')
  expect(closedBar.height, '终端输入态就是一行').toBeLessThan(70)
  expect(closedBar.height, '键行不高于槽位（不盖终端）').toBeLessThanOrEqual((await rect(page, '.bottom-slot')).height)
  await expect(page.getByTestId('to-edit')).toBeVisible()
  expect(await firstKey(page, 'keybar')).toBe('to-edit')
  await expect(page.getByTestId('open-more')).toBeVisible()
  await expect(page.getByTestId('editkeys')).toHaveCount(0)
  const canvas0 = await rect(page, '.canvas')
  const size0 = await ptySize(page)

  // 切编辑面板 → 半屏
  await page.getByTestId('to-edit').click()
  await waitFor(async () => (await sheet(page)) === 'half', '升起半屏')
  await page.waitForTimeout(250) // 高度过渡
  const half = await rect(page, '.bottom')
  const main = await rect(page, '.main')
  expect(half.height, '半屏大致是主区的一半').toBeGreaterThan(main.height * 0.35)
  expect(half.height).toBeLessThan(main.height * 0.6)
  await expect(page.getByTestId('editkeys')).toBeVisible()
  await expect(page.getByTestId('to-terminal'), '键行行首是回终端键').toBeVisible()
  expect(await firstKey(page, 'editkeys')).toBe('to-terminal')
  await expect(page.getByTestId('sheet-close'), '没有「收起」').toHaveCount(0)
  // 画布没动、PTY 没 resize
  expect(await rect(page, '.canvas')).toEqual(canvas0)
  expect(await ptySize(page)).toEqual(size0)

  // 把手点一下 → 全屏
  await page.getByTestId('sheet-handle').click()
  await waitFor(async () => (await sheet(page)) === 'full', '全屏')
  await page.waitForTimeout(250)
  const full = await rect(page, '.bottom')
  expect(full.height, '全屏盖到画布顶').toBeGreaterThan(main.height * 0.8)
  expect(await rect(page, '.canvas')).toEqual(canvas0)
  expect(await ptySize(page)).toEqual(size0)
  // 输入框填满面板 —— 以前 40vh 上限让全屏面板下半截空着（ADR-0015）
  const composerFull = await rect(page, '[data-testid=composer]')
  expect(composerFull.height, `全屏时输入框（${composerFull.height}px）应填满面板（${full.height}px）`).toBeGreaterThan(full.height * 0.7)

  // 互切键 → 回终端输入
  await page.getByTestId('to-terminal').click()
  await waitFor(async () => (await sheet(page)) === 'closed', '收起回终端输入')
  await page.waitForTimeout(250)
  await expect(page.getByTestId('term-bar')).toBeVisible()
  expect((await rect(page, '.bottom')).height, '回到一行').toBe(closedBar.height)
  expect(await ptySize(page)).toEqual(size0)
})

test('提交后自动收回终端；Esc 清空再 Esc 收回；命令在跑是终端输入 + 功能键条', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  await submit(page, 'printf "SHEET-%s\\n" ONE')
  await waitFor(async () => (await terminalText(page)).includes('SHEET-ONE'), '命令跑了')
  expect(await sheet(page), '发出去就收回终端 —— 该看输出了').toBe('closed')
  await expect(page.getByTestId('term-bar')).toBeVisible()

  // 切编辑面板，两下 Esc：先清空，再收回终端
  await page.getByTestId('to-edit').click()
  await page.getByTestId('composer').fill('echo draft')
  await waitFor(async () => (await sheet(page)) === 'half', '半屏')
  await page.getByTestId('composer').press('Escape')
  await expect(page.getByTestId('composer')).toHaveValue('')
  expect(await sheet(page), '第一下 Esc 只清空').toBe('half')
  await page.getByTestId('composer').press('Escape')
  await waitFor(async () => (await sheet(page)) === 'closed', '第二下 Esc 收回终端')

  // 命令在跑：默认终端输入（没有输入框），键区换成通用键集，互切键仍在
  await submit(page, 'sleep 30')
  await expect(page.getByTestId('key-Escape')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('composer'), '命令在跑默认终端输入，没有输入框').toHaveCount(0)
  await expect(page.getByTestId('to-edit'), '仍可一键切到编辑面板').toBeVisible()
  await expect(page.getByTestId('key-CtrlC')).toBeVisible()
  expect(await sheet(page)).toBe('closed')
  await page.getByTestId('key-CtrlC').click()
  await expect(page.getByTestId('key-Escape'), '回到 prompt：换回提示符键集').toHaveCount(0)
  await expect(page.getByTestId('key-Tab'), '提示符键集仍在').toBeVisible()
})

test('chips：空输入给同目录历史；敲 cd s 给真实路径，点一下补成 cd src/，Tab 再补一层', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  // 造一个目录结构并 cd 进去（cwd 走 OSC 7 报上来）
  await submit(page, 'D=$(mktemp -d) && mkdir -p "$D/src/commands" "$D/docs" && : > "$D/src/a.go" && cd "$D" && echo READY-$PWD')
  await waitFor(async () => /READY-\//.test(await terminalText(page)), 'cd 进了临时目录')
  await submit(page, 'printf "HIST-%s\\n" MARK')
  await waitFor(async () => (await terminalText(page)).includes('HIST-MARK'), '这个目录里有了一条历史')

  await page.getByTestId('to-edit').click()
  await waitFor(async () => (await sheet(page)) === 'half', '半屏')
  const chips = page.getByTestId('chip')
  await expect(chips.filter({ hasText: 'HIST-' }).first(), '同目录历史出现').toBeVisible({ timeout: 5_000 })
  await expect(page.getByTestId('chips').locator('[data-kind="path"]'), '空输入不给路径').toHaveCount(0)

  await page.getByTestId('composer').fill('cd s')
  const src = page.getByTestId('chips').locator('[data-kind="path"]', { hasText: 'src/' })
  await expect(src, '真实存在的目录作为 chip').toBeVisible({ timeout: 5_000 })
  await expect(page.getByTestId('chips').locator('[data-kind="path"]', { hasText: 'docs' })).toHaveCount(0)
  await src.click()
  await expect(page.getByTestId('composer')).toHaveValue('cd src/')
  await expect(page.getByTestId('composer'), '点 chip 不能把焦点抢走').toBeFocused()

  // 进了一层：src/ 里的 commands/ 与 a.go；编辑键 Tab 补第一个路径 chip
  await expect(page.getByTestId('chips').locator('[data-kind="path"]', { hasText: 'commands/' })).toBeVisible({ timeout: 5_000 })
  await page.getByTestId('edit-Tab').click()
  await expect(page.getByTestId('composer')).toHaveValue('cd src/commands/')

  // 编辑键：| 与 ⌫词
  await page.getByTestId('edit-Pipe').click()
  await expect(page.getByTestId('composer')).toHaveValue('cd src/commands/ | ')
  await page.getByTestId('edit-DeleteWord').click()
  await page.getByTestId('edit-DeleteWord').click()
  await expect(page.getByTestId('composer')).toHaveValue('cd ')

  // 发送键提交：命令执行，但【留在编辑面板】—— 连着发是常态，别把人踢回终端（ADR-0014+）
  await page.getByTestId('composer').fill('printf "SENT-%s\\n" OK')
  await page.getByTestId('send').click()
  await waitFor(async () => (await terminalText(page)).includes('SENT-OK'), '发送键提交了')
  expect(await sheet(page), '发送后留在编辑面板，不跳回终端').not.toBe('closed')
  await expect(page.getByTestId('composer'), '发送后输入框清空，可接着编下一条').toHaveValue('')
  // 要回终端直输，点面板头的 ✎▸终端
  await page.getByTestId('to-terminal').click()
  expect(await sheet(page)).toBe('closed')
})

test('⋯ 菜单：会话 / 历史 / 设置 从这里进', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  await expect(page.getByTestId('more-menu')).toHaveCount(0)
  await page.getByTestId('open-more').click()
  await expect(page.getByTestId('more-menu')).toBeVisible()
  await page.getByTestId('open-history').click()
  await expect(page.getByTestId('history-panel')).toBeVisible()
  await expect(page.getByTestId('more-menu'), '选完菜单就收').toHaveCount(0)
  await page.getByTestId('close-history').click()

  // 点外面收起菜单
  await page.getByTestId('open-more').click()
  await page.getByTestId('more-backdrop').click()
  await expect(page.getByTestId('more-menu')).toHaveCount(0)
})
