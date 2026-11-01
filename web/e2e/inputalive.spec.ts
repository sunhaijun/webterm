/**
 * E2E-34 Typed input must not vanish (AC-4.8 / AC-2.15 / AC-3.3 / AC-3.17, ADR-0020).
 *
 * Three independent causes with identical symptoms: keys do nothing, the screen does not change,
 * and nothing tells you why.
 *
 *   (1) After switching sessions focus falls back to body; keys land on body and onData never fires.
 *   (2) The replay gate applies per session, wholesale, so keys typed during the few hundred ms to
 *       few seconds of catch-up are dropped.
 *   (3) compositionend never arrives, `composing` sticks at true, and the session's input is dead
 *       until a reload.
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

import { Agent, focusTerm, framesSince, hooks, terminalText, waitFor, waitSnapshot, type InputStats } from './harness'

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

const sid = (page: Page) => hooks.sid(page)

/** focused reports which element has focus; printing it on failure is far more useful than "did not appear". */
const focused = (page: Page) =>
  page.evaluate(() => document.activeElement?.className ?? '(null)')

async function typeLine(page: Page, line: string): Promise<void> {
  await page.keyboard.type(line)
  await page.keyboard.press('Enter')
}

test('E2E-34 (1) after switching sessions, typing works without clicking the terminal (AC-4.8)', async ({ page }) => {
  await agent.open(page)

  await page.getByTestId('terminal').click({ position: { x: 60, y: 60 } })
  await typeLine(page, 'echo ONE')
  await waitFor(async () => (await terminalText(page)).includes('ONE'), 'ONE echoed')
  const sidA = await sid(page)

  // New session (Ctrl+Shift+Enter); activate() detaches A's host from the DOM.
  await page.keyboard.press('Control+Shift+Enter')
  await waitFor(async () => (await sid(page)) !== sidA, 'switched to the new session')

  // Type without clicking the terminal.
  await typeLine(page, 'echo TWO')
  await waitFor(
    async () => (await terminalText(page)).includes('TWO'),
    `typing in the new session without clicking: keys landed on ${await focused(page)}`,
  )

  // Switch back to A (Ctrl+Shift+Up), again without clicking.
  await page.keyboard.press('Control+Shift+ArrowUp')
  await waitFor(async () => (await sid(page)) === sidA, 'switched back to A')
  await typeLine(page, 'echo THREE')
  await waitFor(
    async () => (await terminalText(page)).includes('THREE'),
    `typing after switching back: keys landed on ${await focused(page)}`,
  )
})

test('E2E-34 (2) keys typed during the switch-back replay window are not lost (AC-2.15)', async ({ page }) => {
  await agent.open(page)

  await focusTerm(page)
  const sidA = await sid(page)

  // A produces ~1 MiB in the background. With the default 256 KiB ring, switch-back takes the
  // snapshot path (the replay gate is open for snapshots too). The 2s sleep leaves time to switch
  // to B so all output lands while unsubscribed.
  const dir = mkdtempSync(join(tmpdir(), 'webterm-e2e34-'))
  const done = join(dir, 'flooded')
  const pad = 'x'.repeat(60)
  await typeLine(
    page,
    `(sleep 2; for i in $(seq 1 15000); do printf 'pad %05d %s\\n' $i ${pad}; done; touch ${done}) &`,
  )

  await page.keyboard.press('Control+Shift+Enter')
  await waitFor(async () => (await sid(page)) !== sidA, 'switched to B')
  await waitFor(() => Promise.resolve(existsSync(done)), 'A overran the buffer in the background', 120_000)

  // Switch back to A and type immediately, without waiting for anything, so the keys land while the
  // snapshot is being parsed.
  const read = await framesSince(page)
  await page.keyboard.press('Control+Shift+ArrowUp')
  await typeLine(page, 'echo REPLAYKEY')

  await waitSnapshot(read, sidA!, 'this round did take the snapshot path')
  await waitFor(
    async () => (await terminalText(page)).includes('REPLAYKEY'),
    'keys typed in the replay window were swallowed; the command never ran',
    30_000,
  )
})

test('E2E-34 (3) a missing compositionend does not kill the terminal (AC-3.3)', async ({ page }) => {
  await agent.open(page)
  await page.getByTestId('terminal').click({ position: { x: 60, y: 60 } })

  /** startComposing begins a composition without ending it, which is how compositionend gets lost when switching IMEs or windows. */
  const startComposing = () =>
    page.evaluate(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!
      ta.focus()
      ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }))
      ta.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ni', bubbles: true }))
    })

  // No bytes go out during composition (the original AC-3.3 behavior; the fallbacks must not break
  // it). Real IMEs report isComposing / keyCode 229 while composing, so dispatch the same.
  await startComposing()
  await page.evaluate(() => {
    const ta = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!
    for (const ch of 'NOPE') {
      ta.dispatchEvent(
        new KeyboardEvent('keydown', { key: ch, keyCode: 229, isComposing: true, bubbles: true, cancelable: true }),
      )
    }
  })
  await page.waitForTimeout(300)
  expect(await terminalText(page), 'no bytes may reach the PTY during composition').not.toContain('NOPE')

  // Fallback 1, blur: once the element has lost focus, no composition can still be in progress.
  await page.evaluate(() => {
    document.querySelector('.xterm-helper-textarea')!.dispatchEvent(new FocusEvent('blur'))
  })
  await typeLine(page, 'echo IMEBLUR')
  await waitFor(
    async () => (await terminalText(page)).includes('IMEBLUR'),
    'terminal still dead after blur; composing is stuck',
  )

  // Fallback 2, a plain keydown: the browser itself says the key is not part of a composition. The
  // reset runs in the capture phase, so this very keypress must get through as well.
  await startComposing()
  await typeLine(page, 'echo IMEKEY')
  await waitFor(
    async () => (await terminalText(page)).includes('IMEKEY'),
    'a plain key did not reset the composition state; the first character was swallowed as composition',
  )
})

const stats = (page: Page): Promise<InputStats> => hooks.inputStats(page)

/**
 * E2E-34 (4) The input path is observable (AC-3.17).
 *
 * This does not test whether input gets through (that is (1)-(3)); it tests whether, when input is
 * stuck, you can tell at a glance which stage broke. ADR-0020 depends on this observability;
 * without it every investigation starts from guessing.
 */
test('E2E-34 (4) when typing does nothing, inputStats points at the broken stage', async ({ page }) => {
  await agent.open(page)

  await page.getByTestId('terminal').click({ position: { x: 60, y: 60 } })
  await typeLine(page, 'echo STATS')
  await waitFor(async () => (await terminalText(page)).includes('STATS'), 'STATS echoed')

  const ok = await stats(page)
  expect(ok.keydown.n, 'keys reached the page').toBeGreaterThan(0)
  expect(ok.toTerm.n, 'focus is on the terminal').toBeGreaterThan(0)
  expect(ok.data.n, 'xterm emitted onData').toBeGreaterThan(0)
  expect(ok.sent.n, 'sent to the agent').toBeGreaterThan(0)
  expect(ok.gated, 'user keys must not be dropped by the replay gate').toBe(0)
  expect(ok.verdict, `verdict with all four stages working: ${ok.verdict}`).toContain('All four stages OK')

  // Lost-focus fingerprint: keys still reach the page but not the terminal.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  const before = await stats(page)
  await page.keyboard.press('a')
  const after = await stats(page)

  expect(after.keydown.n, 'the key was pressed').toBeGreaterThan(before.keydown.n)
  expect(after.toTerm.n, 'but did not reach the terminal').toBe(before.toTerm.n)
  expect(after.focus, `focus should no longer be the terminal textarea, but is ${after.focus}`).not.toContain('xterm-helper-textarea')
  // This also proves the verdict uses the most recent event rather than totals: typing succeeded
  // above, so all four totals are already > 0 and a totals-based check would always pass here.
  expect(after.verdict, `verdict with focus lost: ${after.verdict}`).toContain('Focus is not in the terminal')
})
