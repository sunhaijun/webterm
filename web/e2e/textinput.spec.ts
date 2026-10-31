/**
 * E2E-40 文本输入页 —— AC-3.19 / AC-3.10。
 *
 * Pixel 5。hook `WebSocket.send` 记 INPUT 帧：断言的是线上的字节。
 */
import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, hooks, recordSent, terminalText, waitFor, waitText, type SentRecorder } from './harness'

const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
test.use(PIXEL)

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

/** CDP 横向拖一下（真实触摸 → pointer 事件）。 */
async function swipe(page: Page, x0: number, y: number, dx: number) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] })
  for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (dx * i) / 8, y }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

/** 等这一步新发出的 INPUT 帧（十六进制）。 */
async function newFrames(rec: SentRecorder, from: number, what: string): Promise<string[]> {
  await waitFor(async () => (await rec.inputHex()).length > from, what, 5_000)
  await new Promise((r) => setTimeout(r, 150))
  return (await rec.inputHex()).slice(from)
}

const hex = (s: string) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('')
const noNewline = async (page: Page) => expect(await page.getByTestId('textinput').inputValue(), '回车不在框里插换行').not.toContain('\n')

test('E2E-40 ①② 切换不动几何：点 ✎ 与横滑都能切，切过去就聚焦', async ({ page }) => {
  await agent.open(page)
  await page.waitForTimeout(300)
  const size = await hooks.size(page)
  const resizes = await hooks.resizes(page)
  const ek = page.getByTestId('extrakeys')
  const text = page.getByTestId('textinput')

  // ① 点 ✎
  await page.getByTestId('toggle-text').tap()
  await expect(ek).toHaveAttribute('data-page', 'text')
  await expect(text).toBeVisible()
  await expect(text).toBeFocused()
  await expect(page.getByTestId('toggle-text')).toHaveAttribute('aria-pressed', 'true')
  await page.waitForTimeout(300)
  expect(await hooks.size(page), '切到文本页不改终端行列').toEqual(size)
  expect(await hooks.resizes(page), '不发 resize').toBe(resizes)
  await page.getByTestId('toggle-text').tap()
  await expect(ek).toHaveAttribute('data-page', 'keys')

  // ② 横滑 80px
  const box = (await page.locator('.ek-main').boundingBox())!
  const y = box.y + box.height / 2
  await swipe(page, box.x + 60, y, 80)
  await expect(ek, '横滑 → 文本页').toHaveAttribute('data-page', 'text')
  await swipe(page, box.x + 200, y, -80)
  await expect(ek, '反向拖回 → 键位页').toHaveAttribute('data-page', 'keys')
  expect(await hooks.size(page)).toEqual(size)
  expect(await hooks.resizes(page)).toBe(resizes)
})

test('E2E-40 ③–⑧ attribute、回车语义、组字、括号粘贴、回车不插换行', async ({ page }) => {
  const rec = await recordSent(page)
  await agent.open(page)
  await page.getByTestId('toggle-text').tap()
  const text = page.getByTestId('textinput')
  await expect(text).toBeFocused()

  // ③ attribute 的实际值（Chrome 把 autocorrect 实现成 boolean IDL 属性，JSX 写法会反射成 on）
  await expect(text).toHaveAttribute('autocorrect', 'off')
  await expect(text).toHaveAttribute('autocapitalize', 'off')
  await expect(text).toHaveAttribute('spellcheck', 'false')
  await expect(text).toHaveAttribute('enterkeyhint', 'send')

  // ④ 有内容回车：发内容、不带 0d；命令上了命令行但没执行；框清空、焦点不动；计数都涨
  const s0 = await hooks.inputStats(page)
  let n = (await rec.inputHex()).length
  await text.fill('echo TEXT-ONE')
  await text.press('Enter')
  expect(await newFrames(rec, n, '有内容回车发出了 INPUT'), '内容原样发出，不追加回车').toEqual([hex('echo TEXT-ONE')])
  await waitText(page, 'echo TEXT-ONE', '命令行上出现了这段')
  await page.waitForTimeout(300)
  expect((await terminalText(page)).split('\n').some((l) => l.trimEnd() === 'TEXT-ONE'), '没有回车，不该执行').toBe(false)
  await expect(text).toHaveValue('')
  await expect(text, '发完焦点留在文本框').toBeFocused()
  const s1 = await hooks.inputStats(page)
  expect(s1.data.n, '走 onData（inputStats.data 涨）').toBeGreaterThan(s0.data.n)
  expect(s1.sent.n, 'inputStats.sent 涨').toBeGreaterThan(s0.sent.n)
  await noNewline(page)

  // ⑤ 空回车：发 0d，命令执行
  n = (await rec.inputHex()).length
  await text.press('Enter')
  expect(await newFrames(rec, n, '空回车')).toEqual(['0d'])
  await waitFor(async () => (await terminalText(page)).split('\n').some((l) => l.trimEnd() === 'TEXT-ONE'), '空回车执行了命令')
  await noNewline(page)

  // ⑥ 组字中回车：不发；组字结束后回车：一次发出组字结果
  n = (await rec.inputHex()).length
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid=textinput]') as HTMLTextAreaElement
    el.focus()
    el.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }))
    el.value = 'ni'
    el.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ni', bubbles: true }))
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, isComposing: true, bubbles: true, cancelable: true }))
  })
  await page.waitForTimeout(400)
  expect((await rec.inputHex()).length, '组字中按回车是选词，不发').toBe(n)
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid=textinput]') as HTMLTextAreaElement
    el.value = '你好'
    el.dispatchEvent(new CompositionEvent('compositionend', { data: '你好', bubbles: true }))
  })
  await text.press('Enter')
  expect(await newFrames(rec, n, '组字结束后回车')).toEqual([hex('你好')])
  await noNewline(page)
  // 把命令行上的「你好」清掉
  n = (await rec.inputHex()).length
  await page.getByTestId('toggle-text').tap()
  await page.getByTestId('key-Ctrl').tap()
  await page.keyboard.type('c')
  await newFrames(rec, n, '^C')
  await page.getByTestId('toggle-text').tap()
  await expect(text).toBeFocused()

  // ⑦ 含换行（粘贴来的）走括号粘贴：整块上命令行，不逐条执行
  n = (await rec.inputHex()).length
  await text.fill('echo L1\necho L2')
  await text.press('Enter')
  const f = (await newFrames(rec, n, '粘贴的多行')).join('')
  expect(f.startsWith('1b5b3230307e'), `以 ESC[200~ 开头：${f}`).toBe(true)
  expect(f.endsWith('1b5b3230317e'), `以 ESC[201~ 结尾：${f}`).toBe(true)
  await page.waitForTimeout(500)
  const lines = (await terminalText(page)).split('\n').map((l) => l.trimEnd())
  expect(lines.includes('L1') || lines.includes('L2'), '两行被逐条执行了').toBe(false)
  expect(lines.some((l) => l.endsWith('echo L2')), '第二行作为同一块出现在命令行上').toBe(true)
  await expect(text).toHaveValue('')
  await noNewline(page)
})
