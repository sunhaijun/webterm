import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, submit, terminalText, waitFor } from './harness'

/**
 * 终端视图里读 claude / codex 长回答的五件小事（E2E-22，层 1）：
 * ① 占屏程序里不显示「没有集成」横幅 ② 键条可收起 / 横屏隐藏状态栏
 * ③ AI CLI 专用键条 ④ 滚上去时「↓ 有新输出」 ⑤ 复制屏幕 / 最近 200 行
 */
const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
test.use({ ...PIXEL, launchOptions: { args: ['--disable-webgl'] }, permissions: ['clipboard-read', 'clipboard-write'] })
test.setTimeout(90_000)

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

const view = (p: Page) => p.evaluate(() => (window as unknown as { __webterm: { view(): string } }).__webterm.view())
const rows = (p: Page) => p.evaluate(() => (window as unknown as { __webterm: { size(): { rows: number } } }).__webterm.size().rows)
/** 终端视图里直接打字给 PTY。 */
const typeTerm = async (p: Page, s: string) => {
  await p.getByTestId('term-type').click()
  await p.keyboard.type(s, { delay: 5 })
}
const toTerm = async (p: Page) => {
  await p.getByTestId('view-toggle').click()
  await waitFor(async () => (await view(p)) === 'term', '切到终端')
}

test('③ claude / codex 拿到 AI 键条：⇧Tab 发 CSI Z，没有 q，有翻页 / 跳底', async ({ page }) => {
  const sent: string[] = []
  await page.exposeFunction('__rec', (x: string) => sent.push(x))
  await page.addInitScript(() => {
    const send = WebSocket.prototype.send
    WebSocket.prototype.send = function (d: unknown) {
      try {
        const buf = d instanceof ArrayBuffer ? d : (d as { buffer?: ArrayBuffer })?.buffer
        if (buf) {
          const u = new Uint8Array(buf)
          let x = ''
          for (let i = 0; i < u.length; i++) {
            const c = u[i]!
            x += c >= 32 && c < 127 ? String.fromCharCode(c) : '.'
          }
          ;(window as unknown as { __rec(s: string): void }).__rec(x)
        }
      } catch {
        /* ignore */
      }
      return send.call(this, d as never)
    }
  })
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  // 用 shell 函数冒充 claude：程序名取最后一段 → claude；键盘协议入栈 → 占屏
  await submit(page, "claude() { printf '\\033[>1u'; sleep 60; }; claude")
  await waitFor(async () => (await view(page)) === 'term', '进终端', 10_000)
  await expect(page.getByTestId('keybar')).toHaveAttribute('data-context', 'claude')
  await expect(page.getByTestId('key-ShiftTab')).toBeVisible()
  await expect(page.getByTestId('key-PageUpView')).toBeVisible()
  await expect(page.getByTestId('key-ToBottom')).toBeVisible()
  await expect(page.getByTestId('key-tui-q')).toHaveCount(0)
  sent.length = 0
  await page.getByTestId('key-ShiftTab').click()
  await waitFor(async () => sent.some((x) => x.endsWith('.[Z')), '⇧Tab → ESC [ Z 直达 PTY', 3_000)
  await page.getByTestId('key-CtrlC').click()
})

test('① 占屏程序里不显示「没有集成」横幅；子 shell 里照常显示', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await submit(page, 'bash --norc --noprofile')
  await page.waitForTimeout(600)
  await toTerm(page)
  // 子 shell 里两次 Enter 有回应却无标记 → 横幅出现（同 liveness.spec）
  await typeTerm(page, 'echo INSUB-1\n')
  await waitFor(async () => (await terminalText(page)).includes('INSUB-1'), '子 shell 有回应')
  await page.waitForTimeout(2500)
  await typeTerm(page, 'echo INSUB-2\n')
  await waitFor(async () => (await terminalText(page)).includes('INSUB-2'), '子 shell 再次回应')
  await expect(page.getByTestId('unmarked')).toBeVisible({ timeout: 10_000 })
  // 子 shell 里起了占屏程序（键盘协议）→ 横幅让位：那是用户在用程序，不是 shell 坏了
  await typeTerm(page, "printf '\\033[>1u'\n")
  await expect(page.getByTestId('unmarked')).toHaveCount(0, { timeout: 5_000 })
  await typeTerm(page, 'exit\n')
})

test('④ 滚上去读的时候来了新输出 → 「↓ 有新输出」，点它回到底部', async ({ page }) => {
  const tv = () => page.evaluate(() => (window as unknown as { __webterm: { termView(): { viewportY: number; baseY: number } } }).__webterm.termView())
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await submit(page, 'seq 1 400')
  // xterm 是异步分片解析的：屏上出现 400 时回滚可能还没填完，等 baseY 起来再滚，否则"滚到顶"其实是在空缓冲上
  await waitFor(async () => (await tv()).baseY > 350, '回滚填完', 10_000)
  // 4 秒后有一条后台输出（标记拆开写，免得命令回显先匹配上）；这期间我们滚到顶上去读
  await submit(page, '(sleep 4; echo NEW-OUT-$((1+1))-ARRIVED) &')
  await toTerm(page)
  // 用真实的滚轮手势滚（走 xterm 自己的滚动路径，和手指滑动一致）
  await page.mouse.move(200, 400)
  await page.mouse.wheel(0, -50_000)
  await waitFor(async () => (await tv()).viewportY === 0, '滚到顶', 5_000)
  await expect(page.getByTestId('new-output')).toHaveCount(0)
  await waitFor(async () => (await terminalText(page)).includes('NEW-OUT-2-ARRIVED'), '后台输出到了', 10_000)
  await expect(page.getByTestId('new-output')).toBeVisible({ timeout: 3_000 })
  // 没跟着跳：还在顶上读
  expect((await tv()).viewportY).toBe(0)
  await page.getByTestId('new-output').click()
  await expect(page.getByTestId('new-output')).toHaveCount(0)
  const v = await tv()
  expect(v.viewportY).toBe(v.baseY)
})

test('② 键条可收起：多出两行多；展开恢复；横屏终端视图状态栏让位', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  // 键条（连同收起把手）只在命令跑着（raw）时出现 —— 读长回答正是这个时候
  await submit(page, 'sleep 60')
  await page.waitForTimeout(600)
  await toTerm(page)
  const r0 = await rows(page)
  await page.getByTestId('bar-collapse').click()
  await expect(page.getByTestId('keybar')).toHaveCount(0)
  await expect(page.getByTestId('bar-expand')).toBeVisible()
  await waitFor(async () => (await rows(page)) > r0, `收起后行数 > ${r0}`, 5_000)
  await page.getByTestId('bar-expand').click()
  await expect(page.getByTestId('keybar')).toBeVisible()
  await waitFor(async () => (await rows(page)) === r0, '展开后行数恢复', 5_000)
  // 横屏：状态栏隐藏，会话入口在 ⋯ 里
  await page.setViewportSize({ width: 851, height: 393 })
  await expect(page.getByTestId('statusbar')).toBeHidden()
  await page.getByTestId('keybar').getByTestId('open-more').click()
  await expect(page.getByTestId('open-sessions')).toBeVisible()
  await page.getByTestId('more-backdrop').click({ position: { x: 8, y: 8 } })
  await page.setViewportSize({ width: 393, height: 727 })
  await expect(page.getByTestId('statusbar')).toBeVisible()
})

test('⑤ ⋯ → 复制屏幕：剪贴板拿到屏上文本，有回执', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await submit(page, "printf 'COPY-%s\\n' A B C")
  await waitFor(async () => (await terminalText(page)).includes('COPY-C'), '输出到了')
  await toTerm(page)
  await page.getByTestId('open-more').click()
  await page.getByTestId('copy-screen').click()
  await expect(page.getByTestId('toast')).toContainText('已复制')
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toContain('COPY-A')
  expect(clip).toContain('COPY-C')
})
