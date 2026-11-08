/**
 * E2E-49 Links (AC-5.19) and E2E-50 Clipboard from programs (AC-5.20), ADR-0053.
 *
 * `window.open` is replaced with a recorder; contexts get clipboard permissions so the test
 * can read what the page wrote. Touch taps are real CDP touch events.
 */
import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, FIXTURES, hooks, newSession, recordSent, submit, switchTo, terminalText, waitFor, waitText } from './harness'

const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
const WIDE = { viewport: { width: 1440, height: 900 }, contextOptions: { screen: { width: 1440, height: 900 } } }
const CLIPBOARD = { permissions: ['clipboard-read', 'clipboard-write'] }

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

/** recordOpen replaces window.open with a recorder, before the page loads. */
async function recordOpen(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __opened: string[] }
    w.__opened = []
    window.open = ((url?: string | URL) => {
      w.__opened.push(String(url))
      return null
    }) as typeof window.open
  })
  return () => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened.slice())
}

/**
 * cellPoint returns the viewport point of character `offset` past the start of `needle` on the
 * first screen row matching `row` (DOM renderer rows, NBSP read as space).
 */
async function cellPoint(page: Page, row: RegExp, needle: string, offset = 2): Promise<{ x: number; y: number }> {
  // The buffer holds the text before the DOM renderer has drawn it (it draws on the next
  // frame), so wait for the row to be on screen rather than reading the DOM once
  let p: { x: number; y: number } | null = null
  await waitFor(async () => (p = await rowPoint(page, row, needle, offset)) !== null, `screen row ${row} with ${needle}`, 5_000)
  return p!
}

function rowPoint(page: Page, row: RegExp, needle: string, offset: number): Promise<{ x: number; y: number } | null> {
  return page.evaluate(
    ([src, flags, needle, offset]) => {
      const re = new RegExp(src, flags)
      const screen = document.querySelector<HTMLElement>('.xterm-screen')
      const rows = [...document.querySelectorAll<HTMLElement>('.xterm-rows > div')]
      const cols = (window as unknown as { __webterm: { size(): { cols: number } } }).__webterm.size().cols
      if (!screen) return null
      const sr = screen.getBoundingClientRect()
      for (const r of rows) {
        const text = (r.textContent ?? '').replace(/ /g, ' ')
        if (!re.test(text)) continue
        const i = text.indexOf(needle)
        if (i < 0) continue
        const rr = r.getBoundingClientRect()
        const cw = sr.width / cols
        return { x: sr.left + (i + offset + 0.5) * cw, y: rr.top + rr.height / 2 }
      }
      return null
    },
    [row.source, row.flags, needle, offset] as const,
  )
}

/** tap sends a real CDP touch tap at p. */
async function tap(page: Page, p: { x: number; y: number }) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] })
  await page.waitForTimeout(40)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText())
const setClipboard = (page: Page, text: string) => page.evaluate((t) => navigator.clipboard.writeText(t), text)

/** ctrlClick hovers first (xterm finds links on hover), then clicks with Ctrl held. */
async function ctrlClick(page: Page, p: { x: number; y: number }) {
  await page.mouse.move(p.x, p.y)
  await page.waitForTimeout(150)
  await page.keyboard.down('Control')
  await page.mouse.click(p.x, p.y)
  await page.keyboard.up('Control')
  await page.waitForTimeout(150)
}

test.describe('E2E-49 links, desktop', () => {
  test.use({ ...WIDE, ...CLIPBOARD })

  test('Ctrl+click opens http(s) links once, plain click does nothing, other schemes never open, wrapped URLs open whole', async ({ page }) => {
    const opened = await recordOpen(page)
    await agent.open(page)

    await submit(page, `printf 'see https://example.com/a?b=1.\\n'`)
    await waitText(page, /^see https:\/\/example\.com\/a\?b=1\.$/m)
    const p = await cellPoint(page, /^see https/, 'https://')
    await page.mouse.click(p.x, p.y)
    await page.waitForTimeout(200)
    expect(await opened(), 'a plain click opens nothing').toEqual([])
    await ctrlClick(page, p)
    expect(await opened()).toEqual(['https://example.com/a?b=1'])

    await submit(page, `printf 'file:///etc/passwd javascript:alert(1)\\n'`)
    await waitText(page, /^file:\/\/\/etc\/passwd javascript/m)
    await ctrlClick(page, await cellPoint(page, /^file:/, 'file:'))
    await ctrlClick(page, await cellPoint(page, /^file:/, 'javascript:'))
    expect(await opened(), 'other schemes never open').toEqual(['https://example.com/a?b=1'])

    const url = 'https://example.com/' + 'x'.repeat(250)
    await submit(page, `printf 'https://example.com/%s\\n' "$(printf 'x%.0s' $(seq 250))"`)
    await waitFor(async () => (await terminalText(page)).replace(/\n/g, '').includes(url), 'wrapped URL printed')
    // The second row of the output is all x's
    await ctrlClick(page, await cellPoint(page, /^x{40,}/, 'xxxx', 10))
    expect((await opened()).at(-1), 'the whole wrapped URL opens').toBe(url)
  })
})

test.describe('E2E-49 links, touch', () => {
  test.use({ ...PIXEL, ...CLIPBOARD })

  test('a tap on a URL shows Open · Copy without sending anything; Copy and Open act; Esc and switching close it', async ({ page }) => {
    const opened = await recordOpen(page)
    const rec = await recordSent(page)
    await agent.open(page)
    const a = (await hooks.sid(page))!
    const url = 'https://example.com/a?b=1'

    await submit(page, `printf 'see ${url}.\\n'`)
    await waitText(page, /^see https:\/\/example\.com/m)
    await page.waitForTimeout(300)
    const before = (await rec.input()).length
    const focus = await page.evaluate(() => document.activeElement?.className ?? '')
    await tap(page, await cellPoint(page, /^see https/, 'https://'))
    await expect(page.getByTestId('link-popover')).toBeVisible()
    await expect(page.getByTestId('link-url')).toHaveText(url)
    await page.waitForTimeout(300)
    expect((await rec.input()).length, 'a tap on a link sends nothing').toBe(before)
    expect(await page.evaluate(() => document.activeElement?.className ?? ''), 'the keyboard did not toggle').toBe(focus)

    await page.getByTestId('link-copy').click()
    await expect(page.getByTestId('link-popover')).toHaveCount(0)
    expect(await clipboard(page)).toBe(url)

    await tap(page, await cellPoint(page, /^see https/, 'https://'))
    await page.getByTestId('link-open').click()
    await expect(page.getByTestId('link-popover')).toHaveCount(0)
    expect(await opened()).toEqual([url])

    // Esc closes it and doesn't reach the program
    await tap(page, await cellPoint(page, /^see https/, 'https://'))
    await expect(page.getByTestId('link-popover')).toBeVisible()
    const n = (await rec.input()).length
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('link-popover')).toHaveCount(0)
    await page.waitForTimeout(300)
    expect((await rec.input()).slice(n).join(''), 'Esc went to the popover, not the PTY').not.toContain('\x1b')

    // Switching sessions closes it
    const b = await newSession(page)
    await switchTo(page, a)
    await tap(page, await cellPoint(page, /^see https/, 'https://'))
    await expect(page.getByTestId('link-popover')).toBeVisible()
    await page.keyboard.press('Control+Shift+ArrowDown')
    await waitFor(async () => (await hooks.sid(page)) === b, 'switched to B')
    await expect(page.getByTestId('link-popover')).toHaveCount(0)
  })

  test('under mouse tracking a tap on a URL opens the popover and sends no mouse report; elsewhere it still clicks', async ({ page }) => {
    const rec = await recordSent(page)
    await agent.open(page)
    await submit(page, `python3 ${FIXTURES}/mouselink.py`)
    await waitText(page, 'clicks: 0')
    await page.waitForTimeout(300)
    const before = (await rec.input()).length
    await tap(page, await cellPoint(page, /^open https/, 'https://'))
    await expect(page.getByTestId('link-popover')).toBeVisible()
    await page.waitForTimeout(300)
    expect((await rec.input()).slice(before).join(''), 'no mouse report for a tap on a link').not.toMatch(/\x1b\[</)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('link-popover')).toHaveCount(0)

    await tap(page, await cellPoint(page, /^clicks/, 'clicks', 3))
    await waitText(page, 'clicks: 1', 'a tap elsewhere is still a click for the program')
    await page.keyboard.type('q')
  })
})

test.describe('E2E-50 clipboard from programs', () => {
  test.use({ ...WIDE, ...CLIPBOARD })

  test('OSC 52 writes the clipboard from live output of the current session only; reads are never answered', async ({ page }) => {
    const rec = await recordSent(page)
    await agent.open(page)
    const a = (await hooks.sid(page))!

    // Write, with UTF-8
    await submit(page, `printf '\\e]52;c;%s\\a' "$(printf 'hello 52 \\xe4\\xbd\\xa0\\xe5\\xa5\\xbd' | base64)"`)
    await waitFor(async () => (await clipboard(page)) === 'hello 52 你好', 'clipboard holds the text')
    await expect(page.getByTestId('toast')).toHaveText('Copied')

    // A read is never answered
    await page.waitForTimeout(500)
    const n = (await rec.input()).length
    await submit(page, `printf '\\e]52;c;?\\a'; echo READ-DONE`)
    await waitText(page, /^READ-DONE$/m)
    await page.waitForTimeout(500)
    const typed = (await rec.input()).slice(n).join('')
    expect(typed, 'no OSC 52 reply went to the PTY').not.toContain('\x1b]52')
    expect(await clipboard(page)).toBe('hello 52 你好')

    // Not from replay: produced while A is in the background, delivered by the catch-up
    await setClipboard(page, 'before')
    const b = await newSession(page)
    await switchTo(page, a)
    await submit(page, `sleep 3; printf '\\e]52;c;%s\\a' "$(printf replayed | base64)"; echo REPLAY-DONE`)
    await switchTo(page, b)
    await page.waitForTimeout(4500)
    await switchTo(page, a)
    await waitText(page, /^REPLAY-DONE$/m)
    await page.waitForTimeout(500)
    expect(await clipboard(page), 'catch-up did not write the clipboard').toBe('before')
    await page.reload()
    await waitFor(async () => (await hooks.sid(page)) !== null, 'reloaded')
    await page.waitForTimeout(1500)
    expect(await clipboard(page), 'the snapshot did not write the clipboard').toBe('before')

    // Not from a pinned session in the background
    await switchTo(page, a)
    await page.getByTestId(`tab-${a}`).click({ button: 'right' })
    await page.getByTestId('session-menu').getByTestId('session-pin').click()
    await submit(page, `sleep 2; printf '\\e]52;c;%s\\a' "$(printf background | base64)"; echo BG-DONE`)
    await switchTo(page, b)
    await page.waitForTimeout(3500)
    expect(await clipboard(page), 'a background session did not write the clipboard').toBe('before')
  })

  test('when the browser refuses, the Copy bar copies on a click', async ({ page }) => {
    await agent.open(page)
    await page.evaluate(() => {
      const c = navigator.clipboard
      const orig = c.writeText.bind(c)
      let calls = 0
      c.writeText = (t: string) => (calls++ === 0 ? Promise.reject(new Error('needs a gesture')) : orig(t))
    })
    await submit(page, `printf '\\e]52;c;%s\\a' "$(printf 'from the bar' | base64)"`)
    await expect(page.getByTestId('clip-bar')).toBeVisible()
    await expect(page.getByTestId('clip-bar')).toContainText('from the bar')
    await page.getByTestId('clip-copy').click()
    await expect(page.getByTestId('clip-bar')).toHaveCount(0)
    expect(await clipboard(page)).toBe('from the bar')
  })
})
