/**
 * E2E-51 Frequent input and combo keys (AC-3.24, AC-3.25, ADR-0054).
 *
 * Pixel 5. The agent runs with a temporary HOME holding .bash_history and
 * .claude/history.jsonl; a script named `claude` stands in for the real one. INPUT frames are
 * recorded.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, hooks, newSession, recordSent, rectOf, submit, switchTo, waitFor, waitText, type SentRecorder } from './harness'

const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
test.use(PIXEL)

let agent: Agent
let home: string
test.beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'webterm-home-'))
  writeFileSync(join(home, '.bash_history'), '#1700000000\ngit status\nls\ngit status\nmake test\ngit status\nmake test\n')
  mkdirSync(join(home, '.claude'))
  const claude = ['/clear', '继续', '/clear', '[Pasted text #1 +20 lines] explain', '/clear', '继续']
  writeFileSync(join(home, '.claude', 'history.jsonl'), claude.map((d) => JSON.stringify({ display: d })).join('\n') + '\n')
  mkdirSync(join(home, 'bin'))
  // No exec: bash running the script stays the group leader, argv[1] = .../claude
  writeFileSync(join(home, 'bin', 'claude'), '#!/bin/bash\necho FAKE-CLAUDE\nsleep 120\n', { mode: 0o755 })
  agent = await Agent.start({ home })
})
test.afterEach(() => agent.stop())

/** framesAfter returns the INPUT frames sent since index `from`, after a short settle. */
async function framesAfter(rec: SentRecorder, from: number): Promise<string[]> {
  await new Promise((r) => setTimeout(r, 400))
  return (await rec.input()).slice(from)
}

const focused = (p: Page) => p.evaluate(() => document.activeElement?.className ?? '')

test('E2E-51 the last key column: geometry, combo keys and frequent input for the shell and for claude, closing', async ({ page }) => {
  const rec = await recordSent(page)
  await agent.open(page)
  const a = (await hooks.sid(page))!
  await waitFor(async () => (await hooks.program(page)) === 'shell', 'program is shell')

  // (1) Geometry
  const esc = (await rectOf(page, '[data-testid="key-Escape"]'))!
  const pgup = (await rectOf(page, '[data-testid="key-PageUp"]'))!
  const freq = (await rectOf(page, '[data-testid="key-frequent"]'))!
  const comb = (await rectOf(page, '[data-testid="key-combos"]'))!
  expect(Math.abs(freq.width - esc.width), 'same width as the other keys').toBeLessThanOrEqual(1)
  expect(Math.abs(freq.left - comb.left)).toBeLessThanOrEqual(1)
  expect(freq.bottom, 'frequent above combos').toBeLessThanOrEqual(comb.top + 1)
  expect(freq.left, 'after PGUP').toBeGreaterThanOrEqual(pgup.right - 1)
  expect(await page.evaluate(() => {
    const k = document.querySelector<HTMLElement>('.ek-keys')!
    return k.scrollWidth <= k.clientWidth
  }), 'no horizontal scroll').toBe(true)

  // (2) Combo keys at the shell
  let n = (await rec.input()).length
  const before = await focused(page)
  await page.getByTestId('key-combos').click()
  await expect(page.getByTestId('combo-menu')).toBeVisible()
  await expect(page.getByTestId('combo-ctrl-r')).toBeVisible()
  await page.getByTestId('combo-ctrl-c').click()
  await expect(page.getByTestId('combo-menu')).toHaveCount(0)
  expect(await framesAfter(rec, n)).toEqual(['\x03'])
  expect(await focused(page), 'focus did not move').toBe(before)

  // (3) Frequent input at the shell
  await page.getByTestId('key-frequent').click()
  await expect(page.getByTestId('frequent-menu')).toBeVisible()
  await expect(page.getByTestId('frequent-0')).toHaveText('git status')
  await expect(page.getByTestId('frequent-1')).toHaveText('make test')
  await expect(page.getByTestId('frequent-2'), 'ls is too short; #<digits> is a timestamp').toHaveCount(0)
  n = (await rec.input()).length
  await page.getByTestId('frequent-0').click()
  await expect(page.getByTestId('frequent-menu')).toHaveCount(0)
  let sent = await framesAfter(rec, n)
  expect(sent.length, `frames: ${JSON.stringify(sent)}`).toBe(2)
  expect(sent[0]).toContain('git status')
  expect(sent[1], 'Enter in its own frame').toBe('\r')
  await waitText(page, /On branch|not a git repository/, 'git status ran')

  // (4) ✎ inserts without Enter, then ^U clears the line
  n = (await rec.input()).length
  await page.getByTestId('key-frequent').click()
  await page.getByTestId('frequent-insert-1').click()
  sent = await framesAfter(rec, n)
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('make test')
  await page.getByTestId('key-combos').click()
  await page.getByTestId('combo-ctrl-u').click()

  // (5) claude in front
  await submit(page, `${home}/bin/claude`)
  await waitText(page, 'FAKE-CLAUDE')
  await waitFor(async () => (await hooks.program(page)) === 'claude', 'program is claude', 5_000)
  n = (await rec.input()).length
  await page.getByTestId('key-combos').click()
  await expect(page.getByTestId('combo-shift-tab')).toBeVisible()
  await page.getByTestId('combo-shift-tab').click()
  expect(await framesAfter(rec, n)).toEqual(['\x1b[Z'])
  n = (await rec.input()).length
  await page.getByTestId('key-combos').click()
  await page.getByTestId('combo-esc-esc').click()
  expect(await framesAfter(rec, n), 'two separate Esc writes').toEqual(['\x1b', '\x1b'])
  await page.getByTestId('key-frequent').click()
  await expect(page.getByTestId('frequent-0')).toHaveText('/clear')
  await expect(page.getByTestId('frequent-1')).toHaveText('继续')
  await expect(page.getByTestId('frequent-2'), "claude's paste placeholder is dropped").toHaveCount(0)

  // (6) Closing: Esc goes to the menu, not the program; switching sessions closes it
  n = (await rec.input()).length
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('frequent-menu')).toHaveCount(0)
  expect(await framesAfter(rec, n), 'Esc did not reach the PTY').toEqual([])
  const b = await newSession(page)
  await switchTo(page, a)
  await page.getByTestId('key-combos').click()
  await expect(page.getByTestId('combo-menu')).toBeVisible()
  await page.keyboard.press('Control+Shift+ArrowDown')
  await waitFor(async () => (await hooks.sid(page)) === b, 'switched to B')
  await expect(page.getByTestId('combo-menu')).toHaveCount(0)
})
