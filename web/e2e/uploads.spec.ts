/**
 * E2E-48 Sending files (AC-3.23 / AC-8.7, ADR-0051).
 *
 * The agent runs with its own TMPDIR (harness), so uploads land in `agent.uploadDir()` and the
 * test can read them back. `WebSocket.send` is hooked to record INPUT frames per session. The E2E
 * bash has bracketed paste enabled, so a pasted path arrives as `ESC[200~<path>ESC[201~` and just
 * sits on the command line.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename } from 'node:path'

import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, hooks, newSession, recordSent, switchTo, terminalText, waitFor, type SentRecorder } from './harness'

const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!

/** A 1×1 PNG. */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4810000000049454e44ae426082', 'hex')

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

/** readline turns bracketed paste on (?2004h) only when it prints the prompt. */
const atPrompt = (page: Page) => waitFor(async () => (await terminalText(page)).trimEnd().endsWith('$'), 'shell back at the prompt')

const PASTE = /\x1b\[200~(.*?)\x1b\[201~/g
/** The paths pasted so far (all sessions, or one), in order. */
async function pasted(rec: SentRecorder, sid?: number): Promise<string[]> {
  const frames = sid === undefined ? await rec.input() : await rec.inputOf(sid)
  return [...frames.join('').matchAll(PASTE)].map((m) => m[1]!)
}
async function waitPasted(rec: SentRecorder, n: number, sid?: number): Promise<string[]> {
  await waitFor(async () => (await pasted(rec, sid)).length >= n, `${n} path(s) pasted`, 10_000)
  return pasted(rec, sid)
}

/** Opens the picker with `button` and chooses `files`, the way a user does (pickFiles → input.click()). */
async function pick(page: Page, button: string, files: { name: string; mimeType: string; buffer: Buffer }[], tap = false) {
  const chooser = page.waitForEvent('filechooser')
  if (tap) await page.getByTestId(button).tap()
  else await page.getByTestId(button).click()
  await (await chooser).setFiles(files)
}

test.describe('phone', () => {
  test.use(PIXEL)

  test('E2E-48 (1)-(5) the text page paperclip: geometry, one file, order, busy, too large', async ({ page }) => {
    const rec = await recordSent(page)
    await agent.open(page)
    await atPrompt(page)
    await page.waitForTimeout(300)
    const size = await hooks.size(page)
    const resizes = await hooks.resizes(page)

    // (1) The paperclip floats over the text box's bottom-right corner; the box keeps its full width, border and gaps.
    await page.getByTestId('toggle-text').tap()
    const clip = page.getByTestId('text-upload-file')
    await expect(clip).toBeVisible()
    const geo = await page.evaluate(() => {
      const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect().toJSON() as DOMRect
      const ta = document.querySelector('[data-testid=textinput]')!
      const cs = getComputedStyle(ta)
      return {
        ta: r('[data-testid=textinput]'),
        icon: r('[data-testid=text-upload-file] svg'),
        slot: r('[data-testid=extrakeys]'),
        widths: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map(parseFloat),
      }
    })
    expect(geo.icon.left, 'icon inside the box').toBeGreaterThan(geo.ta.left)
    expect(geo.icon.top).toBeGreaterThan(geo.ta.top)
    expect(geo.icon.right).toBeLessThan(geo.ta.right)
    expect(geo.icon.bottom).toBeLessThan(geo.ta.bottom)
    expect(geo.ta.right - geo.icon.right, 'in the right edge').toBeLessThanOrEqual(4)
    expect(geo.ta.bottom - geo.icon.bottom, 'at the bottom edge').toBeLessThanOrEqual(4)
    expect(geo.slot.right - geo.ta.right, 'no column beside the box: only the 6px gap').toBeCloseTo(6, 0)
    for (const w of geo.widths) expect(w, 'text box border on all four sides').toBeGreaterThanOrEqual(1)
    for (const g of [geo.ta.top - geo.slot.top, geo.slot.right - geo.ta.right, geo.slot.bottom - geo.ta.bottom, geo.ta.left - geo.slot.left]) {
      expect(g, 'text box inside the slot with a gap on every side').toBeGreaterThan(0)
    }
    await page.waitForTimeout(300)
    expect(await hooks.size(page), 'no change to rows and columns').toEqual(size)
    expect(await hooks.resizes(page), 'no resize').toBe(resizes)

    // (2) One file: its path alone, bracketed, no Enter; the file is there; the draft is untouched.
    await page.getByTestId('textinput').fill('DRAFT')
    await rec.clear()
    await pick(page, 'text-upload-file', [{ name: 'shot 1.png', mimeType: 'image/png', buffer: PNG }], true)
    await expect(page.getByTestId('textinput'), 'tapping the paperclip keeps focus in the box').toBeFocused()
    const [path] = await waitPasted(rec, 1)
    expect((await rec.input()).join(''), 'exactly one bracketed path, nothing else (no Enter)').toBe(`\x1b[200~${path}\x1b[201~`)
    expect(path!.startsWith(agent.uploadDir() + '/'), path).toBe(true)
    expect(basename(path!)).toMatch(/^shot-1-[0-9a-f]{6}\.png$/)
    expect(readFileSync(path!).equals(PNG), 'same bytes').toBe(true)
    expect(statSync(path!).mode & 0o777).toBe(0o600)
    await expect(page.getByTestId('textinput')).toHaveValue('DRAFT')

    // (3) Two files in one pick: two pastes, in order.
    await rec.clear()
    await pick(page, 'text-upload-file', [
      { name: 'a.png', mimeType: 'image/png', buffer: PNG },
      { name: 'b.txt', mimeType: 'text/plain', buffer: Buffer.from('log line\n') },
    ], true)
    const two = await waitPasted(rec, 2)
    expect(basename(two[0]!)).toMatch(/^a-[0-9a-f]{6}\.png$/)
    expect(basename(two[1]!)).toMatch(/^b-[0-9a-f]{6}\.txt$/)

    // (4) Busy while the request is in flight.
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    await page.route('**/api/uploads*', async (route) => {
      await held
      await route.continue()
    })
    await rec.clear()
    await pick(page, 'text-upload-file', [{ name: 'slow.png', mimeType: 'image/png', buffer: PNG }], true)
    await expect(clip).toHaveAttribute('data-busy', 'true')
    release()
    await waitPasted(rec, 1)
    await expect(clip).toHaveAttribute('data-busy', 'false')
    await page.unroute('**/api/uploads*')

    // (5) Too large: a toast naming the limit, nothing pasted, nothing kept.
    const before = readdirSync(agent.uploadDir()).length
    await rec.clear()
    await pick(page, 'text-upload-file', [{ name: 'big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(21 << 20) }], true)
    await expect(page.getByTestId('toast')).toContainText('20 MB', { timeout: 15_000 })
    expect(await rec.input()).toEqual([])
    expect(readdirSync(agent.uploadDir()).length, 'nothing kept, no .part left').toBe(before)
  })
})

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('E2E-48 (6)-(9) tab bar paperclip, pasting a screenshot, dropping a file, the target is fixed at pick time', async ({ page }) => {
    const rec = await recordSent(page)
    await agent.open(page)
    await atPrompt(page)

    // (6) In the top bar between + and the status dot, the same size and height as ⚙.
    const geo = await page.evaluate(() => {
      const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect()
      const svg = (id: string) => r(`[data-testid=${id}] svg`)
      return {
        newBtn: r('[data-testid=new-session]').toJSON(),
        clip: r('[data-testid=upload-file]').toJSON(),
        dot: r('[data-testid=conn-dot]').toJSON(),
        clipSvg: svg('upload-file').toJSON(),
        gearSvg: svg('open-settings').toJSON(),
        inTopbar: !!document.querySelector('.topbar [data-testid=upload-file]'),
      }
    })
    expect(geo.inTopbar).toBe(true)
    expect(geo.clip.left).toBeGreaterThan(geo.newBtn.right)
    expect(geo.clip.right).toBeLessThanOrEqual(geo.dot.left)
    expect(geo.clipSvg.width).toBeCloseTo(geo.gearSvg.width, 1)
    expect(geo.clipSvg.height).toBeCloseTo(geo.gearSvg.height, 1)
    expect(Math.abs(geo.clipSvg.top + geo.clipSvg.height / 2 - (geo.gearSvg.top + geo.gearSvg.height / 2))).toBeLessThanOrEqual(0.5)
    await rec.clear()
    await pick(page, 'upload-file', [{ name: 'desk.png', mimeType: 'image/png', buffer: PNG }])
    expect(basename((await waitPasted(rec, 1))[0]!)).toMatch(/^desk-[0-9a-f]{6}\.png$/)

    // (7) A screenshot on the clipboard (a file, no text) → uploaded and pasted; a text paste stays a text paste.
    await rec.clear()
    let uploads = 0
    page.on('request', (r) => {
      if (r.url().includes('/api/uploads')) uploads++
    })
    await page.evaluate((bytes) => {
      const dt = new DataTransfer()
      dt.items.add(new File([new Uint8Array(bytes)], 'image.png', { type: 'image/png' }))
      document.querySelector('.xterm-helper-textarea')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, [...PNG])
    expect(basename((await waitPasted(rec, 1))[0]!)).toMatch(/^image-[0-9a-f]{6}\.png$/)
    expect(uploads).toBe(1)
    await page.evaluate(() => {
      const dt = new DataTransfer()
      dt.setData('text/plain', 'echo PASTED')
      document.querySelector('.xterm-helper-textarea')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    })
    expect((await waitPasted(rec, 2))[1], 'the text went in as text').toBe('echo PASTED')
    expect(uploads, 'no upload for a text paste').toBe(1)

    // (8) Dropping a file: outline while over the page, then pasted; the page stays put.
    await rec.clear()
    const url = page.url()
    const dt = await page.evaluateHandle((bytes) => {
      const d = new DataTransfer()
      d.items.add(new File([new Uint8Array(bytes)], 'drop.png', { type: 'image/png' }))
      return d
    }, [...PNG])
    await page.dispatchEvent('[data-testid=terminal]', 'dragenter', { dataTransfer: dt })
    await page.dispatchEvent('[data-testid=terminal]', 'dragover', { dataTransfer: dt })
    await expect(page.locator('.stage')).toHaveAttribute('data-drop', 'true')
    await page.dispatchEvent('[data-testid=terminal]', 'drop', { dataTransfer: dt })
    expect(basename((await waitPasted(rec, 1))[0]!)).toMatch(/^drop-[0-9a-f]{6}\.png$/)
    await expect(page.locator('.stage')).not.toHaveAttribute('data-drop', 'true')
    expect(page.url()).toBe(url)

    // (9) The target is the session current when the file was chosen, even if you switch while it uploads.
    const a = (await hooks.sid(page))!
    const b = await newSession(page)
    await switchTo(page, a)
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    await page.route('**/api/uploads*', async (route) => {
      await held
      await route.continue()
    })
    await rec.clear()
    await pick(page, 'upload-file', [{ name: 'target.png', mimeType: 'image/png', buffer: PNG }])
    await expect(page.getByTestId('upload-file')).toHaveAttribute('data-busy', 'true')
    await switchTo(page, b)
    release()
    expect(basename((await waitPasted(rec, 1, a))[0]!)).toMatch(/^target-[0-9a-f]{6}\.png$/)
    await page.waitForTimeout(300)
    expect(await pasted(rec, b), 'nothing went to the session switched to').toEqual([])
  })
})
