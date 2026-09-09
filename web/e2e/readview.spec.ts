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

  test('失败的块在【跑完那一刻】自动展开，成功的保持折叠', async ({ page }) => {
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')

    await submit(page, 'printf "GOOD-OUT\\n"')
    await waitFor(async () => (await terminalText(page)).includes('GOOD-OUT'), '成功命令跑完')
    await submit(page, 'printf "BAD-OUT\\n"; false')
    await waitFor(async () => (await terminalText(page)).includes('BAD-OUT'), '失败命令跑完')

    const stream = page.getByTestId('stream')
    const good = stream.locator('.block', { hasText: 'GOOD-OUT' }).first()
    const bad = stream.locator('.block', { hasText: 'BAD-OUT' }).first()
    await expect(bad).toHaveAttribute('data-failed', 'true')
    // 块出现时还在跑、退出码未知 —— 展开必须发生在拿到 exit 1 之后
    await expect(bad).toHaveAttribute('data-open', 'true', { timeout: 10_000 })
    await expect(bad.locator('.block-out')).toContainText('BAD-OUT')
    await expect(good).toHaveAttribute('data-open', 'false')

    // 用户手动折叠失败块后，后续重渲染不能把它再撑开
    await bad.locator('.block-head').click()
    await expect(bad).toHaveAttribute('data-open', 'false')
    await submit(page, 'printf "LATER\\n"')
    await waitFor(async () => (await terminalText(page)).includes('LATER'), '又跑了一条')
    await expect(bad).toHaveAttribute('data-open', 'false')
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

  test('无输出的命令（cd）展开后不显示空的黑面板', async ({ page }) => {
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')
    await submit(page, 'cd /tmp')
    await page.waitForTimeout(500)
    await submit(page, "printf 'HAS-%s\\n' OUT")
    await waitFor(async () => (await terminalText(page)).includes('HAS-OUT'), '有输出的那条跑完')
    await page.waitForTimeout(300)
    const cd = page
      .getByTestId('stream')
      .locator('.block:not(.block-tail)', { has: page.locator('.block-head', { hasText: 'cd /tmp' }) })
    await cd.locator('.block-head').click()
    await page.waitForTimeout(200)
    expect(await cd.locator('.block-out').count(), 'cd 无输出不该有黑面板').toBe(0)
    // 有输出的块仍正常显示面板
    const has = page
      .getByTestId('stream')
      .locator('.block:not(.block-tail)', { has: page.locator('.block-head', { hasText: 'printf' }) })
    await has.locator('.block-head').click()
    await page.waitForTimeout(200)
    expect(await has.locator('.block-out').count()).toBe(1)
  })

  test('块最大化铺满整屏、可滚动，恢复后回到内联', async ({ page }) => {
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')

    await submit(page, "seq 1 80; printf 'DONE-%s\\n' OK")
    await waitFor(async () => (await terminalText(page)).includes('DONE-OK'), '命令跑完', 15_000)
    const blk = page
      .getByTestId('stream')
      .locator('.block:not(.block-tail)', { has: page.locator('.block-head', { hasText: 'seq 1 80' }) })
    await blk.locator('.block-head').click()
    await blk.locator('[data-testid$="-maximize"]').click()

    const wrap = page.locator('[data-testid$="-maxwrap"]')
    await expect(wrap).toBeVisible()
    const box = await wrap.boundingBox()
    const vp = page.viewportSize()!
    expect(box!.height, '铺满整屏高度').toBeGreaterThan(vp.height * 0.9)
    expect(box!.width).toBe(vp.width)
    // 命令原文在标题栏，输出在里面（含末尾）
    await expect(wrap.locator('.block-maxbar')).toContainText('seq 1 80')
    await expect(wrap).toContainText('DONE-OK')

    await page.locator('[data-testid$="-restore"]').click()
    await expect(wrap).toHaveCount(0)
    // 恢复后块还在、仍展开
    await expect(blk).toHaveAttribute('data-open', 'true')
  })

  test('「终端」切到终端视图并能切回来', async ({ page }) => {
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')

    const sizeOf = () => page.evaluate(() => (window as unknown as { __webterm: { size(): { cols: number; rows: number } } }).__webterm.size())
    const before = await sizeOf()
    await page.getByTestId('view-toggle').click()
    expect(await view(page)).toBe('term')
    await expect(page.getByTestId('terminal')).toHaveAttribute('data-hidden', 'false')
    // 【切视图不能改 PTY 尺寸】：读与终端共用同一个几何盒，否则每次切换
    // 都给正在跑的程序发 SIGWINCH、折行全变
    await page.waitForTimeout(300)
    expect(await sizeOf()).toEqual(before)
    await expect(page.getByTestId('stream')).toHaveCount(0)
    // 终端视图里才有「块」面板入口 —— 手机上收在底栏的 ⋯ 菜单里（ADR-0011 ③）
    await page.getByTestId('open-more').click()
    await expect(page.getByTestId('open-blocks')).toBeVisible()
    await page.getByTestId('more-backdrop').click()
    await expect(page.getByTestId('more-menu')).toHaveCount(0)

    await page.getByTestId('view-toggle').click()
    expect(await view(page)).toBe('read')
    await expect(page.getByTestId('stream')).toBeVisible()

    // 选择要记住 —— 而且是【立刻】记住：切完马上刷新也不能丢
    await page.getByTestId('view-toggle').click()
    expect(await view(page)).toBe('term')
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
