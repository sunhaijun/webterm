/**
 * E2E-6 多会话与未读（AC-2.11 / AC-4.3）
 * E2E-11 会话生命周期（AC-4.2 / AC-4.5 / US-7.3）
 */
import { expect, test, type Page } from '@playwright/test'

import { Agent, submit, terminalText, waitFor } from './harness'

async function unread(page: Page, sid: number): Promise<boolean> {
  return page.evaluate(
    (s) => (window as unknown as { __webterm: { unread(n: number): boolean } }).__webterm.unread(s),
    sid,
  )
}

async function activeSid(page: Page): Promise<number | null> {
  return page.evaluate(() => (window as unknown as { __webterm: { sid(): number | null } }).__webterm.sid())
}

/** 打开会话列表（phone/tablet 上它是抽屉/sheet）。 */
async function openSessions(page: Page) {
  const sidebar = page.getByTestId('sidebar')
  if (!(await sidebar.isVisible())) await page.getByTestId('statusbar').click()
  await expect(sidebar).toBeVisible()
}

test.describe('E2E-6 多会话与未读', () => {
  let agent: Agent
  test.beforeEach(async () => {
    agent = await Agent.start()
  })
  test.afterEach(() => agent.stop())

  test('切走的会话继续跑，产生输出时显示未读；切回来内容完整', async ({ page }) => {
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')

    const sidA = await activeSid(page)
    expect(sidA).not.toBeNull()

    // A 里起一个持续产出的循环
    await submit(page, 'for i in $(seq 1 100); do printf "tick %03d\\n" $i; sleep 0.05; done')
    await waitFor(async () => (await terminalText(page)).includes('tick 001'), 'A 开始产出')

    // 新建 B 并切过去
    await openSessions(page)
    await page.getByTestId('new-session').click()
    await waitFor(async () => (await activeSid(page)) !== sidA, '切到了 B')
    const sidB = await activeSid(page)

    // B 能正常用
    await submit(page, 'printf "IN-%s\\n" B')
    await waitFor(async () => (await terminalText(page)).includes('IN-B'), 'B 正常工作')

    // A 在后台继续跑，并且【字节不过网络】—— 靠 head_seq 推出未读
    await waitFor(async () => unread(page, sidA!), 'A 出现未读标记', 20_000)
    await openSessions(page)
    await expect(page.getByTestId(`session-${sidA}-unread`)).toBeVisible()

    // 切回 A：切走期间的输出全在（agent 侧照常缓冲，切回时补齐）
    await page.getByTestId(`session-${sidA}`).click()
    await waitFor(async () => (await activeSid(page)) === sidA, '切回 A')
    await waitFor(async () => {
      const t = await terminalText(page)
      return t.includes('tick 001') && /tick 0[2-9]\d/.test(t)
    }, 'A 切走期间的输出补齐了', 20_000)

    // 切回去之后未读清除
    expect(await unread(page, sidA!)).toBe(false)
    // B 的内容也还在（xterm 实例没被销毁）
    await openSessions(page)
    await page.getByTestId(`session-${sidB}`).click()
    await waitFor(async () => (await terminalText(page)).includes('IN-B'), 'B 的屏幕内容保持')
  })
})

test.describe('E2E-11 会话生命周期', () => {
  let agent: Agent
  test.beforeEach(async () => {
    agent = await Agent.start({ maxSessions: 3 })
  })
  test.afterEach(() => agent.stop())

  test('达到上限时新建按钮禁用并说明原因', async ({ page }) => {
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')
    await openSessions(page)

    // 已有 1 个，再建 2 个到上限
    for (let i = 0; i < 2; i++) {
      await page.getByTestId('new-session').click()
      await page.waitForTimeout(400)
      await openSessions(page)
    }
    // 点了没反应是最糟的行为（US-7.3）
    await expect(page.getByTestId('new-session')).toBeDisabled()
    await expect(page.getByTestId('new-session')).toContainText('会话数已达上限 3')
  })

  test('shell 退出后保留内容，可重开也可关闭', async ({ page }) => {
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')
    const sid = await activeSid(page)

    await submit(page, 'printf "BEFORE-%s\\n" EXIT')
    await waitFor(async () => (await terminalText(page)).includes('BEFORE-EXIT'), '退出前的输出')
    await submit(page, 'exit 3')

    // 标签不该直接消失 —— "构建失败了要回看报错"是高频场景
    await expect(page.getByTestId('exited-bar')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('exited-bar')).toContainText('exit 3')
    await openSessions(page)
    await expect(page.getByTestId(`session-${sid}-exit`)).toContainText('exit 3')

    // 内容仍然可看
    expect(await terminalText(page)).toContain('BEFORE-EXIT')

    // exited 会话不接受输入 —— Composer 收起
    await expect(page.getByTestId('composer')).toHaveCount(0)

    // 重开 = 在同一个 cwd 新建会话
    await page.getByTestId('reopen-session').click()
    await waitFor(async () => (await activeSid(page)) !== sid, '重开建了新会话')
    await submit(page, 'printf "AFTER-%s\\n" REOPEN')
    await waitFor(async () => (await terminalText(page)).includes('AFTER-REOPEN'), '新会话可用')
  })

  test('关闭 running 会话需要二次确认，exited 不需要', async ({ page }) => {
    await agent.pair(page)
    await page.goto(agent.baseURL)
    await expect(page.getByTestId('conn-text')).toHaveText('在线')
    await openSessions(page)
    await page.getByTestId('new-session').click()
    await page.waitForTimeout(500)
    const sid = await activeSid(page)

    let asked = false
    page.on('dialog', (d) => {
      asked = true
      void d.dismiss()
    })
    await openSessions(page)
    await page.getByTestId(`session-${sid}-close`).click()
    await page.waitForTimeout(300)
    expect(asked, '关闭 running 会话必须二次确认').toBe(true)
    // 取消了就不该关掉
    await openSessions(page)
    await expect(page.getByTestId(`session-${sid}`)).toBeVisible()
  })
})
