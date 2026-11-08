/**
 * E2E-40 Text page (AC-3.19 / AC-3.10 / AC-3.22).
 *
 * Pixel 5. `WebSocket.send` is hooked to record INPUT frames, so assertions are on the bytes on the
 * wire. A paste and an Enter are two onData calls and may or may not share a frame, so each step's
 * frames are concatenated before comparing. The E2E bash has bracketed paste enabled.
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

/** swipe performs a CDP drag from (x0, y0) by (dx, dy) (real touch -> touch and pointer events). */
async function swipe(page: Page, x0: number, y0: number, dx: number, dy = 0) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] })
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (dx * i) / 8, y: y0 + (dy * i) / 8 }] })
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

/** newFrames waits for INPUT frames sent since index `from` and returns them as hex. */
async function newFrames(rec: SentRecorder, from: number, what: string): Promise<string[]> {
  await waitFor(async () => (await rec.inputHex()).length > from, what, 5_000)
  await new Promise((r) => setTimeout(r, 150))
  return (await rec.inputHex()).slice(from)
}

const hex = (s: string) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('')
/** submitted is bracketed-paste content plus CR: what Enter on a non-empty text page puts on the wire (ADR-0027). */
const submitted = (s: string) => hex(`\x1b[200~${s}\x1b[201~\r`)
const hasLine = async (page: Page, line: string) => (await terminalText(page)).split('\n').some((l) => l.trimEnd() === line)
/** atPrompt waits for the bash prompt. readline enables bracketed paste (?2004h) only when it prints the prompt; anything sent earlier is not wrapped. */
const atPrompt = (page: Page) => waitFor(async () => (await terminalText(page)).trimEnd().endsWith('$'), 'shell back at the prompt')
const noNewline = async (page: Page) => expect(await page.getByTestId('textinput').inputValue(), 'Enter does not insert a newline into the box').not.toContain('\n')

test('E2E-40 (1)(2) toggling keeps geometry: both ✎ and a vertical swipe toggle and focus the box; a swipe left does nothing; the text box has a border on all four sides', async ({ page }) => {
  await agent.open(page)
  await page.waitForTimeout(300)
  const size = await hooks.size(page)
  const resizes = await hooks.resizes(page)
  const ek = page.getByTestId('extrakeys')
  const text = page.getByTestId('textinput')

  // (1) Tap ✎.
  await page.getByTestId('toggle-text').tap()
  await expect(ek).toHaveAttribute('data-page', 'text')
  await expect(text).toBeVisible()
  await expect(text).toBeFocused()
  await expect(page.getByTestId('toggle-text')).toHaveAttribute('aria-pressed', 'true')
  await page.waitForTimeout(300)
  expect(await hooks.size(page), 'switching to the text page keeps terminal rows and columns').toEqual(size)
  expect(await hooks.resizes(page), 'no resize sent').toBe(resizes)
  // The text box has a border on all four sides and sits inside the extra keys slot with a gap on
  // every side, so its bottom border does not touch the viewport edge.
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
  for (const w of geo.widths) expect(w, `border on all four sides: ${geo.widths}`).toBeGreaterThanOrEqual(1)
  for (const g of geo.gaps) expect(g, `box sits inside the slot with a gap on every side: ${geo.gaps}`).toBeGreaterThan(0)
  await page.getByTestId('toggle-text').tap()
  await expect(ek).toHaveAttribute('data-page', 'keys')

  // (2) Swipe up 80px over the keys -> text page; down over the (empty) box -> keys page (ADR-0056).
  const box = (await page.locator('.ek-main').boundingBox())!
  await swipe(page, box.x + 120, box.y + box.height - 5, 0, -80)
  await expect(ek, 'swipe up -> text page').toHaveAttribute('data-page', 'text')
  await swipe(page, box.x + 120, box.y + 10, 0, 80)
  await expect(ek, 'swipe down -> keys page').toHaveAttribute('data-page', 'keys')
  // A swipe left switches nothing (and collapses nothing)
  await swipe(page, box.x + 200, box.y + box.height / 2, -80)
  await expect(ek).toHaveAttribute('data-page', 'keys')
  await expect(ek).not.toHaveAttribute('data-collapsed', 'true')
  expect(await hooks.size(page)).toEqual(size)
  expect(await hooks.resizes(page)).toBe(resizes)
})

test('E2E-40 (3)-(8) attributes, Enter semantics, composition, bracketed paste, Enter inserts no newline', async ({ page }) => {
  const rec = await recordSent(page)
  await agent.open(page)
  await page.getByTestId('toggle-text').tap()
  const text = page.getByTestId('textinput')
  await expect(text).toBeFocused()

  // (3) Actual attribute values. Chrome implements autocorrect as a boolean IDL attribute, so the
  // JSX form would reflect as "on".
  await expect(text).toHaveAttribute('autocorrect', 'off')
  await expect(text).toHaveAttribute('autocapitalize', 'off')
  await expect(text).toHaveAttribute('spellcheck', 'false')
  await expect(text).toHaveAttribute('enterkeyhint', 'send')

  // (4) Enter with content = send and submit: bracketed content + 0d, the command runs; the box
  // clears, focus stays; counters increase.
  await atPrompt(page)
  const s0 = await hooks.inputStats(page)
  let n = (await rec.inputHex()).length
  await text.fill('echo TEXT-ONE')
  await text.press('Enter')
  expect((await newFrames(rec, n, 'Enter with content sent INPUT')).join(''), 'bracketed-paste content followed by CR').toBe(submitted('echo TEXT-ONE'))
  await waitFor(() => hasLine(page, 'TEXT-ONE'), 'one Enter ran the command')
  await expect(text).toHaveValue('')
  await expect(text, 'focus stays in the text box after sending').toBeFocused()
  const s1 = await hooks.inputStats(page)
  expect(s1.data.n, 'goes through onData (inputStats.data increases)').toBeGreaterThan(s0.data.n)
  expect(s1.sent.n, 'inputStats.sent increases').toBeGreaterThan(s0.sent.n)
  await noNewline(page)

  // (5) Empty Enter: sends only 0d.
  n = (await rec.inputHex()).length
  await text.press('Enter')
  expect(await newFrames(rec, n, 'empty Enter')).toEqual(['0d'])
  await noNewline(page)

  // (6) Enter during composition sends nothing; Enter after composition ends sends the result once.
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
  expect((await rec.inputHex()).length, 'Enter during composition picks a candidate and sends nothing').toBe(n)
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid=textinput]') as HTMLTextAreaElement
    el.value = '你好'
    el.dispatchEvent(new CompositionEvent('compositionend', { data: '你好', bubbles: true }))
  })
  await text.press('Enter')
  expect((await newFrames(rec, n, 'Enter after composition ends')).join('')).toBe(submitted('你好'))
  await noNewline(page)

  // (7) Multi-line (pasted) content goes out as one bracketed paste: newlines become CR, wrapped in
  // one pair of markers, CR after the end marker; both lines run.
  await atPrompt(page)
  n = (await rec.inputHex()).length
  await text.fill('echo L1\necho L2')
  await text.press('Enter')
  const f = (await newFrames(rec, n, 'pasted multi-line content')).join('')
  expect(f.startsWith('1b5b3230307e'), `starts with ESC[200~: ${f}`).toBe(true)
  expect(f.endsWith('1b5b3230317e0d'), `ends with ESC[201~ plus CR: ${f}`).toBe(true)
  expect(f, 'newlines converted to CR').toBe(submitted('echo L1\recho L2'))
  await waitFor(async () => (await hasLine(page, 'L1')) && (await hasLine(page, 'L2')), 'both lines ran')
  await expect(text).toHaveValue('')
  await noNewline(page)
})

test('E2E-40 (9) the text page follows the session: page and draft are per session, focus moves to the new session input, Enter sends only to the current session (ADR-0036)', async ({ page }) => {
  const rec = await recordSent(page)
  await agent.open(page)
  const a = (await hooks.sid(page))!
  const ek = page.getByTestId('extrakeys')
  const text = page.getByTestId('textinput')
  const inTerm = () => page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false)

  // A has a half-written draft on the text page.
  await page.getByTestId('toggle-text').tap()
  await expect(text).toBeFocused()
  await text.fill('echo DRAFT-A')

  // Create B from the drawer: keys page, text box hidden, focus in B's terminal.
  const b = await newSession(page)
  await expect(ek).toHaveAttribute('data-page', 'keys')
  await expect(text).toBeHidden()
  await waitFor(inTerm, "focus in B's terminal")
  await page.getByTestId('toggle-text').tap()
  await expect(text, "B's box is empty, not A's draft").toHaveValue('')
  await text.fill('echo DRAFT-B')

  // Back to A: text page, A's draft, focus in the text box; Enter sends only to A.
  await switchTo(page, a)
  await expect(ek).toHaveAttribute('data-page', 'text')
  await expect(text).toHaveValue('echo DRAFT-A')
  await expect(text).toBeFocused()
  await atPrompt(page)
  await text.press('Enter')
  await waitFor(() => hasLine(page, 'DRAFT-A'), 'A ran its own draft')
  await expect(text).toHaveValue('')

  // To B: B's draft is still there; B flips back to the keys page.
  await switchTo(page, b)
  await expect(ek).toHaveAttribute('data-page', 'text')
  await expect(text).toHaveValue('echo DRAFT-B')
  await page.getByTestId('toggle-text').tap()
  await expect(ek).toHaveAttribute('data-page', 'keys')

  // A is still on the text page with an empty box (just sent); back to B it is the keys page with focus in the terminal.
  await switchTo(page, a)
  await expect(ek).toHaveAttribute('data-page', 'text')
  await expect(text).toHaveValue('')
  await switchTo(page, b)
  await expect(ek).toHaveAttribute('data-page', 'keys')
  await waitFor(inTerm, "focus in B's terminal")

  expect((await rec.input()).join(''), "B's draft was never sent").not.toContain('DRAFT-B')
})
