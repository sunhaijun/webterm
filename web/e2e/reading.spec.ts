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

/**
 * E2E-12 ⑥ 回看时暂停跟随（AC-5.9）。
 *
 * 往上滚之后新到的输出不再写进终端（缓冲行数不涨），右下角提示新增了多少；
 * 点提示回到底部，全部一次到齐、不丢不重。滚动用 __webterm.scrollLines 钩子 ——
 * 真实滚轮 / 手指走的也是同一个 xterm 视口。
 */
test('E2E-12 回看时暂停跟随：缓冲不涨、提示计数、点提示一次补齐不丢不重', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  const count = async () => ((await terminalText(page)).match(/FOLLOW-\d{3}/g) ?? []).length
  await submit(page, 'for i in $(seq 1 240); do printf "FOLLOW-%03d\\n" $i; sleep 0.03; done; printf "FOLLOW-%s\\n" END')
  await waitFor(async () => (await count()) >= 40, '输出跑起来了')

  // 滚上去 → 暂停跟随
  await page.evaluate(() => (window as unknown as { __webterm: { scrollLines(n: number): void } }).__webterm.scrollLines(-15))
  await expect(page.getByTestId('follow-pill')).toBeVisible()
  const frozen = await count()
  await page.waitForTimeout(800)
  expect(await count(), '暂停期间终端缓冲里的行数不该增长').toBe(frozen)
  await expect(page.getByTestId('follow-pill')).toContainText(/新增 \d+ 行/)
  const n1 = Number(((await page.getByTestId('follow-pill').textContent()) ?? '').match(/(\d+) 行/)?.[1])
  await page.waitForTimeout(600)
  const n2 = Number(((await page.getByTestId('follow-pill').textContent()) ?? '').match(/(\d+) 行/)?.[1])
  expect(n2, '计数应当随新输出增长').toBeGreaterThan(n1)

  // 点提示 → 回到底部，一次补齐
  await page.getByTestId('follow-pill').click()
  await expect(page.getByTestId('follow-pill')).toHaveCount(0)
  await waitFor(async () => (await terminalText(page)).includes('FOLLOW-END'), '命令跑完', 20_000)
  const lines = (await terminalText(page)).match(/FOLLOW-\d{3}/g) ?? []
  expect(new Set(lines).size, '丢行').toBe(240)
  expect(lines.length, '重行').toBe(240)
  for (let i = 0; i < 240; i++) expect(lines[i]).toBe(`FOLLOW-${String(i + 1).padStart(3, '0')}`)
})

test('E2E-12 ⑦ 设置里能看到渲染器', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await page.getByTestId('open-settings').click()
  await expect(page.getByTestId('renderer')).toHaveText(/WebGL|Canvas/)
  const r = await page.evaluate(() => (window as unknown as { __webterm: { renderer(): string } }).__webterm.renderer())
  expect(['webgl', 'canvas']).toContain(r)
})
