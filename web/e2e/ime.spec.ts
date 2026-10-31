/**
 * E2E-7 中文 IME 输入（终端直输）—— AC-3.3 / AC-3.14。文本输入页的组字见 E2E-40（textinput.spec.ts）。
 *
 * Playwright 可以派发 composition 事件；真机输入法的候选框行为放手工清单。
 */
import { expect, test, type Page } from '@playwright/test'

import { Agent, focusTerm, newSession, recordSent, terminalText, waitFor } from './harness'

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

/** 在终端的 helper textarea 上派发组字事件（不结束）。 */
const composeStart = (page: Page, steps: string[]) =>
  page.evaluate((steps) => {
    const el = document.querySelector('.term .xterm-helper-textarea') as HTMLTextAreaElement
    el.focus()
    el.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }))
    for (const s of steps) {
      el.value = s
      el.dispatchEvent(new CompositionEvent('compositionupdate', { data: s, bubbles: true }))
      el.dispatchEvent(new InputEvent('input', { data: s, isComposing: true, bubbles: true }))
    }
  }, steps)

const composeEnd = (page: Page, final: string) =>
  page.evaluate((final) => {
    const el = document.querySelector('.term .xterm-helper-textarea') as HTMLTextAreaElement
    el.value = final
    el.dispatchEvent(new CompositionEvent('compositionend', { data: final, bubbles: true }))
  }, final)

/** 浮层在终端光标处：落在 .xterm-screen 里，纵向就在光标那一格的下沿附近。 */
async function previewAtCursor(page: Page) {
  const g = await page.evaluate(() => {
    const p = document.querySelector('[data-testid=ime-preview]')!.getBoundingClientRect()
    const s = document.querySelector('.term .xterm-screen')!.getBoundingClientRect()
    const rows = document.querySelectorAll('.term .xterm-rows > div').length || 1
    return { p: { left: p.left, top: p.top }, s: { left: s.left, top: s.top, right: s.right, bottom: s.bottom }, cellH: s.height / rows }
  })
  expect(g.p.left, '浮层在终端区内').toBeGreaterThanOrEqual(g.s.left - 1)
  expect(g.p.left).toBeLessThan(g.s.right)
  expect(g.p.top).toBeGreaterThanOrEqual(g.s.top)
  expect(g.p.top).toBeLessThanOrEqual(g.s.bottom + g.cellH)
}

test('E2E-7 终端直输：组字期间零 INPUT 帧，compositionend 一次发出，光标处有内联预览', async ({ page }) => {
  const rec = await recordSent(page)
  await agent.open(page)

  await page.getByTestId('terminal').click({ position: { x: 60, y: 60 } })
  const before = (await rec.input()).length

  await composeStart(page, ['ni', '你'])
  expect((await rec.input()).length, '组字期间发出了 INPUT 帧').toBe(before)
  await expect(page.getByTestId('ime-preview')).toBeVisible()
  await expect(page.getByTestId('ime-preview')).toHaveText('你')
  await previewAtCursor(page)

  await composeEnd(page, '你好')
  await waitFor(async () => (await rec.input()).length > before, 'compositionend 时发出')
  await page.waitForTimeout(200)
  expect((await rec.input()).slice(before), 'compositionend 时【一次】发出「你好」').toEqual(['你好'])
  await expect(page.getByTestId('ime-preview')).toHaveCount(0)
})

test('E2E-7 终端直输 · 切过会话之后（回归）：IME 重新挂在新会话的 textarea 上', async ({ page }) => {
  const rec = await recordSent(page)
  await agent.open(page)

  // 建第二个会话并切过去 —— 它有自己的 xterm 实例和自己的 helper textarea，
  // 而 A 的 host 此刻已经被摘出 DOM
  await newSession(page)
  await page.getByTestId('terminal').click({ position: { x: 60, y: 60 } })
  const before = (await rec.input()).length

  await composeStart(page, ['你'])
  // ★ 回归点是浮层这条：IME 没重新挂的话它不出现（已用变异验证过）。
  // 字节那条留着防回归，但它【测不到本 bug 的要害】：合成的 CompositionEvent
  // 不会触发 xterm 的 onData（见 docs/90-roadmap/milestones.md 的自动化边界）。
  await expect(page.getByTestId('ime-preview')).toBeVisible()
  expect((await rec.input()).length).toBe(before)

  await composeEnd(page, '你好')
  await waitFor(async () => (await rec.input()).slice(before).join('') === '你好', 'compositionend 时一次性发出「你好」')
  await expect(page.getByTestId('ime-preview')).toHaveCount(0)
})

/**
 * 软键盘按下同一个键 n 下：每下都是 keydown → 浏览器把字插进 textarea → input → keyup。
 *
 * keydown 没被 preventDefault 才会真的插进去 —— xterm 处理掉的键会 cancel。
 * 【n 下在同一个 evaluate 里发完】：连打的间隔必须落在去重窗口（120ms）以内，
 * 否则测不到"去重会不会吃掉用户的第二下"。
 */
function softKeys(page: Page, ch: string, keyCode: number, n: number) {
  return page.evaluate(
    ([ch, keyCode, n]: [string, number, number]) => {
      const ta = document.querySelector<HTMLTextAreaElement>('.term .xterm-helper-textarea')!
      ta.focus()
      for (let i = 0; i < n; i++) {
        const opts = { bubbles: true, cancelable: true, composed: true }
        const kd = new KeyboardEvent('keydown', { key: ch, keyCode, ...opts })
        ta.dispatchEvent(kd)
        if (!kd.defaultPrevented) {
          const bi = new InputEvent('beforeinput', { inputType: 'insertText', data: ch, ...opts })
          ta.dispatchEvent(bi)
          if (!bi.defaultPrevented) {
            ta.value += ch
            ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: ch, bubbles: true, composed: true }))
          }
        }
        ta.dispatchEvent(new KeyboardEvent('keyup', { key: ch, keyCode, bubbles: true, composed: true }))
      }
    },
    [ch, keyCode, n] as [string, number, number],
  )
}

test('E2E-7 终端直输 · 软键盘直接插入的全角标点（AC-3.14）：都进终端，且不重复', async ({ page }) => {
  await agent.open(page)
  await focusTerm(page)
  await page.keyboard.type('echo ')

  const softKey = (ch: string, keyCode: number) => softKeys(page, ch, keyCode, 1)
  // keyCode 0 = iOS 对直接插入报的值（本 bug 的要害）；229 = 差量路；191 = keydown 路
  await softKey('，', 0)
  await softKey('。', 229)
  await softKey('！', 0)
  await softKey('？', 191)

  // 组字提交之后紧跟一个 keyCode 0 的标点 —— 打完中文接着打逗号是常事
  await composeStart(page, ['nihao'])
  await composeEnd(page, '你好')
  await softKey('，', 0)

  await page.keyboard.press('Enter')
  const want = '，。！？你好，'
  await waitFor(async () => (await terminalText(page)).split('\n').some((l) => l.trim() === want), `终端回显 ${want}`)

  const text = await terminalText(page)
  expect(text, '重复发送会变成「，，」').not.toContain('，，')
  expect(text, '组字结果不能发两遍').not.toContain('你好你好')
})

/**
 * 连打两下同一个标点（AC-3.14 / ADR-0020）。【另起一条用例】：上一条断言的是"不该出现「，，」"，
 * 这一条要求的恰恰是出现「，，」。软键盘直接插入的字符只走 beforeinput 这一条路，
 * 第二下没有别的路会替它发 —— 被去重吃掉就是永久丢字。
 */
test('E2E-7 ⑥ 连打两下同一个 keyCode 0 的「，」：两下都进，不被去重吃掉', async ({ page }) => {
  await agent.open(page)
  await focusTerm(page)
  await page.keyboard.type('echo ')

  // 两下在同一个 evaluate 里发完 —— 间隔远小于 120ms 的去重窗口
  await softKeys(page, '，', 0, 2)

  await page.keyboard.press('Enter')
  await waitFor(
    async () => (await terminalText(page)).split('\n').some((l) => l.trim() === '，，'),
    '连打两下「，」，终端回显必须是两个 —— 第二下被去重吃掉就只剩一个',
  )
})
