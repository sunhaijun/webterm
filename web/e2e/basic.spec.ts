import { expect, test } from '@playwright/test'

import { Agent, submit, termSize, terminalText, waitFor } from './harness'

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

/** E2E-1 基础往返 —— AC-1.3, AC-1.9, AC-4.1。 */
test('E2E-1 配对 → 建会话 → 敲命令 → 看到输出', async ({ page, context }) => {
  await agent.pair(page)

  // Cookie 属性正确（AC-1.9）
  const cookie = (await context.cookies()).find((c) => c.name === 'webterm_session')
  expect(cookie, '配对成功应当下发会话 Cookie').toBeTruthy()
  expect(cookie!.httpOnly, 'Cookie 必须 HttpOnly').toBe(true)
  expect(cookie!.sameSite, 'Cookie 必须 SameSite=Strict').toBe('Strict')

  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  await submit(page, 'printf "HELLO-%s\\n" WEBTERM')
  await waitFor(async () => (await terminalText(page)).includes('HELLO-WEBTERM'), '终端出现输出')

  // PTY 的尺寸必须和前端算出来的 cols/rows 一致 —— 对不上的话
  // 换行位置就会错，所有跟布局有关的东西都跟着错
  const size = await termSize(page)
  await submit(page, 'stty size')
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

/** 配对码是一次性的：同一个链接开第二次必须失败（AC-1.4）。 */
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
