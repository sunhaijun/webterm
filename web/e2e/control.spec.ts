import { devices, expect, test } from '@playwright/test'

import { Agent, submit, terminalText, waitFor } from './harness'

/**
 * 占屏检测 —— ADR-0013：终端始终是唯一显示面，占屏不再切视图，而是【换键条上下文】。
 *
 * 占屏的机械信号：备用缓冲（DECSET 1049，vim/less/top）、富键盘协议（Kitty \e[>1u /
 * modifyOtherKeys，claude/codex）、应用光标键（DECCKM \e[?1h，top）。命令在跑 → Raw →
 * 键条出现；键条按前台程序换内容（less→分页器、top→top、claude→AI、其余→通用 TUI）。
 * npm/cargo 多行进度条【不】建立这些模式，不该被判占屏。
 */
const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
test.use(PIXEL)

type Hooks = { __webterm: { altScreen(): boolean; interactive(): boolean; program(): string | null } }
const alt = (p: import('@playwright/test').Page) => p.evaluate(() => (window as unknown as Hooks).__webterm.altScreen())
const interactive = (p: import('@playwright/test').Page) => p.evaluate(() => (window as unknown as Hooks).__webterm.interactive())

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

test('备用缓冲 = 占屏：键条出现且是通用 TUI 键；退出后键条退场', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  await submit(page, "printf '\\033[?1049h'; sleep 2.5; printf '\\033[?1049l'")
  await waitFor(async () => (await alt(page)) === true, '备用缓冲激活', 10_000)
  await expect(page.getByTestId('keybar')).toHaveAttribute('data-context', /printf|tui/)
  await expect(page.getByTestId('key-Escape')).toBeVisible()
  await expect(page.getByTestId('key-CtrlC')).toBeVisible()

  await waitFor(async () => (await alt(page)) === false, '备用缓冲退出', 10_000)
  // 回到 prompt（Composer 模式）→ 键条退场
  await expect(page.getByTestId('keybar')).toHaveCount(0, { timeout: 8_000 })
})

test('富键盘协议（\\e[>1u，claude/codex 那类主屏程序）= 占屏', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await submit(page, "printf '\\033[>1u\\033[?25l'; sleep 3; printf '\\033[<u\\033[?25h\\n'")
  await waitFor(async () => (await interactive(page)) === true, '被识别为占屏', 10_000)
  expect(await alt(page), '这类程序不切备用缓冲').toBe(false)
  await expect(page.getByTestId('keybar')).toBeVisible()
  await waitFor(async () => (await interactive(page)) === false, '退出占屏', 12_000)
})

test('应用光标键（DECCKM \\e[?1h，top 那类）= 占屏', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await submit(page, "printf '\\033[?1h\\033[?25l'; for i in $(seq 1 12); do printf '\\033[H\\033[Jframe %s\\n' $i; sleep 0.2; done; printf '\\033[?1l\\033[?25h\\n'")
  await waitFor(async () => (await interactive(page)) === true, 'DECCKM 占屏', 10_000)
  expect(await alt(page), '不切备用缓冲').toBe(false)
  await waitFor(async () => (await interactive(page)) === false, '退出占屏', 12_000)
})

test('多行进度条（npm/cargo：藏光标 + 上移重绘，不建立键盘协议）不误判为占屏', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await submit(page, "printf '\\033[?25l'; for n in $(seq 1 8); do printf 'idealTree\\nreify\\nbuild\\n'; printf '\\033[3A'; sleep 0.12; done; printf '\\033[?25h\\ndone PROGRESS\\n'")
  for (let k = 0; k < 10; k++) {
    expect(await interactive(page), '进度条不该被判占屏').toBe(false)
    await page.waitForTimeout(120)
  }
  await waitFor(async () => (await terminalText(page)).includes('done PROGRESS'), '进度条跑完')
})

test('占屏程序（DECCKM）运行中刷新页面：重连后仍判占屏、键条仍在', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await submit(page, "printf '\\033[?1h\\033[?25l'; sleep 30; printf '\\033[?1l\\033[?25h'")
  await waitFor(async () => (await interactive(page)) === true, '进占屏', 10_000)
  await page.waitForTimeout(1000)
  await page.reload()
  await expect(page.getByTestId('conn-text')).toHaveText('在线', { timeout: 15_000 })
  await waitFor(async () => (await interactive(page)) === true, '重连后仍占屏', 8_000)
  await expect(page.getByTestId('keybar')).toBeVisible()
})

test('less 占屏：键条换成分页器键，按 q 退出', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  await submit(page, "command -v less >/dev/null && printf 'HAS-%s\\n' LESS || printf 'NO-%s\\n' LESS")
  await waitFor(async () => /HAS-LESS|NO-LESS/.test(await terminalText(page)), '探测 less')
  test.skip((await terminalText(page)).includes('NO-LESS'), '这台机器没有 less')

  await submit(page, 'less /etc/hostname')
  await waitFor(async () => (await alt(page)) === true, 'less 进了备用缓冲', 10_000)
  await expect(page.getByTestId('keybar')).toHaveAttribute('data-context', 'less')
  await expect(page.getByTestId('keybar-context')).toHaveText('less')

  await page.getByTestId('key-pager-quit').click()
  await waitFor(async () => (await alt(page)) === false, 'less 退出', 10_000)
})

test('Composer 整段粘贴发送：数字选项 + 回车分两帧送进程序', async ({ page }) => {
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
          for (let i = 0; i < u.length; i++) { const c = u[i]!; x += c >= 32 && c < 127 ? String.fromCharCode(c) : '.' }
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
  await submit(page, "printf '\\033[>1u\\033[?25l'; sleep 60")
  await waitFor(async () => (await interactive(page)) === true, '占屏', 10_000)

  sent.length = 0
  const composer = page.getByTestId('composer')
  await composer.fill('2')
  await composer.press('Enter')
  // 送进 PTY 的字节里有 '2'，且以回车收尾（\r → 不可打印 '.'）—— 不假设分几帧
  await waitFor(async () => { const j = sent.join(''); return j.includes('2') && j.endsWith('.') }, '2 + 回车送进 PTY', 3_000)
})

test('「⌨ 打字」入口：点它聚焦终端、直接打字给程序', async ({ page }) => {
  const sent: string[] = []
  await page.exposeFunction('__rec', (x: string) => sent.push(x))
  await page.addInitScript(() => {
    const send = WebSocket.prototype.send
    WebSocket.prototype.send = function (d: unknown) {
      try {
        const buf = d instanceof ArrayBuffer ? d : (d as { buffer?: ArrayBuffer })?.buffer
        if (buf) { const u = new Uint8Array(buf); let x = ''; for (let i = 0; i < u.length; i++) { const c = u[i]!; x += c >= 32 && c < 127 ? String.fromCharCode(c) : '.' }; (window as unknown as { __rec(s: string): void }).__rec(x) }
      } catch { /* ignore */ }
      return send.call(this, d as never)
    }
  })
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await submit(page, "printf '\\033[>1u\\033[?25l'; sleep 60")
  await waitFor(async () => (await interactive(page)) === true, '占屏', 10_000)
  await expect(page.getByTestId('term-type')).toBeVisible()
  await page.getByTestId('term-type').click()
  await page.waitForTimeout(150)
  expect(await page.evaluate(() => document.activeElement?.className || ''), '点打字后 xterm 聚焦').toContain('xterm')
  sent.length = 0
  await page.keyboard.type('x')
  await waitFor(async () => sent.some((s) => s.endsWith('x')), '字符直达 PTY', 3_000)
})
