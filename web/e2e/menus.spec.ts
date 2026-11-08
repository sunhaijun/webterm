/**
 * E2E-51 The last column and the command strip (AC-3.24, AC-3.25, ADR-0057, ADR-0058).
 *
 * Pixel 5. The agent runs with a temporary HOME holding .claude/commands/hello.md; a script
 * named `claude` stands in for the real one: run with -p it prints an init line, otherwise
 * it echoes FAKE-CLAUDE and sleeps. INPUT frames are recorded.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, focusTerm, hooks, newSession, recordSent, settled, submit, switchTo, waitFor, waitOnline, waitText, type SentRecorder } from './harness'

const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
test.use(PIXEL)

const INIT = JSON.stringify({
  type: 'system',
  subtype: 'init',
  slash_commands: ['clear', 'compact', 'model', '__internal', 'deep-research'],
  skills: ['deep-research'],
})

let agent: Agent
let home: string
test.beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'webterm-home-'))
  mkdirSync(join(home, '.claude', 'commands'), { recursive: true })
  writeFileSync(join(home, '.claude', 'commands', 'hello.md'), 'Say hello.\n')
  mkdirSync(join(home, 'bin'))
  // No exec: bash running the script stays the group leader, argv[1] = .../claude
  writeFileSync(join(home, 'bin', 'claude'), `#!/bin/bash\nif [ "$1" = -p ]; then echo '${INIT}'; sleep 30; exit; fi\necho FAKE-CLAUDE\nsleep 120\n`, { mode: 0o755 })
  agent = await Agent.start({ home })
})
test.afterEach(() => agent.stop())

/** framesAfter returns the INPUT frames sent since index `from`, after a short settle. */
async function framesAfter(rec: SentRecorder, from: number): Promise<string[]> {
  await new Promise((r) => setTimeout(r, 400))
  return (await rec.input()).slice(from)
}

const focused = (p: Page) => p.evaluate(() => document.activeElement?.className ?? '')

/** The strip's chips (their ids), in order. */
const chips = (p: Page) =>
  p.evaluate(() => [...document.querySelectorAll('[data-testid=command-strip] .cs-chip')].map((e) => (e as HTMLElement).dataset.testid!.slice('command-'.length)))

/** The editor's rows (their ids), in order. */
const rows = (p: Page) => p.evaluate(() => [...document.querySelectorAll('[data-testid=command-editor] .ce-row')].map((e) => (e as HTMLElement).dataset.id!))

const chip = (p: Page, id: string) => p.locator(`[data-testid="command-${id}"]`)
const row = (p: Page, id: string) => p.locator(`[data-testid=command-editor] .ce-row[data-id="${id}"]`)

async function openStrip(page: Page) {
  await page.getByTestId('key-commands').click()
  await expect(page.getByTestId('command-strip')).toBeVisible()
  await expect(page.locator('[data-testid=command-strip] .cs-chip').first()).toBeVisible()
}

async function openEditor(page: Page) {
  await openStrip(page)
  await page.getByTestId('command-edit').click()
  await expect(page.getByTestId('command-editor')).toBeVisible()
  await settled(page, 'command-editor')
  await expect(page.locator('[data-testid=command-editor] .ce-row').first()).toBeVisible()
}

async function touchDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 12) {
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

test('E2E-51 ↵ and the empty ⌘ cell at a shell; the two-row command strip, its editor, sharing and reset; closing', async ({ page }) => {
  test.setTimeout(120_000)
  const rec = await recordSent(page)
  await agent.open(page)
  const a = (await hooks.sid(page))!
  await waitFor(async () => (await hooks.program(page)) === 'shell', 'program is shell')

  // (1) Shell: no ⌘, its cell kept above ↵; ↵ sends CR without moving focus; ALT ↵ is ESC CR
  await expect(page.getByTestId('key-commands')).toHaveCount(0)
  await expect(page.getByTestId('key-history')).toHaveCount(0)
  const blank = (await page.getByTestId('commands-blank').boundingBox())!
  const enter = (await page.getByTestId('key-Enter').boundingBox())!
  expect(Math.abs(blank.x - enter.x), 'the empty cell sits above ↵').toBeLessThanOrEqual(1)
  expect(Math.abs(blank.width - enter.width)).toBeLessThanOrEqual(1)
  expect(blank.y + blank.height).toBeLessThanOrEqual(enter.y + 1)
  const icon = (await page.locator('[data-testid=key-Enter] svg').boundingBox())!
  expect(Math.abs(icon.x + icon.width / 2 - (enter.x + enter.width / 2)), 'the ↵ icon is centered').toBeLessThanOrEqual(1)
  await focusTerm(page)
  const focusBefore = await focused(page)
  let n = (await rec.input()).length
  await page.getByTestId('key-Enter').click()
  expect(await framesAfter(rec, n)).toEqual(['\r'])
  expect(await focused(page), 'focus stays').toBe(focusBefore)
  n = (await rec.input()).length
  await page.getByTestId('key-Alt').click()
  await page.getByTestId('key-Enter').click()
  expect(await framesAfter(rec, n)).toEqual(['\x1b\r'])
  await expect(page.getByTestId('key-Alt')).toHaveAttribute('data-sticky', 'off')

  // (2) claude in front: ⌘ appears; the strip comes from the tool
  await submit(page, `${home}/bin/claude`)
  await waitText(page, 'FAKE-CLAUDE')
  await waitFor(async () => (await hooks.program(page)) === 'claude', 'program is claude', 5_000)
  await expect(page.getByTestId('key-commands')).toBeVisible({ timeout: 2_000 })
  await openStrip(page)
  let ids = await chips(page)
  expect(ids.indexOf('key:shift-tab'), `chips: ${ids}`).toBe(0)
  expect(ids.indexOf('key:shift-tab')).toBeLessThan(ids.indexOf('/compact'))
  for (const id of ['/clear', '/compact', '/model', '/copy', '/resume', '/hello']) expect(ids, id).toContain(id)
  expect(ids).not.toContain('/__internal')
  expect(ids, 'a skill starts hidden').not.toContain('/deep-research')
  n = (await rec.input()).length
  await chip(page, '/compact').click()
  await expect(page.getByTestId('command-strip')).toHaveCount(0)
  expect(await framesAfter(rec, n)).toEqual(['/compact', '\r'])
  await openStrip(page)
  n = (await rec.input()).length
  await chip(page, 'key:shift-tab').click()
  expect(await framesAfter(rec, n)).toEqual(['\x1b[Z'])

  // (3) Two rows, filled column by column; it scrolls sideways; ✎ spans both rows
  await openStrip(page)
  const box = async (i: number) => (await page.locator('[data-testid=command-strip] .cs-chip').nth(i).boundingBox())!
  const [c0, c1, c2, c3] = [await box(0), await box(1), await box(2), await box(3)]
  expect(Math.abs(c1.x - c0.x), 'chip 2 under chip 1').toBeLessThanOrEqual(1)
  expect(c1.y).toBeGreaterThanOrEqual(c0.y + c0.height - 1)
  expect(Math.abs(c1.width - c0.width), 'both stretch to the column').toBeLessThanOrEqual(1)
  expect(Math.abs(c2.y - c0.y), 'chip 3 on the top row').toBeLessThanOrEqual(1)
  expect(c2.x).toBeGreaterThanOrEqual(c0.x + c0.width - 1)
  expect(Math.abs(c3.x - c2.x), 'chip 4 under chip 3').toBeLessThanOrEqual(1)
  expect(Math.abs(c3.y - c1.y)).toBeLessThanOrEqual(1)
  expect(await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.cs-scroll')!
    return el.scrollWidth > el.clientWidth
  }), 'scrolls sideways').toBe(true)
  const edit = (await page.getByTestId('command-edit').boundingBox())!
  expect(edit.height, '✎ as tall as both rows').toBeGreaterThanOrEqual(c1.y + c1.height - c0.y)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('command-strip')).toHaveCount(0)

  // (4) The editor: drag, hide, rename, add
  await openEditor(page)
  expect(await rows(page)).toContain('/deep-research')
  await expect(row(page, '/deep-research').locator('xpath=..')).toHaveAttribute('data-hidden', 'true')
  await row(page, '/compact').scrollIntoViewIfNeeded()
  const before = await rows(page)
  const gi = before.indexOf('/compact')
  expect(before[gi - 1]).toBe('/clear')
  const g = (await page.getByTestId(`command-grip-${gi}`).boundingBox())!
  const clear = (await row(page, '/clear').boundingBox())!
  await touchDrag(page, { x: g.x + g.width / 2, y: g.y + g.height / 2 }, { x: g.x + g.width / 2, y: clear.y + 4 })
  await expect.poll(async () => {
    const r = await rows(page)
    return r.indexOf('/compact') < r.indexOf('/clear')
  }, 'dragged above /clear').toBe(true)
  await page.getByTestId(`command-eye-${(await rows(page)).indexOf('key:shift-tab')}`).click()
  await expect(row(page, 'key:shift-tab').locator('xpath=..')).toHaveAttribute('data-hidden', 'true')
  await row(page, '/compact').click()
  await expect(page.getByTestId('command-form')).toBeVisible()
  await page.getByTestId('command-form-label').fill('压缩')
  await page.getByTestId('command-form-save').click()
  await expect(page.getByTestId('command-form')).toHaveCount(0)
  await expect(row(page, '/compact').locator('.ce-label')).toHaveText('压缩')
  await page.getByTestId('command-add').click()
  await expect(page.getByTestId('command-form')).toBeVisible()
  await page.getByTestId('command-form-send').fill('继续')
  await page.getByTestId('command-form-save').click()
  await expect.poll(async () => (await rows(page)).at(-1)?.startsWith('add:'), 'added at the end').toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('command-editor')).toHaveCount(0)

  const arranged = async () => {
    await openStrip(page)
    const ids = await chips(page)
    expect(ids.indexOf('/compact'), `chips: ${ids}`).toBeLessThan(ids.indexOf('/clear'))
    expect(ids, 'hidden').not.toContain('key:shift-tab')
    await expect(chip(page, '/compact')).toHaveText('压缩')
    const last = ids.at(-1)!
    expect(last.startsWith('add:')).toBe(true)
    await expect(chip(page, last)).toHaveText('继续')
    return last
  }
  const added = await arranged()
  n = (await rec.input()).length
  await chip(page, added).click()
  expect(await framesAfter(rec, n)).toEqual(['继续', '\r'])

  // (5) Kept by the agent: a reload shows the same; Reset takes a second tap
  await page.reload()
  await waitOnline(page)
  await waitFor(async () => (await hooks.program(page)) === 'claude', 'program is claude after reload', 10_000)
  await arranged()
  await page.getByTestId('command-edit').click()
  await expect(page.getByTestId('command-editor')).toBeVisible()
  await settled(page, 'command-editor')
  await page.getByTestId('command-reset').click()
  await expect(page.getByTestId('command-reset')).toHaveAttribute('data-armed', 'true')
  await page.waitForTimeout(300)
  expect((await rows(page)).at(-1)?.startsWith('add:'), 'one tap changes nothing').toBe(true)
  await page.getByTestId('command-reset').click()
  await expect.poll(async () => {
    const r = await rows(page)
    return r[0] === 'key:shift-tab' && !r.some((id) => id.startsWith('add:')) && r.indexOf('/clear') < r.indexOf('/compact')
  }, 'defaults back').toBe(true)
  await expect(row(page, '/compact').locator('.ce-label')).toHaveText('/compact')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('command-editor')).toHaveCount(0)

  // (6) Closing: Esc goes to the strip, not the program; switching sessions closes it
  await openStrip(page)
  n = (await rec.input()).length
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('command-strip')).toHaveCount(0)
  expect(await framesAfter(rec, n), 'Esc did not reach the PTY').toEqual([])
  const b = await newSession(page)
  await switchTo(page, a)
  await waitFor(async () => (await hooks.program(page)) === 'claude', 'back on claude')
  await openStrip(page)
  await page.keyboard.press('Control+Shift+ArrowDown')
  await waitFor(async () => (await hooks.sid(page)) === b, 'switched to B')
  await expect(page.getByTestId('command-strip')).toHaveCount(0)
  await expect(page.getByTestId('key-commands'), 'a shell again').toHaveCount(0)
})
