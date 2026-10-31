/**
 * E2E-40 文本输入页 —— AC-3.19 / AC-3.10 / AC-3.22。
 *
 * Pixel 5。hook `WebSocket.send` 记 INPUT 帧：断言的是线上的字节。粘贴与回车是两次 onData，
 * 分不分帧不重要，所以这一步的帧拼起来比。E2E 的 bash 开了括号粘贴。
 */
import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, hooks, newSession, recordSent, switchTo, terminalText, waitFor, type SentRecorder } from './harness'

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
/** 括号粘贴好的内容再加一个回车 —— 文本页有内容回车时线上的样子（ADR-0027）。 */
const submitted = (s: string) => hex(`\x1b[200~${s}\x1b[201~\r`)
const hasLine = async (page: Page, line: string) => (await terminalText(page)).split('\n').some((l) => l.trimEnd() === line)
/** 等 bash 回到提示符：readline 出提示符时才开括号粘贴（?2004h），之前发的不会被包裹。 */
const atPrompt = (page: Page) => waitFor(async () => (await terminalText(page)).trimEnd().endsWith('$'), 'shell 回到提示符')
const noNewline = async (page: Page) => expect(await page.getByTestId('textinput').inputValue(), '回车不在框里插换行').not.toContain('\n')

test('E2E-40 ①② 切换不动几何：点 ✎ 与横滑都能切，切过去就聚焦；文本框四边有框', async ({ page }) => {
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
  // 文本框四边都有边框，整个框落在附加键槽里、四边留空 —— 下边框不贴视口底边
  const geo = await page.evaluate(() => {
    const ta = document.querySelector('[data-testid=textinput]')!
    const slot = document.querySelector('[data-testid=extrakeys]')!
    const cs = getComputedStyle(ta)
    const a = ta.getBoundingClientRect()
    const b = slot.getBoundingClientRect()
    return {
      widths: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(parseFloat),
      gaps: [a.top - b.top, b.right - a.right, b.bottom - a.bottom, a.left - b.left],
    }
  })
  for (const w of geo.widths) expect(w, `四边都有边框：${geo.widths}`).toBeGreaterThanOrEqual(1)
  for (const g of geo.gaps) expect(g, `整个框落在槽内、四边留空：${geo.gaps}`).toBeGreaterThan(0)
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

  // ④ 有内容回车 = 发送并回车：括号包好的内容 + 0d，命令执行；框清空、焦点不动；计数都涨
  await atPrompt(page)
  const s0 = await hooks.inputStats(page)
  let n = (await rec.inputHex()).length
  await text.fill('echo TEXT-ONE')
  await text.press('Enter')
  expect((await newFrames(rec, n, '有内容回车发出了 INPUT')).join(''), '括号粘贴的内容，跟一个回车').toBe(submitted('echo TEXT-ONE'))
  await waitFor(() => hasLine(page, 'TEXT-ONE'), '一次回车就执行了命令')
  await expect(text).toHaveValue('')
  await expect(text, '发完焦点留在文本框').toBeFocused()
  const s1 = await hooks.inputStats(page)
  expect(s1.data.n, '走 onData（inputStats.data 涨）').toBeGreaterThan(s0.data.n)
  expect(s1.sent.n, 'inputStats.sent 涨').toBeGreaterThan(s0.sent.n)
  await noNewline(page)

  // ⑤ 空回车：只发 0d
  n = (await rec.inputHex()).length
  await text.press('Enter')
  expect(await newFrames(rec, n, '空回车')).toEqual(['0d'])
  await noNewline(page)

  // ⑥ 组字中回车：不发；组字结束后回车：一次发出组字结果
  await atPrompt(page)
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
  expect((await newFrames(rec, n, '组字结束后回车')).join('')).toBe(submitted('你好'))
  await noNewline(page)

  // ⑦ 多行（粘贴来的）整块粘贴再回车：换行转 CR、包在一对标记里，回车在结束标记之后；两行都执行
  await atPrompt(page)
  n = (await rec.inputHex()).length
  await text.fill('echo L1\necho L2')
  await text.press('Enter')
  const f = (await newFrames(rec, n, '粘贴的多行')).join('')
  expect(f.startsWith('1b5b3230307e'), `以 ESC[200~ 开头：${f}`).toBe(true)
  expect(f.endsWith('1b5b3230317e0d'), `以 ESC[201~ 加回车结尾：${f}`).toBe(true)
  expect(f, '换行已转成 CR').toBe(submitted('echo L1\recho L2'))
  await waitFor(async () => (await hasLine(page, 'L1')) && (await hasLine(page, 'L2')), '两行都执行了')
  await expect(text).toHaveValue('')
  await noNewline(page)
})

test('E2E-40 ⑨ 跟着会话走：页与草稿各归各的，焦点落到新会话的输入处，回车只发到当前会话（ADR-0036）', async ({ page }) => {
  const rec = await recordSent(page)
  await agent.open(page)
  const a = (await hooks.sid(page))!
  const ek = page.getByTestId('extrakeys')
  const text = page.getByTestId('textinput')
  const inTerm = () => page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false)

  // A 在文本页写了一半
  await page.getByTestId('toggle-text').tap()
  await expect(text).toBeFocused()
  await text.fill('echo DRAFT-A')

  // 从抽屉新建 B：键位页、文本框藏起来，焦点进 B 的终端
  const b = await newSession(page)
  await expect(ek).toHaveAttribute('data-page', 'keys')
  await expect(text).toBeHidden()
  await waitFor(inTerm, '焦点进 B 的终端')
  await page.getByTestId('toggle-text').tap()
  await expect(text, 'B 的框是空的，不是 A 的草稿').toHaveValue('')
  await text.fill('echo DRAFT-B')

  // 切回 A：文本页、A 的草稿、焦点在文本框；回车只发到 A
  await switchTo(page, a)
  await expect(ek).toHaveAttribute('data-page', 'text')
  await expect(text).toHaveValue('echo DRAFT-A')
  await expect(text).toBeFocused()
  await atPrompt(page)
  await text.press('Enter')
  await waitFor(() => hasLine(page, 'DRAFT-A'), 'A 执行了自己的草稿')
  await expect(text).toHaveValue('')

  // 切到 B：B 的草稿还在；B 翻回键位页
  await switchTo(page, b)
  await expect(ek).toHaveAttribute('data-page', 'text')
  await expect(text).toHaveValue('echo DRAFT-B')
  await page.getByTestId('toggle-text').tap()
  await expect(ek).toHaveAttribute('data-page', 'keys')

  // A 仍在文本页、框是空的（刚才发掉了）；再切回 B 是键位页，焦点在终端
  await switchTo(page, a)
  await expect(ek).toHaveAttribute('data-page', 'text')
  await expect(text).toHaveValue('')
  await switchTo(page, b)
  await expect(ek).toHaveAttribute('data-page', 'keys')
  await waitFor(inTerm, '焦点进 B 的终端')

  expect((await rec.input()).join(''), 'B 的草稿一次都没发出去').not.toContain('DRAFT-B')
})
