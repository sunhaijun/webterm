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

type Hooks = { __webterm: { view(): string; altScreen(): boolean; interactive(): boolean } }
const view = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as Hooks).__webterm.view())
const alt = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as Hooks).__webterm.altScreen())
const interactive = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as Hooks).__webterm.interactive())
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
  // 回到 prompt：功能键条退场（写态的编辑键在 sheet 里，ADR-0011 ③）
  await expect(page.getByTestId('keybar')).toHaveCount(0, { timeout: 5_000 })
  // 自动切换是临时的，不能把用户偏好改成 term
  expect(await stored(page)).not.toBe('term')
})

test('主屏就地重绘（claude/codex 那类，不切备用缓冲）也自动进终端，退出回读', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  expect(await view(page)).toBe('read')

  // 合成一个全屏交互程序：建立 Kitty 键盘协议（\e[>1u，claude/codex 的机械签名，
  // 进度条从不发这个），再藏光标反复上移重写，跑 ~2.5s 后自己退出。
  await submit(
    page,
    "printf '\\033[>1u\\033[?25l'; for i in $(seq 1 12); do printf 'frame %s\\n' $i; printf '\\033[1A'; sleep 0.2; done; printf '\\033[<u\\033[?25h\\n'",
  )
  // 备用缓冲【没有】激活，但仍被识别为占屏 → 自动进终端
  await waitFor(async () => (await interactive(page)) === true, '主屏就地重绘被识别为占屏', 10_000)
  expect(await alt(page), '这类程序不切备用缓冲').toBe(false)
  await waitFor(async () => (await view(page)) === 'term', '自动进终端', 5_000)
  await expect(page.getByTestId('terminal')).toHaveAttribute('data-hidden', 'false')

  // 程序自己退出（命令结束）→ 自动回读
  await waitFor(async () => (await interactive(page)) === false, '程序退出、占屏结束', 12_000)
  await waitFor(async () => (await view(page)) === 'read', '自动回到读', 6_000)
  // 自动切换不写偏好
  expect(await stored(page)).not.toBe('term')
})

test('多行进度条（npm/cargo 那类：藏光标 + 上移重绘但不建立键盘协议）不误判为占屏、不甩进终端', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  expect(await view(page)).toBe('read')
  // 藏光标 + 多行上移重绘（npm/pnpm/cargo/docker 进度条的形态），但【不发键盘协议】
  await submit(page, "printf '\\033[?25l'; for n in $(seq 1 8); do printf 'idealTree\\nreify\\nbuild\\n'; printf '\\033[3A'; sleep 0.12; done; printf '\\033[?25h\\ndone PROGRESS\\n'")
  // 跑动全程都不该被判占屏、不该切终端
  for (let k = 0; k < 10; k++) {
    expect(await interactive(page), '进度条不该被判占屏').toBe(false)
    expect(await view(page), '进度条不该把用户甩进终端').toBe('read')
    await page.waitForTimeout(120)
  }
  await waitFor(async () => (await terminalText(page)).includes('done PROGRESS'), '进度条跑完')
  expect(await view(page)).toBe('read')
})

test('应用光标键（DECCKM \\e[?1h，top/vim 那类主屏全屏程序）也识别为占屏、自动进终端', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  expect(await view(page)).toBe('read')
  // 合成 top 那类：设应用光标键(DECCKM) + 藏光标反复重绘，跑完复位、自退（不切备用缓冲、无键盘协议）
  await submit(page, "printf '\\033[?1h\\033[?25l'; for i in $(seq 1 12); do printf '\\033[H\\033[Jframe %s\\n' $i; sleep 0.2; done; printf '\\033[?1l\\033[?25h\\n'")
  await waitFor(async () => (await interactive(page)) === true, 'DECCKM 被识别为占屏', 10_000)
  expect(await alt(page), '不切备用缓冲').toBe(false)
  await waitFor(async () => (await view(page)) === 'term', '自动进终端', 5_000)
  await waitFor(async () => (await interactive(page)) === false, '退出占屏', 12_000)
  await waitFor(async () => (await view(page)) === 'read', '回读', 6_000)
})

test('占屏程序（DECCKM）运行中刷新页面：重连后仍在终端，不卡在坏块', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  // 设 DECCKM 后长睡（模拟 top 一直在跑），刷新前一直占屏
  await submit(page, "printf '\\033[?1h\\033[?25l'; sleep 30; printf '\\033[?1l\\033[?25h'")
  await waitFor(async () => (await view(page)) === 'term', '进终端', 10_000)
  await page.waitForTimeout(1000)
  await page.reload()
  await expect(page.getByTestId('conn-text')).toHaveText('在线', { timeout: 15_000 })
  await waitFor(async () => (await view(page)) === 'term', '重连后仍在终端', 8_000)
  expect(await interactive(page)).toBe(true)
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

test('占屏程序在读视图：显示"在终端里看"门而不是拍扁；直发逐字立即送；底栏不盖终端', async ({ page }) => {
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
  // 合成占屏程序：建立 Kitty 键盘协议（\e[>1u）+ 藏光标上移重写（不切备用缓冲）
  await submit(page, "printf '\\033[>1u\\033[?25l'; sleep 60")
  await waitFor(async () => (await interactive(page)) === true, '占屏被识别', 10_000)
  await waitFor(async () => (await view(page)) === 'term', '自动进终端', 5_000)

  // 终端视图底栏正好一行、不侵入 canvas（曾经隐藏的直发提示行仍占 56px，盖住终端最后几行）
  const geo = await page.evaluate(() => {
    const b = document.querySelector('.bottom')!.getBoundingClientRect()
    const c = document.querySelector('.canvas')!.getBoundingClientRect()
    return { bottomH: Math.round(b.height), bottomTop: Math.round(b.top), canvasBottom: Math.round(c.bottom) }
  })
  expect(geo.bottomH, '底栏≈键条一行').toBeLessThanOrEqual(58)
  expect(geo.bottomTop, '底栏顶不侵入 canvas').toBeGreaterThanOrEqual(geo.canvasBottom - 1)

  // 手动回读：运行块显示"交互式"门，不是 plainText 拍扁
  await page.getByTestId('keybar').getByTestId('view-toggle').click()
  await waitFor(async () => (await view(page)) === 'read', '回读')
  await expect(page.locator('[data-testid$="-interactive"]')).toBeVisible()
  expect(await page.locator('.block-live').count(), '不再 plainText 拍扁').toBe(0)

  // 直发逐字：输入数字立即送进 PTY（对得起"敲什么立刻送进去"）
  sent.length = 0
  const inp = page.getByTestId('raw-input')
  await inp.click()
  await inp.pressSequentially('2', { delay: 60 })
  await waitFor(async () => sent.some((x) => x.endsWith('2')), '数字 2 立即送出', 3_000)
  // 门指向终端（点击进终端的行为由 locate.spec 的 onViewTerm 覆盖，这里只确认门在且可用）
  await expect(page.locator('[data-testid$="-interactive"]')).toBeEnabled()
})

test('终端视图有「⌨ 打字」入口：点它聚焦终端、唤起键盘，直接打字给程序', async ({ page }) => {
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
  // 合成占屏程序（键盘协议）→ 自动进终端
  await submit(page, "printf '\\033[>1u\\033[?25l'; sleep 60")
  await waitFor(async () => (await view(page)) === 'term', '进终端', 10_000)
  // 「⌨ 打字」入口在
  await expect(page.getByTestId('term-type')).toBeVisible()
  // 点它 → xterm 聚焦
  await page.getByTestId('term-type').click()
  await page.waitForTimeout(150)
  expect(await page.evaluate(() => document.activeElement?.className || ''), '点打字后 xterm 聚焦').toContain('xterm')
  // 打字直达程序
  sent.length = 0
  await page.keyboard.type('x')
  await waitFor(async () => sent.some((s) => s.endsWith('x')), '字符直达 PTY', 3_000)
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
