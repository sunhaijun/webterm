/**
 * E2E-1 基础往返 —— AC-1.3 / AC-1.9 / AC-4.1。
 * 另含配对页的两条前端侧护栏：未配对的引导页（AC-1.7）、配对码一次性（AC-1.4 / AC-1.5）。
 */
import { expect, test } from '@playwright/test'

import { Agent, hooks, terminalText, termSize, waitFor, waitOnline } from './harness'

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

test('E2E-1 配对 → 自动建会话 → 点终端敲命令 → 看到输出，stty size 与前端一致', async ({ page, context }) => {
  await agent.pair(page)

  // Cookie 属性正确（AC-1.9）
  const cookie = (await context.cookies()).find((c) => c.name === 'webterm_session')
  expect(cookie, '配对成功应当下发会话 Cookie').toBeTruthy()
  expect(cookie!.httpOnly, 'Cookie 必须 HttpOnly').toBe(true)
  expect(cookie!.sameSite, 'Cookie 必须 SameSite=Strict').toBe('Strict')

  await page.goto(agent.baseURL)
  await waitOnline(page)
  // 第一次连上、一个会话都没有 → 自动建一个
  await waitFor(async () => (await hooks.sid(page)) !== null, '自动建了第一个会话')

  // 点终端，直接打字（没有输入模式，ADR-0025）
  await page.getByTestId('terminal').click({ position: { x: 80, y: 80 } })
  await page.keyboard.type('echo hello-webterm')
  await page.keyboard.press('Enter')
  // 【断言输出行，不是回显行】：回显的命令行里也含 hello-webterm
  await waitFor(
    async () => (await terminalText(page)).split('\n').some((l) => l.trimEnd() === 'hello-webterm'),
    '终端出现 hello-webterm 这一行输出',
  )

  // PTY 的尺寸必须和前端算出来的 cols/rows 一致 —— 对不上的话
  // 换行位置就会错，所有跟布局有关的东西都跟着错
  const size = await termSize(page)
  expect(size.cols).toBeGreaterThan(20)
  await page.keyboard.type('stty size')
  await page.keyboard.press('Enter')
  await waitFor(
    async () => new RegExp(`^${size.rows} ${size.cols}$`, 'm').test(await terminalText(page)),
    `stty size 输出 "${size.rows} ${size.cols}"`,
  )
})

/** 未配对时给明确的引导页，而不是空白（AC-1.7 的前端一侧）。 */
test('未配对时展示配对引导', async ({ page }) => {
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('unpaired')).toBeVisible()
  await expect(page.getByTestId('unpaired')).toContainText('webterm pair')
})

/** 配对码是一次性的：同一个链接开第二次必须失败（AC-1.4），且不留在历史里（AC-1.5）。 */
test('配对码用过即废', async ({ page, browser }) => {
  await agent.pair(page)

  const second = await browser.newContext()
  const p2 = await second.newPage()
  await p2.goto(agent.pairLink())
  // 第二次必须停在配对页并说明原因，而不是悄悄放行
  await expect(p2.getByTestId('pair-status')).toContainText(/无效|过期/)
  expect(new URL(p2.url()).pathname, '失败时不该跳进主界面').toBe('/pair')

  // 配对码也【不能】留在浏览器历史里（AC-1.5）
  expect(p2.url(), '配对码应当被 replaceState 抹掉').not.toContain('#')
  await second.close()
})
