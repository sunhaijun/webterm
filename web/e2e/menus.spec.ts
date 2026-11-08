/**
 * E2E-51 History and the command strip (AC-3.24, AC-3.25, ADR-0057).
 *
 * Pixel 5. The agent runs with a temporary HOME holding .bash_history,
 * .claude/history.jsonl and .claude/commands/hello.md; a script named `claude` stands in for
 * the real one: run with -p it prints an init line, otherwise it echoes FAKE-CLAUDE and
 * sleeps. INPUT frames are recorded.
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
  writeFileSync(join(home, '.bash_history'), '#1700000000\ngit status\nls\ngit status\nmake test\ngit status\nmake test\n')
  mkdirSync(join(home, '.claude', 'commands'), { recursive: true })
  const claude = ['/clear', 'first line\nsecond line', '/clear', '[Pasted text #1 +20 lines] explain', '继续']
  writeFileSync(join(home, '.claude', 'history.jsonl'), claude.map((d) => JSON.stringify({ display: d })).join('\n') + '\n')
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

test('E2E-51 history for the shell and claude; the command strip, its editor, sharing and reset; closing', async ({ page }) => {
  test.setTimeout(120_000)
  const rec = await recordSent(page)
  await agent.open(page)
  const a = (await hooks.sid(page))!
  await waitFor(async () => (await hooks.program(page)) === 'shell', 'program is shell')

  // (1) Shell: no ⌘, its cell kept; history newest first, each entry once
  await expect(page.getByTestId('key-commands')).toHaveCount(0)
  const blank = (await page.getByTestId('commands-blank').boundingBox())!
  const hist = (await page.getByTestId('key-history').boundingBox())!
  expect(Math.abs(blank.x - hist.x), 'the empty cell sits under ⟲').toBeLessThanOrEqual(1)
  expect(Math.abs(blank.width - hist.width)).toBeLessThanOrEqual(1)
  await page.getByTestId('key-history').click()
  await expect(page.getByTestId('history-menu')).toBeVisible()
  await expect(page.getByTestId('history-0')).toHaveText('make test')
  await expect(page.getByTestId('history-1')).toHaveText('git status')
  await expect(page.getByTestId('history-2')).toHaveText('ls')
  await expect(page.getByTestId('history-3'), '#<digits> is a timestamp; duplicates appear once').toHaveCount(0)
  let n = (await rec.input()).length
  await page.getByTestId('history-1').click()
  await expect(page.getByTestId('history-menu')).toHaveCount(0)
  let sent = await framesAfter(rec, n)
  expect(sent.length, `frames: ${JSON.stringify(sent)}`).toBe(2)
  expect(sent[0]).toContain('git status')
  expect(sent[1], 'Enter in its own frame').toBe('\r')
  await waitText(page, /On branch|not a git repository/, 'git status ran')
  n = (await rec.input()).length
  await page.getByTestId('key-history').click()
  await page.getByTestId('history-insert-0').click()
  sent = await framesAfter(rec, n)
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('make test')
  await focusTerm(page)
  await page.keyboard.press('Control+u')

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

  // (3) The editor: drag, hide, rename, add
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

  // (4) Kept by the agent: a reload shows the same; Reset takes a second tap
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

  // (5) History in claude: newest first, a multi-line entry kept, the placeholder dropped
  await page.getByTestId('key-history').click()
  await expect(page.getByTestId('history-0')).toHaveText('继续')
  await expect(page.getByTestId('history-1')).toHaveText('/clear')
  await expect(page.getByTestId('history-2').locator('.km-text')).toHaveText('first line')
  await expect(page.getByTestId('history-2').locator('.km-lines')).toHaveText('2 lines')
  await expect(page.getByTestId('history-3'), "claude's paste placeholder is dropped").toHaveCount(0)
  n = (await rec.input()).length
  await page.getByTestId('history-2').click()
  sent = await framesAfter(rec, n)
  expect(sent.length, `frames: ${JSON.stringify(sent)}`).toBe(2)
  expect(sent[0], 'both lines in one paste').toMatch(/first line[\r\n]+second line/)
  expect(sent[1]).toBe('\r')

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
