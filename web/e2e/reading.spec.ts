/**
 * E2E-5 Connection status indicator (AC-2.10)
 * E2E-12 Reading output (AC-5.1 / AC-5.3 / AC-5.4; (2) appearance settings, ADR-0037)
 */
import { devices, expect, test, type Page } from '@playwright/test'

import {
  Agent,
  EMIT,
  copySelection,
  focusTerm,
  hooks,
  installWSControl,
  lastWelcome,
  outSeq,
  rectOf,
  selectLine,
  submit,
  terminalText,
  waitFor,
  waitOnline,
  waitText,
} from './harness'

const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
const WIDE = { viewport: { width: 1440, height: 900 }, contextOptions: { screen: { width: 1440, height: 900 } } }

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

/** parseBytes extracts the caught-up byte count from the toast text ("N B/KB/MB") and returns bytes. */
function parseBytes(s: string): number {
  const m = s.match(/caught up ([\d.]+) (B|KB|MB)/)
  if (!m) throw new Error(`no byte count in toast: ${s}`)
  return Number(m[1]) * (m[2] === 'MB' ? 1024 * 1024 : m[2] === 'KB' ? 1024 : 1)
}

/** geo captures terminal geometry: rect, rows/cols, and resize count. */
const geo = async (p: Page) => ({ rect: await rectOf(p, '[data-testid=terminal]'), size: await hooks.size(p), resizes: await hooks.resizes(p) })

async function connFlow(page: Page, form: 'compact' | 'wide') {
  const net = await installWSControl(page)
  await agent.open(page)
  const sid = (await hooks.sid(page))!

  // (1) Online: the banner is visually hidden; conn-text is in the DOM and reads online.
  const banner = page.getByTestId('conn-banner')
  await expect(page.getByTestId('conn-text')).toHaveText('Online')
  expect((await banner.boundingBox())!.width, 'banner is visually hidden while online').toBeLessThanOrEqual(1)
  if (form === 'wide') await expect(page.getByTestId('conn-dot')).toHaveAttribute('data-state', 'online')
  else await expect(page.getByTestId('conn-dot')).toHaveCount(0)
  await page.waitForTimeout(300)
  const g0 = await geo(page)

  // Produce output during the outage so there is something to catch up on.
  await submit(page, `${EMIT} 300 10`)
  await waitText(page, 'line 00010')

  // (2) Cut the connection -> banner shows "reconnecting, retry in Ns" with a countdown.
  await net.goOffline()
  const cutSeq = await outSeq(page)
  await expect(page.getByTestId('conn-text')).toContainText('Reconnecting')
  if (form === 'wide') await expect(page.getByTestId('conn-dot')).toHaveAttribute('data-state', 'reconnecting')
  expect((await banner.boundingBox())!.width, 'banner is visible while not online').toBeGreaterThan(100)
  // Once backoff reaches >= 2s, the countdown is visibly ticking.
  let n = 0
  await waitFor(async () => {
    const m = ((await page.getByTestId('conn-text').textContent()) ?? '').match(/Reconnecting · retry in (\d+)s/)
    n = m ? Number(m[1]) : 0
    return n >= 2
  }, 'a countdown of at least 2s', 20_000)
  await expect(page.getByTestId('conn-text'), 'countdown decreases').toContainText(`Reconnecting · retry in ${n - 1}s`, { timeout: 3_000 })

  // (3) The banner does not change geometry.
  expect(await geo(page), 'terminal rect, rows/cols and resize count unchanged by the banner').toEqual(g0)

  // (4) Restore -> banner hides; a "restored, caught up N KB" toast appears and disappears after 3s.
  net.goOnline()
  await waitOnline(page)
  const toast = page.getByTestId('toast')
  await expect(toast).toContainText('Resumed · caught up')
  expect((await banner.boundingBox())!.width, 'banner is visually hidden after restore').toBeLessThanOrEqual(1)
  if (form === 'wide') await expect(page.getByTestId('conn-dot')).toHaveAttribute('data-state', 'online')
  const got = parseBytes((await toast.textContent()) ?? '')
  // (5) Matches the amount actually caught up (same order of magnitude): the agent's head_seq at
  // reconnect minus out_seq at disconnect.
  const head = (await lastWelcome(page))!.sessions.find((s) => s.sid === sid)!.head_seq
  const want = head - cutSeq
  expect(want, 'there was output during the outage').toBeGreaterThan(1024)
  expect(got / want, `toast reports ${got} B, actually caught up ${want} B`).toBeGreaterThan(0.8)
  expect(got / want, `toast reports ${got} B, actually caught up ${want} B`).toBeLessThan(1.25)
  expect(await geo(page), 'the toast does not change geometry either').toEqual(g0)
  await expect(toast, 'gone after 3s').toHaveCount(0, { timeout: 5_000 })
}

test.describe('E2E-5 connection status indicator', () => {
  test.describe('Pixel 5', () => {
    test.use(PIXEL)
    test('compact: nothing shown while online; banner countdown when disconnected; banner keeps geometry; restore toast reports caught-up bytes', async ({ page }) => {
      await connFlow(page, 'compact')
    })
  })
  test.describe('1440×900', () => {
    test.use(WIDE)
    test('wide: status dot goes from online color to reconnecting color; same banner and toast', async ({ page }) => {
      await connFlow(page, 'wide')
    })
  })
})

test.describe('E2E-12 reading output (1440×900)', () => {
  test.use(WIDE)

  test('(1)(3)(4) scroll up to see early output; new output does not disturb the selection; copy returns the right text', async ({ page }) => {
    await agent.open(page)
    await submit(page, `${EMIT} 3000 0`)
    await waitText(page, 'EMIT-DONE', 'output finished', 60_000)

    // (1) Wheel up, without entering any mode.
    const t = (await rectOf(page, '[data-testid=terminal]'))!
    await page.mouse.move(t.left + t.width / 2, t.top + t.height / 2)
    const y0 = (await hooks.viewport(page)).y
    for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -2000)
    await expect.poll(async () => (await hooks.viewport(page)).y, { message: 'mouse wheel scrolls back' }).toBeLessThan(y0 - 100)
    await hooks.scrollLines(page, -100_000)
    expect((await hooks.viewport(page)).y, 'scrolled to the top of the buffer').toBe(0)
    const { rows } = await hooks.size(page)
    const firstScreen = (await terminalText(page)).split('\n').slice(0, rows)
    expect(firstScreen.some((l) => l.startsWith('line 00001 ')), 'earliest output is still in scrollback (visible on the top screen)').toBe(true)
    await hooks.scrollLines(page, 100_000)

    // (3) Select a line while new output arrives -> the selection stays on that line.
    await submit(page, "(sleep 1; for i in $(seq 1 30); do printf 'NEW-%02d\\n' $i; sleep 0.03; done) &")
    await waitText(page, /^\[\d+\] \d+$/m, 'background job started')
    await selectLine(page, 'line 02995 ')
    const sel0 = await copySelection(page)
    expect(sel0).toContain('line 02995')
    await waitText(page, /^NEW-30$/m, 'new output arrived')
    await page.waitForTimeout(300)
    // (4) Copy -> the clipboard holds that line.
    const sel1 = await copySelection(page)
    expect(sel1, 'new output does not disturb the selection').toBe(sel0)
  })

  test('(2) appearance follows the system by default; theme and font size changed in settings apply immediately and persist across reload (AC-5.3, ADR-0037)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await agent.open(page)
    // The terminal area's visible background is .stage's. xterm's own theme (used for ANSI colors and
    // inverse cells) is in .xterm-viewport's inline style; CSS forces that background transparent.
    const bg = () =>
      page.evaluate(() => ({
        body: getComputedStyle(document.body).backgroundColor,
        stage: getComputedStyle(document.querySelector('.stage')!).backgroundColor,
        xterm: document.querySelector<HTMLElement>('.xterm-viewport')!.style.backgroundColor,
      }))
    const theme = () => page.evaluate(() => document.documentElement.getAttribute('data-theme'))
    const light = 'rgb(251, 251, 252)'
    const dark = 'rgb(13, 17, 23)'
    const LIGHT = { body: 'rgb(255, 255, 255)', stage: light, xterm: light }
    const DARK = { body: dark, stage: dark, xterm: dark }

    // Default: follow the system.
    expect(await bg(), 'light: --bg / --term-bg').toEqual(LIGHT)
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(bg, { message: 'system switches to dark: UI and xterm change together without a reload' }).toEqual(DARK)
    expect(await theme(), 'no data-theme while following the system').toBeNull()
    expect(await hooks.fontSize(page), 'default font size').toBe(14)
    await focusTerm(page)
    await page.keyboard.press('Control+Shift+Comma')
    await page.waitForTimeout(300)
    await expect(page.locator('.drawer'), 'Ctrl+Shift+, goes to the terminal and opens no sheet').toHaveCount(0)

    // Change the theme: system still dark, pick light.
    await page.getByTestId('open-settings').click()
    await expect(page.getByTestId('settings')).toBeVisible()
    await expect(page.getByTestId('theme-system')).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('theme-light').click()
    await expect(page.getByTestId('theme-light')).toHaveAttribute('aria-checked', 'true')
    expect(await theme()).toBe('light')
    await expect.poll(bg, { message: 'light selected: applies without a reload' }).toEqual(LIGHT)
    await page.reload()
    await waitOnline(page)
    expect(await theme(), 'still light after reload').toBe('light')
    await expect.poll(bg).toEqual(LIGHT)
    await page.getByTestId('open-settings').click()
    await page.getByTestId('theme-system').click()
    expect(await theme(), 'back to following the system: data-theme removed').toBeNull()
    await expect.poll(bg, { message: 'following the system: dark again' }).toEqual(DARK)

    // Change the font size: + twice -> 16; fewer columns, and a resize is sent (cell size changed,
    // container did not).
    const size0 = await hooks.size(page)
    const r0 = await hooks.resizes(page)
    await page.getByTestId('font-inc').click()
    await page.getByTestId('font-inc').click()
    await expect(page.getByTestId('font-size')).toHaveText('16')
    expect(await hooks.fontSize(page)).toBe(16)
    await expect.poll(async () => (await hooks.size(page)).cols, { message: 'larger font, fewer columns' }).toBeLessThan(size0.cols)
    await expect.poll(() => hooks.resizes(page), { message: 'resize sent' }).toBeGreaterThan(r0)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('settings')).toHaveCount(0)
    await page.reload()
    await waitOnline(page)
    expect(await hooks.fontSize(page), 'still 16 after reload').toBe(16)
    await page.getByTestId('open-settings').click()
    for (let i = 0; i < 6; i++) await page.getByTestId('font-dec').click()
    await expect(page.getByTestId('font-size')).toHaveText('10')
    await expect(page.getByTestId('font-dec'), 'at the minimum').toBeDisabled()
    const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('webterm.font')))
    expect(keys, 'one font size setting, not one per form').toEqual(['webterm.fontSize'])
  })
})
