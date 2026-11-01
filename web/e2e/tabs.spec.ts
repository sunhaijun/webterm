/**
 * E2E-41 Wide tab bar (AC-4.10 / AC-4.11 / AC-5.11, plus AC-4.8 "switching keeps geometry").
 * `+` placement: ADR-0035. ⚙ and the settings dialog: ADR-0037. Close confirmation: ADR-0038.
 *
 * 1440×900 with a mouse; step (7) uses the iPad Mini device descriptor (touch, wide).
 */
import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, EMIT, focusTerm, framesSince, hooks, newSession, rectOf, submit, switchTo, waitFor, waitText } from './harness'

const WIDE = { viewport: { width: 1440, height: 900 }, contextOptions: { screen: { width: 1440, height: 900 } } }
const { defaultBrowserType: _p, ...IPAD } = devices['iPad Mini']!

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

const geo = async (p: Page) => ({ rect: await rectOf(p, '[data-testid=terminal]'), size: await hooks.size(p) })
const closeVisible = (p: Page, sid: number) =>
  p.getByTestId(`tab-${sid}-close`).evaluate((el) => getComputedStyle(el).visibility === 'visible')
/** tabName returns the name shown on a tab, without the number, pin and unread dot. */
const tabName = (p: Page, sid: number) => p.getByTestId(`tab-${sid}`).locator('.tab-name').textContent()
/** plusGap returns the gap from the tab strip's right edge to the left edge of `+` (ADR-0035 §2). */
const plusGap = async (p: Page) => {
  const strip = (await p.getByTestId('tabbar').boundingBox())!
  const plus = (await p.getByTestId('new-session').boundingBox())!
  return plus.x - (strip.x + strip.width)
}

test.describe('1440×900 mouse', () => {
  test.use(WIDE)

  test('E2E-41 (1)(2) structure; creating and switching sessions keep terminal geometry', async ({ page }) => {
    await agent.open(page)
    const a = (await hooks.sid(page))!

    // (1) Top bar above the terminal; one tab in the strip; `+` outside the strip; status dot and ⚙
    // pinned on the right (⚙ rightmost); no sessions button, no extra keys.
    await expect(page.locator('.app')).toHaveAttribute('data-form', 'wide')
    const bar = (await rectOf(page, '.topbar'))!
    const term = (await rectOf(page, '[data-testid=terminal]'))!
    expect(bar.bottom).toBeLessThanOrEqual(term.top + 1)
    expect(bar.height, 'tab bar is 36px (mouse)').toBe(36)
    const tabbar = page.getByTestId('tabbar')
    await expect(tabbar.locator('.tab')).toHaveCount(1)
    await expect(tabbar.getByTestId('new-session'), '`+` is not inside the scrolling tab strip (ADR-0035)').toHaveCount(0)
    await expect(page.locator('.topbar').getByTestId('new-session')).toBeVisible()
    expect(Math.abs((await plusGap(page)) - 12), '12px gap before `+`').toBeLessThanOrEqual(0.5)
    await expect(tabbar.getByTestId('conn-dot'), 'status dot is not inside the scrolling tab strip').toHaveCount(0)
    await expect(page.locator('.topbar').getByTestId('conn-dot')).toHaveAttribute('data-state', 'online')
    await expect(tabbar.getByTestId('open-settings'), '⚙ is not inside the tab strip').toHaveCount(0)
    const dot = (await rectOf(page, '[data-testid=conn-dot]'))!
    const gear = (await rectOf(page, '[data-testid=open-settings]'))!
    const strip = (await rectOf(page, '[data-testid=tabbar]'))!
    expect(dot.left, 'status dot is right of the tab strip').toBeGreaterThanOrEqual(strip.right - 1)
    expect(Math.abs(bar.right - gear.right), '⚙ is rightmost').toBeLessThanOrEqual(1)
    expect(gear.left - dot.right, 'status dot sits right next to ⚙ (margin only)').toBeLessThanOrEqual(6)
    expect(gear.left).toBeGreaterThanOrEqual(dot.right)
    // `+` and ⚙ are matching line icons centered on their geometric center, on the same horizontal
    // line as the status dot (ADR-0035 §3, ADR-0037 §3).
    const mid = await page.evaluate(() => {
      const r = (s: string) => document.querySelector(s)!.getBoundingClientRect()
      const c = (s: string) => r(s).top + r(s).height / 2
      return {
        plus: c('[data-testid=new-session] svg'),
        gear: c('[data-testid=open-settings] svg'),
        dot: c('[data-testid=conn-dot]'),
        plusW: r('[data-testid=new-session] svg').width,
        gearW: r('[data-testid=open-settings] svg').width,
      }
    })
    const m = JSON.stringify(mid)
    expect(Math.abs(mid.plus - mid.dot), `\`+\` vertically aligned with the status dot: ${m}`).toBeLessThanOrEqual(0.5)
    expect(Math.abs(mid.gear - mid.dot), `⚙ vertically aligned with the status dot: ${m}`).toBeLessThanOrEqual(0.5)
    expect(mid.gearW, `both icons are the same size: ${m}`).toBe(mid.plusW)
    await expect(page.getByTestId('open-sessions')).toHaveCount(0)
    await expect(page.getByTestId('extrakeys')).toHaveCount(0)

    // (2) Create and switch: geometry never changes.
    await page.waitForTimeout(300)
    const g0 = await geo(page)
    await page.getByTestId('new-session').click()
    await expect(tabbar.locator('.tab')).toHaveCount(2)
    await waitFor(async () => (await hooks.sid(page)) !== a, 'new tab became current')
    const b = (await hooks.sid(page))!
    await expect(page.getByTestId(`tab-${b}`)).toHaveAttribute('aria-current', 'true')
    expect(await geo(page)).toEqual(g0)
    await page.getByTestId(`tab-${a}`).click()
    await waitFor(async () => (await hooks.sid(page)) === a, 'clicking the first tab switched back')
    expect(await geo(page)).toEqual(g0)
  })

  test('E2E-41 (3) close: ✕ on hover, running session asks in an in-app dialog first; same for middle click; Ctrl+Shift+W then Enter', async ({ page }) => {
    await agent.open(page)
    const a = (await hooks.sid(page))!
    const b = await newSession(page)
    const c = await newSession(page)

    // Non-current tab: ✕ is hidden until hover.
    expect(await closeVisible(page, a)).toBe(false)
    await page.getByTestId(`tab-${a}`).hover()
    expect(await closeVisible(page, a), '✕ appears on hover').toBe(true)

    let dialogs = 0
    page.on('dialog', (d) => {
      dialogs++
      void d.dismiss()
    })
    const confirm = page.getByTestId('close-confirm')
    await page.getByTestId(`tab-${a}-close`).click()
    await expect(confirm, 'running session: confirm first (in-app sheet, ADR-0038)').toBeVisible()
    // Wide: centered dialog, no grab handle.
    const r = (await rectOf(page, '[data-testid=close-confirm]'))!
    expect(Math.abs((r.left + r.right) / 2 - 720), 'horizontally centered').toBeLessThanOrEqual(1)
    expect(Math.abs((r.top + r.bottom) / 2 - 450), 'vertically centered').toBeLessThanOrEqual(1)
    await expect(confirm.locator('.drawer-grab')).toBeHidden()
    await expect(page.getByTestId(`tab-${a}`), 'not closed before confirming').toBeVisible()
    await page.getByTestId('close-ok').click()
    await expect(confirm).toHaveCount(0)
    await expect(page.getByTestId(`tab-${a}`)).toHaveCount(0)
    expect(await hooks.sid(page), 'closed a non-current tab, so current is unchanged').toBe(c)

    // Middle-click a tab = close, also confirmed first; Cancel keeps it.
    await page.getByTestId(`tab-${b}`).click({ button: 'middle' })
    await expect(confirm).toBeVisible()
    await page.getByTestId('close-cancel').click()
    await expect(confirm).toHaveCount(0)
    await expect(page.getByTestId(`tab-${b}`), 'Cancel keeps the tab').toBeVisible()
    await page.getByTestId(`tab-${b}`).click({ button: 'middle' })
    await page.getByTestId('close-ok').click()
    await expect(page.getByTestId(`tab-${b}`)).toHaveCount(0)

    // Keyboard: Ctrl+Shift+W in the terminal -> confirmation (focus on the close button) -> Enter
    // closes; focus returns to the new current session's terminal.
    const d = await newSession(page)
    await focusTerm(page)
    await page.keyboard.press('Control+Shift+W')
    await expect(confirm).toBeVisible()
    await expect(page.getByTestId('close-ok'), 'focus starts on the close button').toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId(`tab-${d}`)).toHaveCount(0)
    await waitFor(async () => (await hooks.sid(page)) === c, 'switched to the adjacent session')
    await expect(page.locator('.xterm-helper-textarea'), "focus returns to the new current session's terminal").toBeFocused()
    expect(dialogs, 'no browser dialogs').toBe(0)
  })

  test('E2E-41 (4) rename: double-click -> input -> Enter; Enter on empty restores the automatic name; numbered before and after', async ({ page }) => {
    await agent.open(page)
    const sid = (await hooks.sid(page))!
    const auto = (await tabName(page, sid))!
    expect(auto, 'automatic name = basename of CWD (home is ~)').toBe('~')
    const idx = page.getByTestId(`tab-${sid}-idx`)
    await expect(idx, 'tab is numbered (ADR-0041)').toHaveText('[1]')

    await page.getByTestId(`tab-${sid}`).dblclick()
    const input = page.getByTestId('rename-input')
    await expect(input).toBeFocused()
    await input.fill('RENAMED')
    await input.press('Enter')
    await expect.poll(() => tabName(page, sid)).toBe('RENAMED')
    await expect(idx, 'a renamed tab is still numbered, same as the drawer').toHaveText('[1]')

    // After a rename the name no longer follows CWD.
    await submit(page, 'cd /tmp')
    await page.waitForTimeout(1500)
    expect(await tabName(page, sid)).toBe('RENAMED')

    await page.getByTestId(`tab-${sid}`).dblclick()
    await input.fill('')
    await input.press('Enter')
    await expect.poll(() => tabName(page, sid), { message: 'empty -> automatic name restored (basename of current CWD)' }).toBe('tmp')
  })

  test('E2E-41 (5) session menu: right-click -> rename / keep receiving / close; with keep receiving, output still arrives after switching away', async ({ page }) => {
    await agent.open(page)
    const a = (await hooks.sid(page))!
    await newSession(page)

    await page.getByTestId(`tab-${a}`).click({ button: 'right' })
    const menu = page.getByTestId('session-menu')
    await expect(menu).toBeVisible()
    await expect(menu.getByTestId('session-rename')).toBeVisible()
    await expect(menu.getByTestId('session-pin')).toHaveAttribute('aria-checked', 'false')
    await expect(menu.getByTestId('session-close')).toBeVisible()
    await menu.getByTestId('session-pin').click()
    await expect(menu).toHaveCount(0)
    await expect(page.getByTestId(`tab-${a}`).locator('.pin-mark svg'), 'a pin appears before the name (SVG, ADR-0042)').toBeVisible()

    // A produces continuous output; switch to another session. A's frames keep arriving (outSeq
    // grows), so there is no unread.
    await switchTo(page, a)
    await submit(page, `${EMIT} 60 50`)
    await waitText(page, 'line 00003')
    const read = await framesSince(page)
    const b = (await page.locator('.tabbar .tab').nth(1).getAttribute('data-sid'))!
    await switchTo(page, Number(b))
    await page.waitForTimeout(1500)
    const fs = (await read()).filter((f) => f.sid === a && f.kind === 'OUTPUT')
    expect(fs.length, "keep receiving: A's OUTPUT still arrives after switching away").toBeGreaterThan(3)
    const seqs = fs.map((f) => f.seq)
    expect(seqs[seqs.length - 1]!, "A's outSeq grows").toBeGreaterThan(seqs[0]!)
    expect(await hooks.unread(page, a)).toBe(false)
  })

  test("E2E-41 (6) unread: A produces output, switch to B -> A's tab has an accent-colored unread dot; it clears on return", async ({ page }) => {
    await agent.open(page)
    const a = (await hooks.sid(page))!
    const b = await newSession(page)
    await switchTo(page, a)
    await submit(page, `${EMIT} 80 50`)
    await waitText(page, 'line 00003')
    await switchTo(page, b)
    await expect(page.getByTestId(`tab-${a}-unread`)).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId(`tab-${a}`)).toHaveAttribute('data-unread', 'true')
    // The unread dot uses the accent color (= current tab's text color), not red (ADR-0042 §1).
    const dot = await page.getByTestId(`tab-${a}-unread`).evaluate((e) => getComputedStyle(e).backgroundColor)
    const accent = await page.getByTestId(`tab-${b}`).evaluate((e) => getComputedStyle(e).color)
    expect(dot).toBe(accent)
    await switchTo(page, a)
    await expect(page.getByTestId(`tab-${a}-unread`)).toHaveCount(0)
    await expect(page.getByTestId(`tab-${a}`)).toHaveAttribute('data-unread', 'false')
  })

  test('E2E-41 (8) equal widths and scrolling: equal split capped at 240px; in a narrow window tabs stop at 120px and scroll horizontally, also with the wheel; widening restores', async ({ page }) => {
    await agent.open(page)
    await newSession(page)
    await newSession(page)
    const tabs = page.locator('.tabbar .tab')
    await expect(tabs).toHaveCount(3)
    const widths = () => tabs.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width))
    const strip = page.getByTestId('tabbar')
    const scroll = () => strip.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, left: el.scrollLeft }))

    // 3 tabs: equal width, all capped at 240px; the strip is exactly three tabs wide; `+` follows
    // the last tab 12px later; no scrolling.
    for (const w of await widths()) expect(Math.abs(w - 240), `tab width ${w}`).toBeLessThanOrEqual(1)
    const last = (await tabs.last().boundingBox())!
    const plus = (await page.getByTestId('new-session').boundingBox())!
    expect(Math.abs(plus.x - (last.x + last.width) - 12), '`+` follows the last tab, 12px apart').toBeLessThanOrEqual(1)
    let s = await scroll()
    expect(s.sw, 'no scrolling when tabs fit').toBe(s.cw)
    expect(Math.abs(s.cw - 720), `strip is exactly three tabs wide: ${s.cw}`).toBeLessThanOrEqual(1)

    // Narrow the window and grow to 5 tabs: each stops at 120px, the strip overflows, and the
    // current (most recently created) tab is fully visible.
    await page.setViewportSize({ width: 600, height: 900 })
    await newSession(page)
    const cur = await newSession(page)
    await expect(tabs).toHaveCount(5)
    for (const w of await widths()) expect(Math.abs(w - 120), `tab width ${w}`).toBeLessThanOrEqual(1)
    s = await scroll()
    expect(s.sw, 'tabs overflow').toBeGreaterThan(s.cw)
    const box = (await strip.boundingBox())!
    const curBox = (await page.getByTestId(`tab-${cur}`).boundingBox())!
    expect(curBox.x >= box.x - 1 && curBox.x + curBox.width <= box.x + box.width + 1, 'current tab fully visible').toBe(true)
    expect(s.left, 'current tab is last, so the strip has scrolled right').toBeGreaterThan(0)

    // When tabs overflow, `+` does not scroll with them: it stays fully inside the top bar,
    // clickable, 12px from the strip, and does not move when the strip scrolls to the far left
    // (ADR-0035).
    const pinned = (await page.getByTestId('new-session').boundingBox())!
    expect(pinned.x + pinned.width, '`+` is fully inside the 600px-wide top bar').toBeLessThanOrEqual(600)
    expect(Math.abs((await plusGap(page)) - 12), 'still 12px apart when tabs overflow').toBeLessThanOrEqual(0.5)
    const hit = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid=new-session]') !== null,
      { x: pinned.x + pinned.width / 2, y: pinned.y + pinned.height / 2 },
    )
    expect(hit, 'the center of `+` hits `+` itself').toBe(true)
    await strip.evaluate((el) => (el.scrollLeft = 0))
    await expect.poll(async () => (await scroll()).left).toBe(0)
    expect(await page.getByTestId('new-session').boundingBox(), 'strip scrolls, `+` stays put').toEqual(pinned)

    // A vertical mouse wheel scrolls the strip horizontally.
    await page.mouse.move(box.x + 60, box.y + box.height / 2)
    await page.mouse.wheel(0, 200)
    await expect.poll(async () => (await scroll()).left, { message: 'wheel down -> scrolls right' }).toBeGreaterThan(0)
    const before = (await scroll()).left
    await page.mouse.wheel(0, -200)
    await expect.poll(async () => (await scroll()).left, { message: 'wheel up -> scrolls left' }).toBeLessThan(before)

    // Widen: all 5 return to 240px and stop scrolling.
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect.poll(async () => (await widths()).every((w) => Math.abs(w - 240) <= 1)).toBe(true)
    s = await scroll()
    expect(s.sw, 'no scrolling after widening').toBe(s.cw)
  })

  test('E2E-41 (9) clicking the gap before `+` does nothing and does not steal terminal focus', async ({ page }) => {
    await agent.open(page)
    await newSession(page)
    const cur = (await hooks.sid(page))!
    const tabs = page.locator('.tabbar .tab')
    await expect(tabs).toHaveCount(2)
    await page.locator('.xterm-helper-textarea').focus()

    const last = (await tabs.last().boundingBox())!
    const plus = (await page.getByTestId('new-session').boundingBox())!
    const gap = { x: (last.x + last.width + plus.x) / 2, y: plus.y + plus.height / 2 }
    expect(plus.x - (last.x + last.width), 'gap is 12px').toBeGreaterThanOrEqual(11)
    await page.mouse.click(gap.x, gap.y)
    await page.waitForTimeout(400)
    await expect(tabs, 'no new session').toHaveCount(2)
    expect(await hooks.sid(page), 'current session unchanged').toBe(cur)
    expect(
      await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false),
      'focus is still in the terminal',
    ).toBe(true)
  })

  test('E2E-41 (10) settings is a centered dialog: terminal geometry unchanged, Esc closes it and focus returns to the terminal (ADR-0037 §4)', async ({ page }) => {
    await agent.open(page)
    await focusTerm(page)
    await page.waitForTimeout(300)
    const g0 = await geo(page)
    await page.getByTestId('open-settings').click()
    const st = page.getByTestId('settings')
    await expect(st).toBeVisible()
    const r = (await rectOf(page, '[data-testid=settings]'))!
    expect(Math.abs((r.left + r.right) / 2 - 720), 'horizontally centered').toBeLessThanOrEqual(1)
    expect(Math.abs((r.top + r.bottom) / 2 - 450), 'vertically centered').toBeLessThanOrEqual(1)
    expect(r.right - r.left, '420px wide').toBe(420)
    await expect(st.locator('.drawer-grab'), 'centered dialog has no grab handle').toBeHidden()
    expect(await geo(page), 'opening settings keeps terminal geometry').toEqual(g0)
    await page.keyboard.press('Escape')
    await expect(st).toHaveCount(0)
    await expect(page.locator('.xterm-helper-textarea'), 'focus returns to the terminal after closing').toBeFocused()
    await page.keyboard.type('echo SETTINGS-BACK')
    await waitText(page, 'echo SETTINGS-BACK', 'typing is echoed')
  })

  test('E2E-41 (11) terminal title as tab name: used when set by the foreground program, ignored when set by the shell prompt, back to the directory name when the program exits (ADR-0043)', async ({ page }) => {
    await agent.open(page)
    const sid = (await hooks.sid(page))!
    // The harness shell reads the user's .bashrc, whose prompt may set `user@host: dir` every time; that is ignored.
    await submit(page, 'true')
    await page.waitForTimeout(2000)
    expect(await tabName(page, sid), 'title set by the shell is ignored').toBe('~')
    await submit(page, `bash -c 'printf "\\033]0;E2E TITLE\\007"; sleep 3'`)
    await expect.poll(() => tabName(page, sid), { message: 'title set by the foreground program' }).toBe('E2E TITLE')
    await expect(page.getByTestId(`tab-${sid}-idx`), 'number still shown').toHaveText('[1]')
    await expect.poll(() => tabName(page, sid), { message: 'program exits -> back to the directory name', timeout: 10_000 }).toBe('~')
  })
})

test.describe('iPad Mini touch', () => {
  test.use(IPAD)

  test('E2E-41 (7) touch: ✕ only on the current tab; long-press a tab opens the session menu; extra keys present, side column holds only ✎', async ({ page }) => {
    await agent.open(page)
    const a = (await hooks.sid(page))!
    const b = await newSession(page)

    await expect(page.locator('.app')).toHaveAttribute('data-form', 'wide')
    await expect(page.locator('.app')).toHaveAttribute('data-coarse', 'true')
    expect(await closeVisible(page, b), 'current tab has ✕').toBe(true)
    expect(await closeVisible(page, a), 'non-current tabs have no ✕ (avoids mis-taps)').toBe(false)
    expect(Math.abs((await plusGap(page)) - 16), '16px gap before `+` on touch').toBeLessThanOrEqual(0.5)

    const box = (await page.getByTestId(`tab-${a}`).boundingBox())!
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] })
    await page.waitForTimeout(700)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await cdp.detach()
    await expect(page.getByTestId('session-menu')).toBeVisible()
    expect(await hooks.sid(page), 'long-press does not switch sessions').toBe(b)
    await page.getByTestId('session-menu-scrim').click({ position: { x: 5, y: 500 } })

    await expect(page.getByTestId('extrakeys')).toBeVisible()
    const side = await page.evaluate(() => [...document.querySelectorAll('.ek-side > *')].map((e) => (e as HTMLElement).dataset.testid))
    expect(side, 'on wide, the side column holds only ✎').toEqual(['toggle-text'])
  })
})
