/**
 * E2E-7 Chinese IME input, typed directly into the terminal (AC-3.3 / AC-3.14). IME composition in
 * the text page is E2E-40 (textinput.spec.ts).
 *
 * Playwright can dispatch composition events; real IME candidate-window behavior is on the manual
 * checklist.
 */
import { expect, test, type Page } from '@playwright/test'

import { Agent, focusTerm, newSession, recordSent, terminalText, waitFor } from './harness'

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

/** composeStart dispatches composition events on the terminal's helper textarea without ending the composition. */
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

/** previewAtCursor asserts the preview overlay sits at the terminal cursor: inside .xterm-screen, near the bottom edge of the cursor cell. */
async function previewAtCursor(page: Page) {
  const g = await page.evaluate(() => {
    const p = document.querySelector('[data-testid=ime-preview]')!.getBoundingClientRect()
    const s = document.querySelector('.term .xterm-screen')!.getBoundingClientRect()
    const rows = document.querySelectorAll('.term .xterm-rows > div').length || 1
    return { p: { left: p.left, top: p.top }, s: { left: s.left, top: s.top, right: s.right, bottom: s.bottom }, cellH: s.height / rows }
  })
  expect(g.p.left, 'preview is inside the terminal area').toBeGreaterThanOrEqual(g.s.left - 1)
  expect(g.p.left).toBeLessThan(g.s.right)
  expect(g.p.top).toBeGreaterThanOrEqual(g.s.top)
  expect(g.p.top).toBeLessThanOrEqual(g.s.bottom + g.cellH)
}

test('E2E-7 direct terminal input: no INPUT frames during composition, one send on compositionend, inline preview at the cursor', async ({ page }) => {
  const rec = await recordSent(page)
  await agent.open(page)

  await page.getByTestId('terminal').click({ position: { x: 60, y: 60 } })
  const before = (await rec.input()).length

  await composeStart(page, ['ni', '你'])
  expect((await rec.input()).length, 'INPUT frames were sent during composition').toBe(before)
  await expect(page.getByTestId('ime-preview')).toBeVisible()
  await expect(page.getByTestId('ime-preview')).toHaveText('你')
  await previewAtCursor(page)

  await composeEnd(page, '你好')
  await waitFor(async () => (await rec.input()).length > before, 'sent on compositionend')
  await page.waitForTimeout(200)
  expect((await rec.input()).slice(before), 'compositionend sends "你好" exactly once').toEqual(['你好'])
  await expect(page.getByTestId('ime-preview')).toHaveCount(0)
})

test('E2E-7 direct terminal input after switching sessions (regression): IME reattaches to the new session textarea', async ({ page }) => {
  const rec = await recordSent(page)
  await agent.open(page)

  // Create a second session and switch to it. It has its own xterm instance and helper textarea,
  // and A's host is detached from the DOM at this point.
  await newSession(page)
  await page.getByTestId('terminal').click({ position: { x: 60, y: 60 } })
  const before = (await rec.input()).length

  await composeStart(page, ['你'])
  // The preview is the real regression check: if IME is not reattached it never appears (verified
  // by mutation). The byte check stays as a guard but cannot catch this bug, because a synthetic
  // CompositionEvent does not trigger xterm's onData (see the automation limits in
  // docs/90-roadmap/milestones.md).
  await expect(page.getByTestId('ime-preview')).toBeVisible()
  expect((await rec.input()).length).toBe(before)

  await composeEnd(page, '你好')
  await waitFor(async () => (await rec.input()).slice(before).join('') === '你好', 'compositionend sends "你好" in one go')
  await expect(page.getByTestId('ime-preview')).toHaveCount(0)
})

/**
 * softKeys presses the same on-screen keyboard key n times. Each press is keydown -> the browser
 * inserts the character into the textarea -> input -> keyup.
 *
 * The character is inserted only if keydown was not preventDefault'ed; keys xterm handles are
 * canceled. All n presses go out in a single evaluate so the gap between them falls inside the
 * 120ms dedup window; otherwise the test could not tell whether dedup eats the user's second press.
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

test('E2E-7 direct terminal input: full-width punctuation inserted by the on-screen keyboard (AC-3.14) all reaches the terminal, without duplicates', async ({ page }) => {
  await agent.open(page)
  await focusTerm(page)
  await page.keyboard.type('echo ')

  const softKey = (ch: string, keyCode: number) => softKeys(page, ch, keyCode, 1)
  // keyCode 0 is what iOS reports for direct insertion (the crux of this bug); 229 = diff path; 191 = keydown path.
  await softKey('，', 0)
  await softKey('。', 229)
  await softKey('！', 0)
  await softKey('？', 191)

  // A keyCode 0 punctuation mark right after a committed composition: typing Chinese then a comma is common.
  await composeStart(page, ['nihao'])
  await composeEnd(page, '你好')
  await softKey('，', 0)

  await page.keyboard.press('Enter')
  const want = '，。！？你好，'
  await waitFor(async () => (await terminalText(page)).split('\n').some((l) => l.trim() === want), `terminal echoes ${want}`)

  const text = await terminalText(page)
  expect(text, 'a duplicate send would produce "，，"').not.toContain('，，')
  expect(text, 'the composition result must not be sent twice').not.toContain('你好你好')
})

/**
 * Pressing the same punctuation key twice in a row (AC-3.14 / ADR-0020). This is a separate test
 * because the previous one asserts "，，" must not appear, while this one requires it. A character
 * inserted directly by the on-screen keyboard only goes through beforeinput; nothing else will send
 * the second press, so if dedup eats it the character is lost for good.
 */
test('E2E-7 (6) two quick presses of keyCode 0 "，": both arrive, dedup does not eat the second', async ({ page }) => {
  await agent.open(page)
  await focusTerm(page)
  await page.keyboard.type('echo ')

  // Both presses go out in one evaluate, far inside the 120ms dedup window.
  await softKeys(page, '，', 0, 2)

  await page.keyboard.press('Enter')
  await waitFor(
    async () => (await terminalText(page)).split('\n').some((l) => l.trim() === '，，'),
    'two presses of "，" must echo two; if dedup ate the second only one remains',
  )
})
