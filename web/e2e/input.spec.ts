/**
 * E2E-7 中文 IME 输入（AC-3.1 / AC-3.3）
 * E2E-8 Composer 提交格式（AC-3.2）
 * E2E-10 移动端布局与功能键条（AC-3.8 / AC-3.9 / AC-3.10）
 */
import { expect, test, type Page } from '@playwright/test'

import { Agent, submit, terminalText, waitFor } from './harness'

/** 记录本页发出的所有 INPUT 帧的 payload（解成字符串）。 */
async function recordInput(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __sentInput: string[] }
    w.__sentInput = []
    const orig = WebSocket.prototype.send
    WebSocket.prototype.send = function (data: unknown) {
      if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
        const b = data instanceof Uint8Array ? data : new Uint8Array(data)
        if (b[0] === 0x02) {
          // INPUT 帧：跳过 12 字节头
          w.__sentInput.push(new TextDecoder().decode(b.subarray(12)))
        }
      }
      return orig.call(this, data as never)
    }
  })
  return () => page.evaluate(() => (window as unknown as { __sentInput: string[] }).__sentInput)
}

/** 在指定元素上派发一次完整的 IME 组字。 */
async function composeInto(page: Page, selector: string, steps: string[], final: string) {
  await page.evaluate(
    ({ selector, steps, final }) => {
      const el = document.querySelector(selector) as HTMLTextAreaElement
      el.focus()
      el.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }))
      for (const s of steps) {
        el.value = s
        el.dispatchEvent(new CompositionEvent('compositionupdate', { data: s, bubbles: true }))
        el.dispatchEvent(new InputEvent('input', { data: s, isComposing: true, bubbles: true }))
      }
      el.value = final
      el.dispatchEvent(new CompositionEvent('compositionend', { data: final, bubbles: true }))
    },
    { selector, steps, final },
  )
}

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

test('E2E-7 Composer：组字期间零 INPUT 帧，组字中按 Enter 不提交', async ({ page }) => {
  const sent = await recordInput(page)
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  const before = (await sent()).length
  await composeInto(page, '[data-testid=composer]', ['ni', '你'], '你好')

  // 组字期间【不能】有任何向 PTY 的写入
  expect((await sent()).length, '组字期间发出了 INPUT 帧').toBe(before)
  await expect(page.getByTestId('composer')).toHaveValue('你好')

  // 组字期间按 Enter 是在选词 —— 不能提交
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid=composer]') as HTMLTextAreaElement
    el.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }))
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }),
    )
  })
  expect((await sent()).length, '组字中按 Enter 误提交了').toBe(before)

  // 组字结束后按 Enter 才提交
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid=composer]') as HTMLTextAreaElement
    el.dispatchEvent(new CompositionEvent('compositionend', { data: '你好', bubbles: true }))
  })
  await page.getByTestId('composer').press('Enter')
  await waitFor(async () => (await sent()).length > before, '组字结束后 Enter 才提交')
})

test('E2E-7 Raw：compositionend 时一次性提交，光标处有内联预览', async ({ page }) => {
  const sent = await recordInput(page)
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  await page.getByTestId('mode-toggle').click() // 手动切到 Raw
  const before = (await sent()).length

  await page.evaluate(() => {
    const el = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
    el.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }))
    el.dispatchEvent(new CompositionEvent('compositionupdate', { data: '你', bubbles: true }))
  })
  // 组字期间零字节，且浮层可见
  expect((await sent()).length).toBe(before)
  await expect(page.getByTestId('ime-preview')).toBeVisible()
  await expect(page.getByTestId('ime-preview')).toHaveText('你')

  await page.evaluate(() => {
    const el = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
    el.dispatchEvent(new CompositionEvent('compositionend', { data: '你好', bubbles: true }))
  })
  await waitFor(async () => {
    const all = await sent()
    return all.slice(before).join('') === '你好'
  }, 'compositionend 时一次性发出 "你好"')
  await expect(page.getByTestId('ime-preview')).toBeHidden()
})

test('E2E-7 Raw：切过会话之后 IME 仍然生效（每个会话有自己的 textarea）', async ({ page }) => {
  const sent = await recordInput(page)
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  const sidA = await page.evaluate(
    () => (window as unknown as { __webterm: { sid(): number | null } }).__webterm.sid()!,
  )

  // 建第二个会话并切过去 —— 它有自己的 xterm 实例和自己的 helper textarea，
  // 而 A 的 host 此刻已经被摘出 DOM
  await page.getByTestId('new-session').click()
  await waitFor(async () => {
    const sid = await page.evaluate(
      () => (window as unknown as { __webterm: { sid(): number | null } }).__webterm.sid(),
    )
    return sid !== null && sid !== sidA
  }, '切到了新会话')

  await page.getByTestId('mode-toggle').click() // 切到 Raw
  const before = (await sent()).length

  await page.evaluate(() => {
    const el = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
    el.focus()
    el.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }))
    el.value = '你'
    el.dispatchEvent(new CompositionEvent('compositionupdate', { data: '你', bubbles: true }))
    el.dispatchEvent(new InputEvent('input', { data: '你', isComposing: true, bubbles: true }))
  })

  // ★ 回归点是浮层这条：IME 没重新挂的话它不出现（已用变异验证过）。
  //
  // 字节那条留着防回归，但要说清它【测不到本 bug 的要害】：
  // 合成的 CompositionEvent 不会触发 xterm 的 onData，所以
  // "isComposing 恒为 false → 组字字节直通 PTY"这个后果只有真输入法
  // 能演示（见 docs/90-roadmap/milestones.md 的自动化边界）。
  expect((await sent()).length).toBe(before)
  await expect(page.getByTestId('ime-preview')).toBeVisible()

  await page.evaluate(() => {
    const el = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
    el.dispatchEvent(new CompositionEvent('compositionend', { data: '你好', bubbles: true }))
  })
  await waitFor(async () => {
    const all = await sent()
    return all.slice(before).join('') === '你好'
  }, 'compositionend 时一次性发出 "你好"')
  await expect(page.getByTestId('ime-preview')).toBeHidden()
})

test('E2E-8 提交格式：单行不包 bracketed paste，多行包', async ({ page }) => {
  const sent = await recordInput(page)
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  await submit(page, 'echo single')
  await waitFor(async () => (await sent()).some((s) => s.includes('echo single')), '单行提交')
  const single = (await sent()).find((s) => s.includes('echo single'))!
  expect(single, '单行不该包 bracketed paste').toBe('echo single\r')

  // 多行：必须包起来，否则会被 shell 逐行当成独立命令执行
  const composer = page.getByTestId('composer')
  await composer.click()
  await composer.fill('echo line1\necho line2')
  await composer.press('Enter')

  await waitFor(async () => (await sent()).some((s) => s.includes('\x1b[200~')), '多行提交')
  const multi = (await sent()).find((s) => s.includes('\x1b[200~'))!
  expect(multi).toBe('\x1b[200~echo line1\necho line2\x1b[201~\r')

  // 而且两行确实作为【一整块】进了 readline，不是被逐条执行
  await waitFor(async () => (await terminalText(page)).includes('line2'), '两行都执行了')
})

test('E2E-10 移动端：功能键条、粘滞修饰键、输入框属性', async ({ browser }) => {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, // iPhone 14
    hasTouch: true,
    isMobile: true,
  })
  const page = await ctx.newPage()
  const sent = await recordInput(page)
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  // 触摸设备才显示功能键条
  await expect(page.getByTestId('keybar')).toBeVisible()

  // 前 8 个键无需滚动即可见
  for (const k of ['Escape', 'Tab', 'Ctrl', 'Alt', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
    await expect(page.getByTestId(`key-${k}`)).toBeInViewport()
  }

  // AC-3.10：移动端会把 cd 自动大写成 Cd，这些必须全关
  const composer = page.getByTestId('composer')
  await expect(composer).toHaveAttribute('autocorrect', 'off')
  await expect(composer).toHaveAttribute('autocapitalize', 'off')
  await expect(composer).toHaveAttribute('spellcheck', 'false')

  // 粘滞修饰键：点 Ctrl → 激活态；再按 c → 发出 0x03；Ctrl 自动取消
  await page.getByTestId('mode-toggle').click() // 切到 Raw 才直通
  await page.getByTestId('key-Ctrl').click()
  await expect(page.getByTestId('key-Ctrl')).toHaveAttribute('data-sticky', 'armed')

  const before = (await sent()).length
  await page.getByTestId('key-Tab').click() // Ctrl+Tab
  await waitFor(async () => (await sent()).length > before, '组合键发出去了')
  await expect(page.getByTestId('key-Ctrl'), '用掉一次之后应当自动取消').toHaveAttribute(
    'data-sticky',
    'off',
  )

  // 方向键在 Raw 下直通
  const n = (await sent()).length
  await page.getByTestId('key-ArrowUp').click()
  await waitFor(async () => (await sent()).slice(n).join('') === '\x1b[A', '方向键映射正确')

  await ctx.close()
})
