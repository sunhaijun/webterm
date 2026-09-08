import { devices, expect, test } from '@playwright/test'

// describe 里的 test.use 只能改测试级选项；devices[] 带的 defaultBrowserType 是 worker 级，
// 直接展开会报错，所以剥掉它。
const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
const { defaultBrowserType: _d, ...DESKTOP } = devices['Desktop Chrome']!

import { Agent, submit, terminalText, waitFor } from './harness'

/**
 * 读视图 —— ADR-0011 分片 ①。
 *
 * 手机默认看到的是命令块流，不是终端网格；xterm 保活隐藏；命令在跑时
 * 底栏变成直发输入行；没有标记时输出落进尾块。
 */
test.describe('手机：读视图是默认', () => {
  test.use(PIXEL)

  let agent: Agent
  test.beforeEach(async () => {
    agent = await Agent.start()
  })
  test.afterEach(() => agent.stop())

  const view = (page: import('@playwright/test').Page) =>
    page.evaluate(() => (window as unknown as { __webterm: { view(): string } }).__webterm.view())

  test('默认读视图：块流可见，xterm 隐藏但保持尺寸', async ({ page }) => {
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')

    expect(await view(page)).toBe('read')
    await expect(page.getByTestId('stream')).toBeVisible()
    await expect(page.getByTestId('terminal')).toHaveAttribute('data-hidden', 'true')

    // xterm 虽不可见，尺寸必须是真的 —— PTY 的 cols/rows 靠它
    const size = await page.evaluate(() => (window as unknown as { __webterm: { size(): { cols: number; rows: number } } }).__webterm.size())
    expect(size.cols).toBeGreaterThan(20)
    expect(size.rows).toBeGreaterThan(5)
  })

  test('跑一条命令：块出现在流里，结束后精确渲染', async ({ page }) => {
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')

    await submit(page, 'printf "READ-%s\\n" ONE')
    await waitFor(async () => (await terminalText(page)).includes('READ-ONE'), '命令跑完')

    const stream = page.getByTestId('stream')
    const block = stream.locator('.block', { hasText: 'READ-' }).first()
    await expect(block).toBeVisible()
    await expect(block).toHaveAttribute('data-running', 'false')
    // 成功的块默认折叠；点开能看到输出
    await block.locator('.block-head').click()
    await expect(block.locator('.block-out')).toContainText('READ-ONE')
  })

  test('运行中的块 live-tail，底栏变成直发输入行', async ({ page }) => {
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')

    // 一个会持续输出、并且读 stdin 的程序：先吐两行，然后等一行输入再退出
    await submit(page, 'printf "tick-1\\n"; sleep 0.3; printf "tick-2\\n"; read -r x; printf "GOT-%s\\n" "$x"')
    const running = page.getByTestId('stream').locator('.block[data-running="true"]')
    await expect(running).toBeVisible({ timeout: 10_000 })
    // live-tail：命令还没结束就能在块里看到已产出的行
    await expect(running.locator('.block-live')).toContainText('tick-2', { timeout: 10_000 })

    // 命令在跑 → Raw → 直发输入行出现（Composer 收起）
    const raw = page.getByTestId('raw-input')
    await expect(raw).toBeVisible()
    await raw.fill('hello-from-rawline')
    await raw.press('Enter')

    await waitFor(async () => (await terminalText(page)).includes('GOT-hello-from-rawline'), '直发输入到达了程序')
    // 结束后块不再 running，输入行让位给 Composer
    await expect(page.getByTestId('stream').locator('.block', { hasText: 'GOT-' }).first()).toHaveAttribute(
      'data-running',
      'false',
      { timeout: 10_000 },
    )
    await expect(raw).toHaveCount(0)
  })

  test('「终端」切到终端视图并能切回来', async ({ page }) => {
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')

    await page.getByTestId('view-toggle').click()
    expect(await view(page)).toBe('term')
    await expect(page.getByTestId('terminal')).toHaveAttribute('data-hidden', 'false')
    await expect(page.getByTestId('stream')).toHaveCount(0)
    // 终端视图里才有「块」面板入口
    await expect(page.getByTestId('open-blocks')).toBeVisible()

    await page.getByTestId('view-toggle').click()
    expect(await view(page)).toBe('read')
    await expect(page.getByTestId('stream')).toBeVisible()

    // 选择要记住
    await page.getByTestId('view-toggle').click()
    await page.reload()
    await expect(page.getByTestId('conn-text')).toHaveText('在线')
    expect(await view(page)).toBe('term')
  })

  test('没有集成的子 shell：输出落进正在跑的块，exit 后正常切块', async ({ page }) => {
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')

    await submit(page, 'bash --norc --noprofile')
    const raw = page.getByTestId('raw-input')
    await expect(raw).toBeVisible({ timeout: 10_000 })
    await raw.fill('echo INSUB-READ')
    await raw.press('Enter')
    // 子 shell 没有标记：它的输出就是 bash 这个块的 live-tail
    await expect(page.getByTestId('stream').locator('.block[data-running="true"] .block-live')).toContainText(
      'INSUB-READ',
      { timeout: 10_000 },
    )
    await raw.fill('exit')
    await raw.press('Enter')
    await expect(page.getByTestId('stream').locator('.block', { hasText: 'bash --norc' })).toHaveAttribute(
      'data-running',
      'false',
      { timeout: 10_000 },
    )
  })
})

test.describe('桌面：默认终端视图', () => {
  test.use(DESKTOP)

  let agent: Agent
  test.beforeEach(async () => {
    agent = await Agent.start()
  })
  test.afterEach(() => agent.stop())

  test('桌面默认终端，块流不渲染，仍可切到读', async ({ page }) => {
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')
    await expect(page.getByTestId('terminal')).toHaveAttribute('data-hidden', 'false')
    await expect(page.getByTestId('stream')).toHaveCount(0)
    await page.getByTestId('view-toggle').click()
    await expect(page.getByTestId('stream')).toBeVisible()
  })
})
