import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, submit, terminalText, waitFor } from './harness'

/**
 * 手机上的多会话管理（ADR-0013 后）：⋯ 菜单第一项「会话」开抽屉；新建后抽屉收起、
 * 立刻能发命令；关掉当前会话自动切到相邻会话，不留空白终端。
 */
const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
test.use(PIXEL)
test.setTimeout(60_000)

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

const sid = (p: Page) => p.evaluate(() => (window as unknown as { __webterm: { sid(): number | null } }).__webterm.sid())
const drawerOpen = (p: Page) => p.evaluate(() => document.querySelector('.app')?.getAttribute('data-sidebar') === 'open')

test('⋯ 菜单第一项是「会话」，开抽屉；新建后抽屉收起、能立刻发命令', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  // ⋯ 菜单：第一项就是「会话」
  await page.getByTestId('open-more').click()
  const items = page.getByTestId('more-menu').getByRole('menuitem')
  await expect(items.first()).toContainText('会话')
  await page.getByTestId('open-sessions').click()
  await expect.poll(() => drawerOpen(page)).toBe(true)

  // 从抽屉新建 → 抽屉收起
  await page.getByTestId('new-session').click()
  await expect.poll(() => drawerOpen(page)).toBe(false)
  // 立刻发命令（不需要先关抽屉）——这是之前的 bug
  await submit(page, "printf 'NEW-%s\\n' OK")
  await waitFor(async () => (await terminalText(page)).includes('NEW-OK'), '新会话里命令到达', 8_000)
})

test('关掉当前会话自动切到相邻会话，仍能发命令', async ({ page }) => {
  page.on('dialog', (d) => d.accept()) // running 会话关闭二次确认
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  const a = await sid(page)

  // 新建 B（抽屉自动收起）
  await page.getByTestId('statusbar').click()
  await page.getByTestId('new-session').click()
  await expect.poll(() => drawerOpen(page)).toBe(false)
  await waitFor(async () => (await sid(page)) !== a, '切到了 B')
  const b = await sid(page)
  expect(b).not.toBe(a)

  // 打开抽屉，关掉当前会话 B → 自动切回 A（不空白）
  await page.getByTestId('statusbar').click()
  await page.getByTestId('session-' + b + '-close').click()
  await waitFor(async () => (await sid(page)) === a, '自动切到相邻会话 A', 8_000)
  // 关掉抽屉后能发命令
  if (await drawerOpen(page)) await page.getByTestId('scrim').click({ position: { x: 5, y: 5 } })
  await submit(page, "printf 'BACK-%s\\n' A")
  await waitFor(async () => (await terminalText(page)).includes('BACK-A'), '切回 A 后命令到达', 8_000)
})

test('删除唯一会话再新建：抽屉收起、能发命令', async ({ page }) => {
  page.on('dialog', (d) => d.accept())
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  const a = await sid(page)
  await page.getByTestId('statusbar').click()
  await page.getByTestId('session-' + a + '-close').click()
  await waitFor(async () => (await sid(page)) === null, '删完没有会话了', 5_000)
  // 抽屉还开着（没有会话可切），新建
  await page.getByTestId('new-session').click()
  await expect.poll(() => drawerOpen(page)).toBe(false)
  await waitFor(async () => (await sid(page)) !== null, '新会话起来', 5_000)
  await submit(page, "printf 'FRESH-%s\\n' OK")
  await waitFor(async () => (await terminalText(page)).includes('FRESH-OK'), '发命令到达', 8_000)
})

test('重命名会话：✎ 弹框输入新名，状态栏与列表都更新', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  const s = await sid(page)
  await page.getByTestId('statusbar').click()
  await expect.poll(() => drawerOpen(page)).toBe(true)
  page.once('dialog', (d) => d.accept('我的会话'))
  await page.getByTestId('session-' + s + '-rename').click()
  await expect(page.getByTestId('session-' + s).locator('.session-name')).toHaveText('我的会话', { timeout: 8_000 })
  // 关抽屉后状态栏也显示新名
  await page.getByTestId('scrim').click({ position: { x: 5, y: 5 } }).catch(() => {})
  await expect(page.getByTestId('statusbar')).toContainText('我的会话')
})
