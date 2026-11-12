/**
 * E2E-53 Files (AC-9.1–AC-9.11, ADR-0059).
 *
 * The agent runs with a temporary HOME holding `proj/` (folders, hidden entries, text, a PNG, a
 * binary file, a 600 KiB log); the session `cd`s there first. `WebSocket.send` is recorded; the
 * E2E bash has bracketed paste on, so Send to session arrives as `ESC[200~<path>ESC[201~`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { devices, expect, test, type Locator, type Page } from '@playwright/test'

import { Agent, focusTerm, hooks, openDrawer, recordSent, settled, submit, terminalText, waitFor } from './harness'

const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!

/** A 1×1 PNG. */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4810000000049454e44ae426082', 'hex')

let agent: Agent
let home: string
let proj: string
test.beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'webterm-home-'))
  proj = join(home, 'proj')
  for (const d of ['src', 'Docs', '.git']) mkdirSync(join(proj, d), { recursive: true })
  writeFileSync(join(proj, 'b.txt'), 'hello')
  writeFileSync(join(proj, 'a 1.txt'), 'A1')
  writeFileSync(join(proj, '.env'), 'X=1')
  writeFileSync(join(proj, 'shot.png'), PNG)
  writeFileSync(join(proj, 'blob.bin'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 1, 2, 3]))
  writeFileSync(join(proj, 'big.log'), 'x'.repeat(100) + '\n' + 'line of the log\n'.repeat(40_000) + 'TAIL-LINE\n')
  agent = await Agent.start({ home })
})
test.afterEach(() => agent.stop())

const atPrompt = (page: Page) => waitFor(async () => (await terminalText(page)).trimEnd().endsWith('$'), 'shell at the prompt')

/** cd into a folder and wait until the agent reports it as the session's cwd. */
async function cd(page: Page, dir: string) {
  await focusTerm(page)
  await submit(page, `cd '${dir}'`)
  await waitFor(async () => (await hooks.cwd(page)) === dir, `cwd is ${dir}`, 10_000)
  await atPrompt(page)
}

async function openFiles(page: Page) {
  if ((await hooks.form(page)) === 'compact') {
    await openDrawer(page)
    await page.getByTestId('open-files').tap()
  } else {
    await page.getByTestId('open-files').click()
  }
  await expect(page.getByTestId('files-sheet')).toBeVisible()
  await settled(page, 'files-sheet')
}

const names = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-testid=files-row]')].map((e) => e.dataset.name!))
const lastCrumb = (page: Page) => page.getByTestId('files-crumb').last()
const row = (page: Page, name: string) => page.locator(`[data-testid=files-row][data-name="${name}"]`)
const item = (page: Page, name: string) => page.locator('.sl-item', { has: row(page, name) })
const closeSheet = (page: Page, testid: string) => page.getByTestId(testid).getByTestId('drawer-close').click()

async function waitRow(page: Page, name: string, present = true) {
  await waitFor(async () => (await names(page)).includes(name) === present, `${name} ${present ? 'listed' : 'gone'}`, 10_000)
}

async function openFile(page: Page, name: string) {
  await row(page, name).click()
  await expect(page.getByTestId('file-sheet')).toBeVisible()
  await settled(page, 'file-sheet')
}

async function touchDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 8) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] })
  for (let i = 1; i <= steps; i++) {
    const p = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] })
    await page.waitForTimeout(16)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

async function longPress(page: Page, x: number, y: number, ms = 700) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  await page.waitForTimeout(ms)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

async function pick(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('files-upload').click()
  await (await chooser).setFiles(files)
}

test.describe('phone', () => {
  test.use(PIXEL)

  test('E2E-53 (1)-(8) entry, order, navigation, previews, Send to session, remembering', async ({ page }) => {
    const rec = await recordSent(page)
    await agent.open(page)
    await atPrompt(page)
    await cd(page, proj)
    await page.waitForTimeout(300)
    const resizes = await hooks.resizes(page)

    // (1) Entry: the drawer's bottom row, then a bottom sheet 80% of the visible area tall
    await openDrawer(page)
    const foot = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid=session-drawer] .drawer-foot button')].map((b) => ({
        id: (b as HTMLElement).dataset.testid,
        r: b.getBoundingClientRect().toJSON() as DOMRect,
      })),
    )
    expect(foot.map((b) => b.id)).toEqual(['new-session', 'open-files', 'open-settings'])
    expect(foot[1]!.r.width).toBeCloseTo(foot[2]!.r.width, 0)
    expect(foot[1]!.r.height).toBeCloseTo(foot[2]!.r.height, 0)
    await page.getByTestId('open-files').tap()
    await expect(page.getByTestId('session-drawer')).toHaveCount(0)
    await expect(page.getByTestId('files-sheet')).toBeVisible()
    await settled(page, 'files-sheet')
    const geo = await page.evaluate(() => ({
      sheet: document.querySelector('[data-testid=files-sheet]')!.getBoundingClientRect().height,
      area: document.querySelector('[data-testid=files-backdrop]')!.getBoundingClientRect().height,
    }))
    expect(Math.abs(geo.sheet - geo.area * 0.8)).toBeLessThanOrEqual(1)
    await expect(lastCrumb(page)).toHaveText('proj')
    await expect(page.getByTestId('files-crumb').first()).toHaveText('~')

    // (2) Order: folders, files, hidden folders, hidden files
    await waitRow(page, 'b.txt')
    expect(await names(page)).toEqual(['Docs', 'src', 'a 1.txt', 'b.txt', 'big.log', 'blob.bin', 'shot.png', '.git', '.env'])
    await expect(row(page, '.git')).toHaveAttribute('data-hidden', 'true')
    await expect(row(page, '.env')).toHaveAttribute('data-hidden', 'true')
    await expect(row(page, 'b.txt')).toContainText('5 B')

    // (3) Navigate: into a folder, up, the ~ crumb, the filter
    await row(page, 'src').click()
    await expect(lastCrumb(page)).toHaveText('src')
    await page.getByTestId('files-up').click()
    await expect(lastCrumb(page)).toHaveText('proj')
    await page.getByTestId('files-crumb').first().click()
    await waitRow(page, 'proj')
    await row(page, 'proj').click()
    await waitRow(page, 'b.txt')
    await page.getByTestId('files-filter').fill('B')
    await waitFor(async () => (await names(page)).join() === 'b.txt,big.log,blob.bin', 'filtered')
    await row(page, 'blob.bin').click()
    await closeSheet(page, 'file-sheet')
    await page.getByTestId('files-filter').fill('Do')
    await row(page, 'Docs').click()
    await expect(lastCrumb(page)).toHaveText('Docs')
    await expect(page.getByTestId('files-filter')).toHaveValue('')
    await page.getByTestId('files-up').click()
    await waitRow(page, 'b.txt')

    // (4) Text: the file sheet covers the list; ✕ goes back to the list
    await openFile(page, 'b.txt')
    const rects = await page.evaluate(() =>
      ['files-sheet', 'file-sheet'].map((t) => document.querySelector(`[data-testid=${t}]`)!.getBoundingClientRect().toJSON() as DOMRect),
    )
    for (const k of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(rects[0]![k] - rects[1]![k]), k).toBeLessThanOrEqual(1)
    await expect(page.getByTestId('file-text')).toHaveText('hello')
    await expect(page.getByTestId('file-meta')).toContainText(/^5 B/)
    await closeSheet(page, 'file-sheet')
    await expect(page.getByTestId('file-sheet')).toHaveCount(0)
    await expect(page.getByTestId('files-sheet')).toBeVisible()

    // (5) A big log: the start, then End
    await openFile(page, 'big.log')
    await expect(page.getByTestId('file-text')).toContainText('line of the log')
    expect(await page.getByTestId('file-text').textContent()).not.toContain('TAIL-LINE')
    await page.getByTestId('file-end').click()
    await expect(page.getByTestId('file-text')).toContainText('TAIL-LINE')
    await expect(page.getByTestId('file-end')).toHaveText('Start')
    await closeSheet(page, 'file-sheet')

    // (6) Image and binary
    await openFile(page, 'shot.png')
    await waitFor(() => page.getByTestId('file-image').evaluate((img) => (img as HTMLImageElement).naturalWidth > 0), 'image loaded')
    await page.getByTestId('file-image').click()
    await expect(page.getByTestId('file-image')).toHaveAttribute('data-zoom', 'true')
    await closeSheet(page, 'file-sheet')
    await openFile(page, 'blob.bin')
    await expect(page.getByTestId('file-nopreview')).toBeVisible()
    await closeSheet(page, 'file-sheet')

    // (7) Send to session: the escaped path, bracketed, no Enter; every sheet closes
    await rec.clear()
    await openFile(page, 'a 1.txt')
    await page.getByTestId('file-send').click()
    const want = `\x1b[200~${proj}/a\\ 1.txt\x1b[201~`
    await waitFor(async () => (await rec.input()).join('') === want, 'the escaped path pasted', 5_000)
    await expect(page.locator('.drawer')).toHaveCount(0)
    await focusTerm(page)
    await page.keyboard.press('Control+U')

    // (8) Remembering: back in the subfolder while the cwd is the same; the new cwd after cd
    await openFiles(page)
    await row(page, 'src').click()
    await expect(lastCrumb(page)).toHaveText('src')
    await closeSheet(page, 'files-sheet')
    await openFiles(page)
    await expect(lastCrumb(page)).toHaveText('src')
    await closeSheet(page, 'files-sheet')
    await cd(page, '/tmp')
    await openFiles(page)
    await expect(lastCrumb(page)).toHaveText('tmp')
    await closeSheet(page, 'files-sheet')

    expect(await hooks.resizes(page), 'no resize').toBe(resizes)
  })

  test('E2E-53 (9)-(12) upload, new folder, rename, delete', async ({ page }) => {
    const rec = await recordSent(page)
    await agent.open(page)
    await atPrompt(page)
    await cd(page, proj)
    await openFiles(page)
    await waitRow(page, 'b.txt')
    await rec.clear()

    // (9) Upload keeps the name, never overwrites, shows progress
    await pick(page, [{ name: 'up.txt', mimeType: 'text/plain', buffer: Buffer.from('UP') }])
    await waitRow(page, 'up.txt')
    expect(readFileSync(join(proj, 'up.txt'), 'utf8')).toBe('UP')
    await pick(page, [{ name: 'up.txt', mimeType: 'text/plain', buffer: Buffer.from('UP2') }])
    await expect(page.getByTestId('toast')).toHaveText('Saved as up-1.txt')
    await waitRow(page, 'up-1.txt')
    expect(readFileSync(join(proj, 'up.txt'), 'utf8')).toBe('UP')
    let release: () => void = () => {}
    const held = new Promise<void>((r) => (release = r))
    await page.route('**/api/fs/upload**', async (route) => {
      await held
      await route.continue()
    })
    await pick(page, [{ name: 'slow.txt', mimeType: 'text/plain', buffer: Buffer.from('S') }])
    await expect(page.getByTestId('files-upload')).toHaveAttribute('data-busy', 'true')
    await expect(page.getByTestId('files-upload')).toContainText('Uploading')
    release()
    await waitRow(page, 'slow.txt')
    await expect(page.getByTestId('files-upload')).toHaveAttribute('data-busy', 'false')
    await page.unroute('**/api/fs/upload**')
    expect(await rec.input(), 'nothing typed into the session').toEqual([])

    // (10) New folder; a taken name keeps the sheet open
    await page.getByTestId('files-mkdir').click()
    await expect(page.getByTestId('name-sheet')).toBeVisible()
    await page.getByTestId('name-input').fill('made')
    await page.getByTestId('name-input').press('Enter')
    await waitRow(page, 'made')
    expect(statSync(join(proj, 'made')).isDirectory()).toBe(true)
    await expect(page.getByTestId('name-sheet')).toHaveCount(0)
    await page.getByTestId('files-mkdir').click()
    await page.getByTestId('name-input').fill('made')
    await page.getByTestId('name-input').press('Enter')
    await expect(page.getByTestId('toast')).toContainText('taken')
    await expect(page.getByTestId('name-sheet')).toBeVisible()
    await page.getByTestId('name-cancel').click()

    // (11) Rename from a swipe: the stem starts selected
    const b = (await row(page, 'b.txt').boundingBox())!
    const from = { x: b.x + b.width * 0.66, y: b.y + b.height / 2 }
    await touchDrag(page, from, { x: from.x - 120, y: from.y })
    await expect(item(page, 'b.txt')).toHaveAttribute('data-open', 'true')
    await item(page, 'b.txt').getByTestId('file-row-rename').click()
    await expect(page.getByTestId('name-input')).toHaveValue('b.txt')
    const sel = await page.getByTestId('name-input').evaluate((el) => [(el as HTMLInputElement).selectionStart, (el as HTMLInputElement).selectionEnd])
    expect(sel).toEqual([0, 1])
    await page.keyboard.type('c')
    await page.getByTestId('name-input').press('Enter')
    await waitRow(page, 'c.txt')
    expect(readFileSync(join(proj, 'c.txt'), 'utf8')).toBe('hello')
    expect(existsSync(join(proj, 'b.txt'))).toBe(false)

    // (12) Delete from a long-press, confirmed with Enter
    const m = (await row(page, 'made').boundingBox())!
    await longPress(page, m.x + m.width / 2, m.y + m.height / 2)
    await expect(item(page, 'made')).toHaveAttribute('data-open', 'true')
    await item(page, 'made').getByTestId('file-row-delete').click()
    await expect(page.getByTestId('delete-confirm')).toBeVisible()
    await expect(page.getByTestId('delete-confirm').locator('.drawer-title')).toHaveText('Delete "made"?')
    await expect(page.getByTestId('delete-ok')).toBeFocused()
    await page.keyboard.press('Enter')
    await waitRow(page, 'made', false)
    expect(existsSync(join(proj, 'made'))).toBe(false)
  })

  test('E2E-53 (13)-(15) new session here, Back, Share', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __shared: { name: string; text: string }[] | null }
      w.__shared = null
      Object.assign(navigator, {
        canShare: () => true,
        share: async (data: { files: File[] }) => {
          w.__shared = await Promise.all(data.files.map(async (f) => ({ name: f.name, text: await f.text() })))
        },
      })
    })
    await agent.open(page)
    await atPrompt(page)
    await cd(page, proj)

    // (14) Back closes the top sheet only, and entries don't pile up
    const before = await page.evaluate(() => history.length)
    await openFiles(page)
    await waitRow(page, 'b.txt')
    await openFile(page, 'b.txt')
    await page.evaluate(() => history.back())
    await expect(page.getByTestId('file-sheet')).toHaveCount(0)
    await expect(page.getByTestId('files-sheet')).toBeVisible()
    await page.evaluate(() => history.back())
    await expect(page.getByTestId('files-sheet')).toHaveCount(0)
    expect(new URL(page.url()).origin).toBe(agent.baseURL)
    for (let i = 0; i < 3; i++) {
      await openFiles(page)
      await waitRow(page, 'b.txt')
      await openFile(page, 'b.txt')
      await closeSheet(page, 'file-sheet')
      await closeSheet(page, 'files-sheet')
      await expect(page.locator('.drawer')).toHaveCount(0)
    }
    await page.waitForTimeout(200)
    expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(before + 2)

    // (15) Share hands the file to the share sheet
    await openFiles(page)
    await waitRow(page, 'b.txt')
    await openFile(page, 'b.txt')
    await page.getByTestId('file-share').click()
    await waitFor(() => page.evaluate(() => (window as unknown as { __shared: unknown }).__shared !== null), 'shared')
    expect(await page.evaluate(() => (window as unknown as { __shared: unknown }).__shared)).toEqual([{ name: 'b.txt', text: 'hello' }])
    await closeSheet(page, 'file-sheet')

    // (13) New session here
    await row(page, 'src').click()
    await expect(lastCrumb(page)).toHaveText('src')
    const sid = await hooks.sid(page)
    await page.getByTestId('files-terminal').click()
    await expect(page.locator('.drawer')).toHaveCount(0)
    await waitFor(async () => (await hooks.sid(page)) !== sid, 'switched to the new session')
    await waitFor(async () => (await hooks.cwd(page)) === join(proj, 'src'), 'the new session is in src', 10_000)
  })
})

test.describe('desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('E2E-53 (16)-(17) tab bar entry, dialog, right-click, Download, drop', async ({ page }) => {
    const rec = await recordSent(page)
    await agent.open(page)
    await atPrompt(page)
    await cd(page, proj)

    // (16) The tab bar's files button, left of the paperclip, like ⚙
    const g = await page.evaluate(() => {
      const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect().toJSON() as DOMRect
      return { files: r('[data-testid=open-files] svg'), upload: r('[data-testid=upload-file]'), filesBtn: r('[data-testid=open-files]'), gear: r('[data-testid=open-settings] svg') }
    })
    expect(g.filesBtn.right).toBeLessThanOrEqual(g.upload.left + 0.5)
    expect(g.files.width).toBeCloseTo(g.gear.width, 1)
    expect(Math.abs(g.files.top + g.files.height / 2 - (g.gear.top + g.gear.height / 2))).toBeLessThanOrEqual(0.5)
    await openFiles(page)
    const box = (await page.getByTestId('files-sheet').boundingBox())!
    expect(Math.abs(box.width - 720)).toBeLessThanOrEqual(1)
    expect(Math.abs(box.x + box.width / 2 - 720)).toBeLessThanOrEqual(1)
    await waitRow(page, 'b.txt')
    await row(page, 'b.txt').click({ button: 'right' })
    await expect(item(page, 'b.txt')).toHaveAttribute('data-open', 'true')
    await row(page, 'a 1.txt').click() // a click elsewhere only closes it
    await expect(item(page, 'b.txt')).toHaveAttribute('data-open', 'false')
    await expect(page.getByTestId('file-sheet')).toHaveCount(0)
    await openFile(page, 'b.txt')
    const download = page.waitForEvent('download')
    await page.getByTestId('file-download').click()
    const d = await download
    expect(d.suggestedFilename()).toBe('b.txt')
    expect(readFileSync((await d.path())!, 'utf8')).toBe('hello')
    await closeSheet(page, 'file-sheet')

    // (17) Files dropped on the sheet go into the folder, not to the session
    await rec.clear()
    await page.getByTestId('files-sheet').evaluate((el) => {
      const dt = new DataTransfer()
      dt.items.add(new File(['dropped'], 'dropped.txt', { type: 'text/plain' }))
      el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    })
    await waitRow(page, 'dropped.txt')
    expect(readFileSync(join(proj, 'dropped.txt'), 'utf8')).toBe('dropped')
    // The backdrop beside the dialog too: the browser is modal, so the folder gets it, not the session
    await page.getByTestId('files-backdrop').evaluate((el) => {
      const dt = new DataTransfer()
      dt.items.add(new File(['again'], 'dropped.txt', { type: 'text/plain' }))
      el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    })
    await waitRow(page, 'dropped-1.txt')
    await expect(page.getByTestId('files-sheet')).toBeVisible()
    expect(await rec.input()).toEqual([])
  })
})

// ---------- E2E-54 maximize and Markdown (ADR-0060) ----------

/** doc.md and notes/other.md; written per test so E2E-53's listing stays as it was. */
function writeDocs() {
  const filler = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} keeps the heading below the fold.`).join('\n\n')
  writeFileSync(
    join(proj, 'doc.md'),
    [
      '# Plan',
      '[next](#next-steps) · [other](notes/other.md) · [up](src) · [js](javascript:alert(1)) · [web](https://example.com/)',
      '![shot](shot.png) ![remote](https://example.com/x.png)',
      '<script>window.__md=1</script>',
      '<img src=x onerror="window.__md=2">',
      '| a | b |\n|---|---|\n| 1 | 2 |',
      '```\ncode\n```',
      '- one\n- two',
      filler,
      '## Next Steps',
      'done',
    ].join('\n\n'),
  )
  mkdirSync(join(proj, 'notes'), { recursive: true })
  writeFileSync(join(proj, 'notes', 'other.md'), '# Other\n')
}

const sheetRect = (page: Page, testid: string) => page.getByTestId(testid).evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect)

test.describe('desktop markdown', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('E2E-54 (1) maximize and restore, remembered', async ({ page }) => {
    writeDocs()
    await agent.open(page)
    await atPrompt(page)
    await cd(page, proj)
    const resizes = await hooks.resizes(page)

    await openFiles(page)
    const max = page.getByTestId('files-sheet').getByTestId('files-max')
    await expect(max).toHaveAttribute('aria-pressed', 'false')
    await max.click()
    await expect(max).toHaveAttribute('aria-pressed', 'true')
    let r = await sheetRect(page, 'files-sheet')
    expect([r.x, r.y, r.width, r.height].map(Math.round)).toEqual([0, 0, 1440, 900])
    await waitRow(page, 'b.txt')
    await openFile(page, 'b.txt')
    r = await sheetRect(page, 'file-sheet')
    expect([r.x, r.y, r.width, r.height].map(Math.round)).toEqual([0, 0, 1440, 900])

    // Double-click the header (not a button): both restore, and again both maximize
    await page.getByTestId('file-sheet').locator('.drawer-title').dblclick()
    await expect(page.getByTestId('file-sheet').getByTestId('files-max')).toHaveAttribute('aria-pressed', 'false')
    expect(Math.round((await sheetRect(page, 'file-sheet')).width)).toBe(720)
    expect(Math.round((await sheetRect(page, 'files-sheet')).width)).toBe(720)
    await page.getByTestId('file-sheet').locator('.drawer-title').dblclick()
    expect(Math.round((await sheetRect(page, 'files-sheet')).width)).toBe(1440)
    expect(await hooks.resizes(page), 'no resize').toBe(resizes)

    // Remembered across closing and a reload
    await closeSheet(page, 'file-sheet')
    await closeSheet(page, 'files-sheet')
    await page.reload()
    await atPrompt(page)
    await openFiles(page)
    await expect(page.getByTestId('files-sheet').getByTestId('files-max')).toHaveAttribute('aria-pressed', 'true')
    expect(Math.round((await sheetRect(page, 'files-sheet')).width)).toBe(1440)
    await page.getByTestId('files-sheet').getByTestId('files-max').click()
    expect(Math.round((await sheetRect(page, 'files-sheet')).width)).toBe(720)
  })

  test('E2E-54 (3)-(5) Markdown rendered: escaping, links, images, Source', async ({ page }) => {
    writeDocs()
    const external: string[] = []
    page.on('request', (req) => {
      if (req.url().includes('example.com')) external.push(req.url())
    })
    await page.context().route('https://example.com/**', (route) => route.fulfill({ body: 'ok', contentType: 'text/plain' }))
    await agent.open(page)
    await atPrompt(page)
    await cd(page, proj)
    await openFiles(page)
    await waitRow(page, 'doc.md')

    // (3) Rendered, nothing from the file runs, nothing external loads
    await openFile(page, 'doc.md')
    const md = page.getByTestId('file-markdown')
    await expect(md.locator('h2#md-next-steps')).toHaveText('Next Steps')
    await expect(md.locator('table td').first()).toHaveText('1')
    await expect(md.locator('pre')).toHaveText('code')
    await expect(md).toContainText('<script>window.__md=1</script>')
    expect(await md.locator('script, iframe, img[onerror]').count()).toBe(0)
    expect(await page.evaluate(() => (window as unknown as { __md?: number }).__md)).toBeUndefined()
    expect(await md.locator('a', { hasText: /^js$/ }).count(), 'javascript: stays text').toBe(0)
    const shot = md.locator('img[alt=shot]')
    await expect(shot).toHaveAttribute('src', /^\/api\/fs\/raw\?path=/)
    await waitFor(() => shot.evaluate((img) => (img as HTMLImageElement).naturalWidth > 0), 'the relative image loaded')
    await expect(md.locator('a', { hasText: 'remote' })).toHaveAttribute('href', 'https://example.com/x.png')
    expect(await md.locator('img').count()).toBe(1)
    expect(external, 'nothing external requested').toEqual([])

    // (4) Links: the anchor scrolls, the web link opens a tab, relative links open in the browser
    await md.getByRole('link', { name: 'next' }).click()
    await waitFor(async () => {
      const [h, body, meta] = await Promise.all([
        md.locator('h2#md-next-steps').boundingBox(),
        page.getByTestId('file-sheet').locator('.drawer-body').boundingBox(),
        page.getByTestId('file-meta').boundingBox(),
      ])
      // Below the size line that stays at the top (ADR-0061 §2)
      return !!h && !!body && !!meta && h.y >= meta.y + meta.height - 1 && h.y < body.y + body.height
    }, 'the heading scrolled into view below the size line')
    const popup = page.waitForEvent('popup')
    await md.getByRole('link', { name: 'web' }).click()
    const tab = await popup
    await tab.waitForLoadState()
    expect(tab.url()).toBe('https://example.com/')
    await tab.close()
    await expect(page.getByTestId('file-sheet')).toBeVisible()
    await md.getByRole('link', { name: 'other' }).click()
    await expect(page.getByTestId('file-sheet').locator('.drawer-title')).toHaveText('other.md')
    await expect(page.getByTestId('file-markdown').locator('h1')).toHaveText('Other')
    await closeSheet(page, 'file-sheet')
    await openFile(page, 'doc.md')
    await page.getByTestId('file-markdown').getByRole('link', { name: 'up' }).click()
    await expect(page.getByTestId('file-sheet')).toHaveCount(0)
    await expect(lastCrumb(page)).toHaveText('src')

    // (5) Source and back
    await page.getByTestId('files-up').click()
    await waitRow(page, 'doc.md')
    await openFile(page, 'doc.md')
    const source = page.getByTestId('file-source')
    await expect(source).toHaveAttribute('aria-label', 'Source')
    await expect(source).toHaveAttribute('aria-pressed', 'false')
    const [sb, lb] = await Promise.all([source.boundingBox(), page.getByTestId('md-larger').boundingBox()])
    expect([sb!.width, sb!.height], 'square, the size of the A buttons (ADR-0066 §2)').toEqual([lb!.width, lb!.height])
    await source.click()
    await expect(page.getByTestId('file-text')).toContainText('## Next Steps')
    await expect(source).toHaveAttribute('aria-pressed', 'true')
    await source.click()
    await expect(page.getByTestId('file-markdown').locator('h2#md-next-steps')).toBeVisible()
    await expect(source).toHaveAttribute('aria-pressed', 'false')
  })
})

test.describe('phone markdown', () => {
  test.use(PIXEL)

  test('E2E-57 full height on a phone: the body scrolls, the handle and header pull, the button, remembered, one long pull closes', async ({ page }) => {
    writeDocs()
    await agent.open(page)
    await atPrompt(page)
    await page.evaluate(() => (document.querySelector('.app') as HTMLElement).style.setProperty('--sa-top', '20px'))
    await cd(page, proj)
    await page.waitForTimeout(300)
    let resizes = await hooks.resizes(page)
    await openFiles(page)
    await waitRow(page, 'doc.md')
    await openFile(page, 'doc.md')
    await expect(page.getByTestId('file-markdown').locator('h2#md-next-steps')).toHaveCount(1)
    const sheet = page.getByTestId('file-sheet')
    const max = sheet.getByTestId('files-max')
    const visible = await page.getByTestId('file-backdrop').evaluate((el) => el.clientHeight)
    const rest = visible * 0.8
    const height = (id: string) => page.getByTestId(id).evaluate((el) => el.getBoundingClientRect().height)
    const heightIs = (id: string, want: number) => waitFor(async () => Math.abs((await height(id)) - want) <= 1, `${id} is ${want}px tall`)
    const scrollTop = () => sheet.evaluate((s) => s.querySelector('.drawer-body')!.scrollTop)
    const center = async (loc: Locator) => {
      const b = (await loc.boundingBox())!
      return { x: b.x + Math.min(b.width / 2, 40), y: b.y + b.height / 2 }
    }
    const pull = async (loc: Locator, dy: number) => {
      const from = await center(loc)
      await touchDrag(page, from, { x: from.x, y: from.y + dy })
    }
    await expect(max).toHaveAttribute('aria-pressed', 'false')
    await heightIs('file-sheet', rest)

    // (1) Up on the body scrolls it and leaves the height alone
    const body = sheet.locator('.drawer-body')
    const bb = (await body.boundingBox())!
    await touchDrag(page, { x: bb.x + bb.width / 2, y: bb.y + bb.height * 0.7 }, { x: bb.x + bb.width / 2, y: bb.y + bb.height * 0.7 - 200 })
    await waitFor(async () => (await scrollTop()) > 0, 'the body scrolled')
    await page.waitForTimeout(250)
    await heightIs('file-sheet', rest)
    await expect(max).toHaveAttribute('aria-pressed', 'false')

    // (2) A short pull on the handle settles back; a longer one on the header goes full height
    await pull(sheet.locator('.drawer-grab'), -30)
    await page.waitForTimeout(250)
    await heightIs('file-sheet', rest)
    await expect(max).toHaveAttribute('aria-pressed', 'false')
    await pull(sheet.locator('.drawer-title'), -120)
    await expect(max).toHaveAttribute('aria-pressed', 'true')
    await heightIs('file-sheet', visible)
    const look = await sheet.evaluate((el) => {
      const s = getComputedStyle(el)
      return { radius: s.borderTopLeftRadius, pad: s.paddingTop, top: Math.round(el.getBoundingClientRect().top) }
    })
    expect(look).toEqual({ radius: '0px', pad: '20px', top: 0 })
    await heightIs('files-sheet', visible)

    // (3) Down from the header with the body scrolled → 80%; the button both ways
    expect(await scrollTop()).toBeGreaterThan(0)
    await pull(sheet.locator('.drawer-title'), 100)
    await expect(max).toHaveAttribute('aria-pressed', 'false')
    await heightIs('file-sheet', rest)
    await max.tap()
    await expect(max).toHaveAttribute('aria-pressed', 'true')
    await heightIs('file-sheet', visible)
    await max.tap()
    await expect(max).toHaveAttribute('aria-pressed', 'false')
    await heightIs('file-sheet', rest)
    expect(await hooks.resizes(page), 'no resize').toBe(resizes)

    // (4) Remembered
    await max.tap()
    await expect(max).toHaveAttribute('aria-pressed', 'true')
    await closeSheet(page, 'file-sheet')
    await closeSheet(page, 'files-sheet')
    await page.reload()
    await atPrompt(page)
    await page.waitForTimeout(300)
    resizes = await hooks.resizes(page)
    await openFiles(page)
    const visible2 = await page.getByTestId('files-backdrop').evaluate((el) => el.clientHeight)
    await heightIs('files-sheet', visible2)
    await expect(page.getByTestId('files-sheet').getByTestId('files-max')).toHaveAttribute('aria-pressed', 'true')

    // (5) One long pull from full height closes
    await pull(page.getByTestId('files-sheet').locator('.drawer-head'), visible2 * 0.2 + 140)
    await expect(page.getByTestId('files-sheet')).toHaveCount(0)
    expect(await hooks.resizes(page), 'no resize').toBe(resizes)
  })

  test('E2E-55 (4) text size on a phone', async ({ page }) => {
    writeDocs()
    await agent.open(page)
    await atPrompt(page)
    await cd(page, proj)
    await openFiles(page)
    await waitRow(page, 'doc.md')
    await openFile(page, 'doc.md')
    const md = page.getByTestId('file-markdown')
    await expect(md.locator('h2#md-next-steps')).toHaveCount(1)
    const [meta, sheet, source] = await Promise.all([
      page.getByTestId('file-meta').boundingBox(),
      page.getByTestId('file-sheet').boundingBox(),
      page.getByTestId('file-source').boundingBox(),
    ])
    expect(meta!.height, 'one line').toBeLessThanOrEqual(48)
    expect(source!.x + source!.width).toBeLessThanOrEqual(sheet!.x + sheet!.width)
    expect(await fontPx(md)).toBe(15)
    await page.getByTestId('md-larger').tap()
    await waitFor(async () => (await fontPx(md)) === 17, '17px')
  })
})

// ---------- E2E-55 Markdown text size (ADR-0061) ----------

const fontPx = (loc: Locator) => loc.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))

/** Where the sheet body and the size line are, and how far "Paragraph 30" starts below the line. */
const layout = (page: Page) =>
  page.getByTestId('file-sheet').evaluate((sheet) => {
    const body = sheet.querySelector('.drawer-body')!.getBoundingClientRect()
    const meta = sheet.querySelector('[data-testid=file-meta]')!.getBoundingClientRect()
    const p = [...sheet.querySelectorAll('.file-markdown p')].find((e) => e.textContent!.startsWith('Paragraph 30 '))
    return { bodyTop: body.top, metaTop: meta.top, offset: p ? p.getBoundingClientRect().top - meta.bottom : NaN }
  })

const scrollToEnd = (page: Page) =>
  page.getByTestId('file-sheet').evaluate((sheet) => {
    const body = sheet.querySelector<HTMLElement>('.drawer-body')!
    body.scrollTop = body.scrollHeight
  })

test.describe('desktop markdown text size', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('E2E-55 (1)-(3) steps, the place you read, remembered, only rendered Markdown', async ({ page }) => {
    writeDocs()
    writeFileSync(join(proj, 'long.txt'), Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n'))
    await agent.open(page)
    await atPrompt(page)
    await cd(page, proj)
    await openFiles(page)
    await waitRow(page, 'doc.md')

    // (1) Steps; the paragraph at the size line stays there
    await openFile(page, 'doc.md')
    const md = page.getByTestId('file-markdown')
    await expect(md.locator('h2#md-next-steps')).toHaveCount(1)
    expect(await fontPx(md)).toBe(15)
    const xs = await Promise.all(['md-smaller', 'md-larger', 'file-source'].map(async (id) => (await page.getByTestId(id).boundingBox())!.x))
    expect([...xs].sort((a, b) => a - b), 'smaller, larger, Source').toEqual(xs)
    const larger = page.getByTestId('md-larger')
    await larger.click()
    await waitFor(async () => (await fontPx(md)) === 17, '17px')
    await page.getByTestId('file-sheet').evaluate((sheet) => {
      const body = sheet.querySelector<HTMLElement>('.drawer-body')!
      const meta = sheet.querySelector('[data-testid=file-meta]')!
      const p = [...sheet.querySelectorAll('.file-markdown p')].find((e) => e.textContent!.startsWith('Paragraph 30 '))!
      // Twice: the first scroll is what makes the size line stick
      for (let i = 0; i < 2; i++) body.scrollTop += p.getBoundingClientRect().top - meta.getBoundingClientRect().bottom - 10
    })
    expect(Math.round((await layout(page)).offset)).toBe(10)
    await larger.click()
    await waitFor(async () => (await fontPx(md)) === 19, '19px')
    const at = await layout(page)
    expect(Math.abs(at.offset - 10), `Paragraph 30 stays at the size line (${at.offset})`).toBeLessThanOrEqual(4)
    expect(Math.round(at.metaTop), 'the size line is at the top').toBe(Math.round(at.bodyTop))
    expect(Math.abs((await fontPx(md.locator('pre code'))) - 0.84 * 19)).toBeLessThanOrEqual(0.5)
    await larger.click()
    await larger.click()
    await waitFor(async () => (await fontPx(md)) === 24, '24px')
    await expect(larger).toBeDisabled()

    // (2) Remembered across a reload and for every Markdown file
    await closeSheet(page, 'file-sheet')
    await closeSheet(page, 'files-sheet')
    await page.reload()
    await atPrompt(page)
    await openFiles(page)
    await waitRow(page, 'doc.md')
    await openFile(page, 'doc.md')
    await expect(page.getByTestId('file-markdown').locator('h2#md-next-steps')).toHaveCount(1)
    expect(await fontPx(page.getByTestId('file-markdown'))).toBe(24)
    const smaller = page.getByTestId('md-smaller')
    for (let i = 0; i < 7; i++) await smaller.click()
    await waitFor(async () => (await fontPx(page.getByTestId('file-markdown'))) === 12, '12px')
    await expect(smaller).toBeDisabled()
    await page.getByTestId('file-markdown').getByRole('link', { name: 'other' }).click()
    await expect(page.getByTestId('file-markdown').locator('h1')).toHaveText('Other')
    expect(await fontPx(page.getByTestId('file-markdown'))).toBe(12)

    // (3) Only rendered Markdown; the size line stays at the top of text too
    await closeSheet(page, 'file-sheet')
    await waitRow(page, 'doc.md')
    await openFile(page, 'doc.md')
    await page.getByTestId('file-source').click()
    await expect(page.getByTestId('file-text')).toContainText('## Next Steps')
    await expect(page.getByTestId('md-smaller')).toHaveCount(0)
    await expect(page.getByTestId('md-larger')).toHaveCount(0)
    await scrollToEnd(page)
    let l = await layout(page)
    expect(Math.round(l.metaTop), 'Source: the size line is at the top').toBe(Math.round(l.bodyTop))
    await closeSheet(page, 'file-sheet')
    await waitRow(page, 'long.txt')
    await openFile(page, 'long.txt')
    await expect(page.getByTestId('file-text')).toContainText('line 299')
    await expect(page.getByTestId('md-larger')).toHaveCount(0)
    await scrollToEnd(page)
    l = await layout(page)
    expect(Math.round(l.metaTop), 'text: the size line is at the top').toBe(Math.round(l.bodyTop))
  })
})
