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

import { devices, expect, test, type Page } from '@playwright/test'

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
