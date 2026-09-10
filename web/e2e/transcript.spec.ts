import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, submit, waitFor } from './harness'

/**
 * E2E-23 转录视图（ADR-0012 γ）：claude 在前台时读视图是对话卡片 + 终端尾巴，不自动跳终端；
 * Composer 整段发送进程序；刷新页面后靠 HTTP 回放补齐；命令结束回到块流。
 *
 * 用 shell 函数冒充 claude：键盘协议入栈（占屏）+ 往 WEBTERM_TRANSCRIPT_HOME 下的会话文件写 JSONL。
 */
const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
test.use({ ...PIXEL, launchOptions: { args: ['--disable-webgl'] } })
test.setTimeout(90_000)

let agent: Agent
test.beforeEach(async () => {
  // agent 从 process.env 继承；会话 shell 又从 agent 继承 —— 假 claude 就往这里写
  process.env.WEBTERM_TRANSCRIPT_HOME = mkdtempSync(join(tmpdir(), 'webterm-tr-'))
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

const view = (p: Page) => p.evaluate(() => (window as unknown as { __webterm: { view(): string } }).__webterm.view())

const USER = '{"type":"user","uuid":"u1","message":{"role":"user","content":"请解释 context 包"}}'
// 命令行别太长：OSC 1701 的命令文本有长度上限，超了就没有块、也就认不出程序名
const ASSISTANT =
  '{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":[{"type":"text","text":"## context\\n\\n用于**取消**。\\n\\n```go\\nfunc main() {}\\n```"},{"type":"tool_use","name":"Bash","input":{"command":"go test ./..."}}]}}'
// 假 claude：占屏 → 打一行 → 写两行 JSONL → 等一行输入回显 → 长睡
const FAKE_CLAUDE =
  `claude() { d="$WEBTERM_TRANSCRIPT_HOME/.claude/projects/$(pwd | sed 's/[^A-Za-z0-9]/-/g')"; mkdir -p "$d"; f="$d/e2e.jsonl"; printf '\\033[>1u'; echo claude-fake-running; sleep 0.4; ` +
  `echo '${USER}' >> "$f"; sleep 0.4; echo '${ASSISTANT}' >> "$f"; read -r x; echo "GOT-$x"; sleep 60; }; claude`

test('claude 在前台：留在读视图，转录卡片 + 终端尾巴；Composer 发送进程序；结束回块流', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  expect(await view(page)).toBe('read')

  await submit(page, FAKE_CLAUDE)
  // 转录视图取代块流；占屏了也不跳终端
  await expect(page.getByTestId('transcript')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('transcript-tail-lines')).toContainText('claude-fake-running', { timeout: 10_000 })
  await page.waitForTimeout(1200)
  expect(await view(page), '占屏但是 AI CLI → 不自动进终端').toBe('read')
  await expect(page.getByTestId('keybar')).toHaveAttribute('data-context', 'claude')

  // 对话卡片：用户、助手（Markdown 渲染成了 h2 / 代码块）、工具摘要
  await expect(page.getByTestId('tr-user')).toContainText('请解释 context 包', { timeout: 10_000 })
  const asst = page.getByTestId('tr-assistant')
  await expect(asst.locator('h2')).toHaveText('context', { timeout: 10_000 })
  await expect(asst.locator('strong')).toHaveText('取消')
  await expect(asst.locator('pre code')).toContainText('func main() {}')
  await expect(page.getByTestId('tr-tool')).toContainText('go test ./...')
  await expect(page.getByTestId('tr-tool').locator('.tr-tool-name')).toHaveText('Bash')

  // Composer 整段发送 → 程序读到 → 尾巴条看到回显
  const composer = page.getByTestId('composer')
  await composer.fill('hello-tr')
  await composer.press('Enter')
  await expect(page.getByTestId('transcript-tail-lines')).toContainText('GOT-hello-tr', { timeout: 10_000 })

  // 点尾巴进终端；回读转录仍在
  await page.getByTestId('transcript-tail').click()
  await waitFor(async () => (await view(page)) === 'term', '进终端')
  await page.getByTestId('keybar').getByTestId('view-toggle').click()
  await waitFor(async () => (await view(page)) === 'read', '回读')
  await expect(page.getByTestId('tr-assistant')).toBeVisible()

  // 结束：^C → 命令结束 → 回到块流
  await page.getByTestId('key-CtrlC').click()
  await expect(page.getByTestId('stream')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('transcript')).toHaveCount(0)
})

test('刷新页面：转录靠 GET /api/transcript 回放，卡片回来且不重复', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await submit(page, FAKE_CLAUDE)
  await expect(page.getByTestId('tr-user')).toContainText('请解释 context 包', { timeout: 10_000 })
  await expect(page.getByTestId('tr-assistant').locator('h2')).toHaveText('context', { timeout: 10_000 })

  // 刷新：WS 增量都没了，靠 HTTP 回放补齐
  await page.reload()
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await expect(page.getByTestId('transcript')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('tr-assistant').locator('h2')).toHaveText('context', { timeout: 10_000 })
  await expect(page.getByTestId('tr-user'), '回放去重，用户气泡只有一个').toHaveCount(1)
})

test('不是 AI 的占屏程序照旧自动进终端', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await submit(page, "printf '\\033[>1u'; sleep 30")
  await waitFor(async () => (await view(page)) === 'term', '非 AI 占屏 → 自动进终端', 10_000)
  await expect(page.getByTestId('transcript')).toHaveCount(0)
  await page.getByTestId('key-CtrlC').click()
})
