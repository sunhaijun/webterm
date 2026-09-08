import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, submit, terminalText, waitFor } from './harness'

/**
 * 「在终端里看」定位到该块 —— ADR-0011 分片 ④。
 *
 * 块按 out_seq 切、xterm 按行存。agent 先发 command.start/end 再推帧，client 在写入
 * 时把帧在 out_seq 处切开登记 marker，于是"看这块"能滚到它输出的第一行，而不是
 * 扔到终端底部让人自己往上翻几百行。
 */
const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
test.use(PIXEL)

type Hooks = { __webterm: { view(): string; viewport(): { y: number; top: string }; lastLocate(): string } }
const view = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__webterm.view())
const viewport = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__webterm.viewport())
const lastLocate = (page: Page) => page.evaluate(() => (window as unknown as Hooks).__webterm.lastLocate())
/** 流里（或面板里）的命令块 —— 按头部文字找，别匹到尾块正文里回显的命令行 */
const blockOf = (root: import('@playwright/test').Locator, text: string) =>
  root.locator('.block:not(.block-tail)', { has: root.page().locator('.block-head', { hasText: text }) })

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

/** 三个块。结束标记用 printf 拆开写 —— 命令行回显里不含 ALPHA-END，等到它才是真跑完了。 */
async function threeBlocks(page: Page) {
  await submit(page, "seq 1 150; printf 'ALPHA-%s\\n' END")
  await waitFor(async () => (await terminalText(page)).includes('ALPHA-END'), 'A 跑完', 15_000)
  await submit(page, "seq 200 350; printf 'BETA-%s\\n' END")
  await waitFor(async () => (await terminalText(page)).includes('BETA-END'), 'B 跑完', 15_000)
  await submit(page, "printf 'GAMMA-%s\\n' LAST")
  await waitFor(async () => (await terminalText(page)).includes('GAMMA-LAST'), 'C 跑完')
}

test('读视图里点「在终端里看」：切到终端并滚到该块输出的第一行', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await threeBlocks(page)

  // 块 A：展开 → 在终端里看
  const a = blockOf(page.getByTestId('stream'), 'seq 1 150')
  await expect(a).toBeVisible()
  await a.locator('.block-head').click()
  await a.locator('[data-testid$="-term"]').click()
  await waitFor(async () => (await view(page)) === 'term', '切到终端')
  await waitFor(async () => (await viewport(page)).top.trim() === '1', '视口顶行是块 A 的第一行输出', 5_000)
  expect(await lastLocate(page), '靠 marker 精确定位，不是搜索兜底').toBe('marker')
  const vpA = await viewport(page)
  expect(vpA.y, '不是简单滚到顶').toBeGreaterThan(0)

  // 回读，再看块 B
  await page.getByTestId('view-toggle').click()
  await waitFor(async () => (await view(page)) === 'read', '回到读')
  const b = blockOf(page.getByTestId('stream'), 'seq 200 350')
  await expect(b).toBeVisible()
  await b.locator('.block-head').click()
  await b.locator('[data-testid$="-term"]').click()
  await waitFor(async () => (await view(page)) === 'term', '切到终端')
  await waitFor(async () => (await viewport(page)).top.trim() === '200', '视口顶行是块 B 的第一行输出', 5_000)
  expect((await viewport(page)).y).toBeGreaterThan(vpA.y)
  expect(await lastLocate(page)).toBe('marker')
})

test('终端视图的「块」面板里同样能定位，并顺手关掉面板', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await threeBlocks(page)

  await page.getByTestId('view-toggle').click()
  await waitFor(async () => (await view(page)) === 'term', '终端视图')
  await page.getByTestId('open-more').click()
  await page.getByTestId('open-blocks').click()
  const panel = page.getByTestId('blocks-panel')
  await expect(panel).toBeVisible()
  const a = blockOf(panel, 'seq 1 150')
  await expect(a).toBeVisible()
  await a.locator('.block-head').click()
  await a.locator('[data-testid$="-term"]').click()
  await expect(panel).toHaveCount(0)
  await waitFor(async () => (await viewport(page)).top.trim() === '1', '视口顶行是块 A 的第一行输出', 5_000)
  expect(await lastLocate(page)).toBe('marker')
})
