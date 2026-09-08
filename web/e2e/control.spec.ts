import { devices, expect, test } from '@playwright/test'

import { Agent, submit, terminalText, waitFor } from './harness'

/**
 * 控态 —— ADR-0011 分片 ②。
 *
 * 备用屏幕缓冲（DECSET 1049）是"有程序占屏"的机械信号：vim / top / less
 * 都切它，sleep 100 不切。读视图里一进备用缓冲就自动切到终端视图，退出后
 * 自动回读；键条按前台程序换内容。手动切过视图的选择不被自动切换覆盖。
 */
const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
test.use(PIXEL)

type Hooks = { __webterm: { view(): string; altScreen(): boolean } }
const view = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as Hooks).__webterm.view())
const alt = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as Hooks).__webterm.altScreen())
const stored = (page: import('@playwright/test').Page) => page.evaluate(() => localStorage.getItem('webterm.view'))

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

test('进备用缓冲自动切到终端，退出自动回读；自动切换不写偏好', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  expect(await view(page)).toBe('read')

  // 用裸转义序列模拟一个占屏程序：进备用缓冲 → 停 2.5 秒 → 退出。
  // 不依赖机器上装了什么 TUI，结论只关乎信号本身。
  await submit(page, "printf '\\033[?1049h'; sleep 2.5; printf '\\033[?1049l'")
  await waitFor(async () => (await alt(page)) === true, '备用缓冲激活', 10_000)
  expect(await view(page)).toBe('term')
  await expect(page.getByTestId('terminal')).toHaveAttribute('data-hidden', 'false')
  // 不认识的程序 → 通用 TUI 键条，Esc / ^C 在
  await expect(page.getByTestId('keybar')).toHaveAttribute('data-context', /printf|tui/)
  await expect(page.getByTestId('key-Escape')).toBeVisible()
  await expect(page.getByTestId('key-CtrlC')).toBeVisible()

  await waitFor(async () => (await alt(page)) === false, '备用缓冲退出', 10_000)
  await waitFor(async () => (await view(page)) === 'read', '自动回到读', 5_000)
  await expect(page.getByTestId('keybar')).toHaveAttribute('data-context', 'shell')
  // 自动切换是临时的，不能把用户偏好改成 term
  expect(await stored(page)).not.toBe('term')
})

test('less 占屏：键条换成分页器键，按 q 退出后回读', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  await submit(page, "command -v less >/dev/null && printf 'HAS-%s\\n' LESS || printf 'NO-%s\\n' LESS")
  await waitFor(async () => /HAS-LESS|NO-LESS/.test(await terminalText(page)), '探测 less')
  test.skip((await terminalText(page)).includes('NO-LESS'), '这台机器没有 less')

  await submit(page, 'less /etc/hostname')
  await waitFor(async () => (await alt(page)) === true, 'less 进了备用缓冲', 10_000)
  expect(await view(page)).toBe('term')
  await expect(page.getByTestId('keybar')).toHaveAttribute('data-context', 'less')
  await expect(page.getByTestId('keybar-context')).toHaveText('less')

  // 分页器键：q 退出
  await page.getByTestId('key-pager-quit').click()
  await waitFor(async () => (await alt(page)) === false, 'less 退出', 10_000)
  await waitFor(async () => (await view(page)) === 'read', '回到读', 5_000)
  // 那条命令在块流里是完成态
  await expect(page.getByTestId('stream').locator('.block', { hasText: 'less /etc/hostname' })).toHaveAttribute(
    'data-running',
    'false',
    { timeout: 10_000 },
  )
})

test('用户手动选了终端视图：备用缓冲进出都不改它', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  await page.getByTestId('view-toggle').click() // 手动 → term（持久化）
  expect(await view(page)).toBe('term')

  await submit(page, "printf '\\033[?1049h'; sleep 1.5; printf '\\033[?1049l'")
  await waitFor(async () => (await alt(page)) === true, '备用缓冲激活', 10_000)
  expect(await view(page)).toBe('term')
  await waitFor(async () => (await alt(page)) === false, '备用缓冲退出', 10_000)
  await page.waitForTimeout(400)
  // 不是自动切过去的，就不该自动切回来
  expect(await view(page)).toBe('term')
  expect(await stored(page)).toBe('term')
})
