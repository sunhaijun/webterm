/**
 * E2E-6 Multiple sessions and unread (AC-2.11 / AC-4.3)
 * E2E-11 Session lifecycle (AC-4.2 / AC-4.5 / US-7.3)
 * E2E-18 No session mix-up after an agent restart (AC-2.13)
 */
import { devices, expect, test, type Page } from '@playwright/test'

import {
  Agent,
  EMIT,
  copySelection,
  count,
  focusTerm,
  hooks,
  installWSControl,
  lastWelcome,
  newSession,
  openDrawer,
  outSeq,
  selectLine,
  submit,
  switchTo,
  terminalText,
  waitFor,
  waitOnline,
  waitText,
} from './harness'

const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
const WIDE = { viewport: { width: 1440, height: 900 }, contextOptions: { screen: { width: 1440, height: 900 } } }

const EXIT_LINE = '[Process exited (code 1) · press Enter to close]'

/**
 * atBottom reports whether the viewport is at the bottom of the buffer. It uses buffer positions
 * because the DOM scrollTop syncs a frame later and would flicker.
 */
const atBottom = async (p: Page) => {
  const lines = (await hooks.text(p)).split('\n').length
  const { rows } = await hooks.size(p)
  return (await hooks.viewport(p)).y >= lines - rows
}

/** unreadFlow is the body of E2E-6; the two forms differ only in where the unread marker appears. */
async function unreadFlow(page: Page, agent: Agent, form: 'compact' | 'wide') {
  await agent.open(page)
  const a = (await hooks.sid(page))!
  const b = await newSession(page)
  await switchTo(page, a)

  // A produces output for 5s.
  await submit(page, `${EMIT} 100 50`)
  await waitText(page, 'line 00005', 'A started producing output')
  await switchTo(page, b)

  // A gets an unread marker (session.updated{head_seq} > local out_seq; no bytes cross the network).
  await waitFor(async () => hooks.unread(page, a), 'A shows unread', 20_000)
  if (form === 'compact') {
    await expect(page.getByTestId('open-sessions'), 'sessions button has a red dot').toHaveAttribute('data-unread', 'true')
    await openDrawer(page)
    await expect(page.getByTestId(`session-${a}`), "A's drawer row has an unread dot").toHaveAttribute('data-unread', 'true')
    await expect(page.getByTestId(`session-${a}`).locator('.unread-dot')).toBeVisible()
    await page.keyboard.press('Escape')
  } else {
    await expect(page.getByTestId(`tab-${a}`)).toHaveAttribute('data-unread', 'true')
    await expect(page.getByTestId(`tab-${a}-unread`), "A's tab has an unread dot").toBeVisible()
  }

  // B works normally.
  await submit(page, 'echo in-b')
  await waitFor(async () => (await terminalText(page)).split('\n').some((l) => l.trimEnd() === 'in-b'), 'B works normally')

  // Back to A: all output from while away is there and unread is cleared.
  await switchTo(page, a)
  await waitText(page, 'EMIT-DONE', "A's output has caught up", 30_000)
  const t = await terminalText(page)
  for (const n of [1, 50, 100]) expect(count(t, `line ${String(n).padStart(5, '0')} `), `line ${n} exactly once`).toBe(1)
  expect(await hooks.unread(page, a)).toBe(false)
  if (form === 'compact') await expect(page.getByTestId('open-sessions')).toHaveAttribute('data-unread', 'false')
  else await expect(page.getByTestId(`tab-${a}`)).toHaveAttribute('data-unread', 'false')

  // At the bottom before switching away -> follows to the bottom on return.
  expect(await atBottom(page), 'was at the bottom before switching away, so should be at the bottom on return').toBe(true)

  // Not at the bottom before switching away -> stays put on return (A produces a little more output meanwhile).
  await submit(page, `sleep 1; ${EMIT} 3 0`)
  await page.waitForTimeout(300) // let the echo settle before scrolling back
  await hooks.scrollLines(page, -20)
  const top = await hooks.viewport(page)
  expect(await atBottom(page)).toBe(false)
  await switchTo(page, b)
  await page.waitForTimeout(2500)
  await switchTo(page, a)
  await waitFor(async () => count(await terminalText(page), 'EMIT-DONE') === 2, 'second burst caught up')
  const back = await hooks.viewport(page)
  expect(back.top, `scrollback position should not move on return (before y=${top.y}, after y=${back.y})`).toBe(top.top)
}

test.describe('E2E-6 multiple sessions and unread', () => {
  let agent: Agent
  test.beforeEach(async () => {
    agent = await Agent.start()
  })
  test.afterEach(() => agent.stop())

  test.describe('Pixel 5', () => {
    test.use(PIXEL)
    test('background session keeps running: red dot on sessions button and unread dot in drawer; on return content is complete, unread cleared, scrollback position kept', async ({ page }) => {
      await unreadFlow(page, agent, 'compact')
    })
  })

  test.describe('1440×900', () => {
    test.use(WIDE)
    test('background session keeps running: unread dot on its tab; on return content is complete, unread cleared, scrollback position kept', async ({ page }) => {
      await unreadFlow(page, agent, 'wide')
    })
  })
})

test.describe('E2E-11 session lifecycle (limit 5)', () => {
  let agent: Agent
  test.beforeEach(async () => {
    agent = await Agent.start({ maxSessions: 5 })
  })
  test.afterEach(() => agent.stop())
  test.use(WIDE)

  test('(1) at the limit: + is disabled with a reason, the shortcut shows a toast', async ({ page }) => {
    await agent.open(page)
    for (let i = 1; i < 5; i++) await newSession(page)
    await expect(page.locator('.tabbar .tab')).toHaveCount(5)
    // A button that silently does nothing is the worst outcome (US-7.3).
    const plus = page.getByTestId('new-session')
    await expect(plus).toBeDisabled()
    await expect(plus).toHaveAttribute('title', 'Session limit reached (5)')
    await focusTerm(page)
    await page.keyboard.press('Control+Shift+Enter')
    await expect(page.getByTestId('toast')).toContainText('Session limit reached (5)')
  })

  test('(2)-(6) shell exit: notice line after the last output, not counted in seq, scrollable and copyable, one line after reload, Enter closes', async ({ page }) => {
    await agent.open(page)
    const keep = (await hooks.sid(page))!
    const sid = await newSession(page)

    await submit(page, "printf 'LAST-%s\\n' LINE")
    await waitText(page, /^LAST-LINE$/m)
    await submit(page, 'exit 1')
    await waitText(page, EXIT_LINE)
    // The notice line is written locally and not counted in seq: outSeq stops changing once it is
    // written, and equals the agent's head_seq (checked against the welcome after reload).
    const seqAtLine = await outSeq(page)
    await page.waitForTimeout(500)
    expect(await outSeq(page), 'outSeq does not change after the notice line').toBe(seqAtLine)

    // It comes after LAST-LINE, at the end of the buffer.
    const lines = (await terminalText(page)).split('\n').map((l) => l.trimEnd())
    const iLast = lines.findIndex((l) => l === 'LAST-LINE')
    const iExit = lines.findIndex((l) => l.includes(EXIT_LINE))
    expect(iExit, 'notice line comes after LAST-LINE').toBeGreaterThan(iLast)
    expect(lines.slice(iExit + 1).every((l) => l === ''), 'nothing after the notice line').toBe(true)

    // (4) The tab is marked as exited.
    await expect(page.getByTestId(`tab-${sid}`)).toHaveAttribute('data-exited', 'true')

    // (3) An exited session can still be scrolled, selected and copied.
    await hooks.scrollLines(page, -3)
    await hooks.scrollLines(page, 3)
    await selectLine(page, 'LAST-LINE')
    expect(await copySelection(page)).toContain('LAST-LINE')

    // (5) Reload: the snapshot has no notice line (it is not in the agent's emulator); the client
    // writes it again from session state, so there is exactly one.
    await page.reload()
    await waitOnline(page)
    const head = (await lastWelcome(page))!.sessions.find((x) => x.sid === sid)!.head_seq
    expect(seqAtLine, `notice line not counted in seq: outSeq before reload ${seqAtLine}, agent head_seq ${head}`).toBe(head)
    await switchTo(page, sid)
    await waitText(page, EXIT_LINE)
    await page.waitForTimeout(500)
    expect(count(await terminalText(page), EXIT_LINE), 'one notice line after reload').toBe(1)
    expect(await outSeq(page)).toBeGreaterThan(0)

    // (6) Enter in that session closes it (no confirmation) and switches to the adjacent session.
    let asked = false
    page.on('dialog', (d) => {
      asked = true
      void d.dismiss()
    })
    await focusTerm(page)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId(`tab-${sid}`)).toHaveCount(0)
    expect(asked, 'closing an exited session needs no confirmation').toBe(false)
    await expect(page.getByTestId('close-confirm'), 'closing an exited session shows no confirmation sheet').toHaveCount(0)
    await waitFor(async () => (await hooks.sid(page)) === keep, 'switched to the adjacent session')
  })

  test('(7) closing a running session (session menu -> close) shows an in-app confirmation: Cancel / Esc keep it, Enter closes (ADR-0038)', async ({ page }) => {
    await agent.open(page)
    const sid = await newSession(page)
    const name = (await page.getByTestId(`tab-${sid}`).locator('.tab-name').textContent())!

    let dialogs = 0
    page.on('dialog', (d) => {
      dialogs++
      void d.dismiss()
    })
    const confirm = page.getByTestId('close-confirm')
    const ask = async () => {
      await page.getByTestId(`tab-${sid}`).click({ button: 'right' })
      await page.getByTestId('session-close').click()
      await expect(confirm, 'closing a running session requires confirmation').toBeVisible()
    }
    await ask()
    await expect(confirm).toContainText(`Close "${name}"?`)
    await expect(page.getByTestId('close-ok'), 'focus is on the close button').toBeFocused()
    await page.getByTestId('close-cancel').click()
    await expect(confirm).toHaveCount(0)
    await expect(page.getByTestId(`tab-${sid}`), 'Cancel keeps the session').toBeVisible()

    await ask()
    await page.keyboard.press('Escape')
    await expect(confirm).toHaveCount(0)
    await expect(page.getByTestId(`tab-${sid}`), 'Esc also cancels').toBeVisible()

    await ask()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId(`tab-${sid}`), 'Enter confirms').toHaveCount(0)
    expect(dialogs, 'no browser dialogs').toBe(0)
  })
})

test.describe('E2E-11 (4) compact: an exited session shows exit 1 in the drawer (warning color)', () => {
  let agent: Agent
  test.beforeEach(async () => {
    agent = await Agent.start()
  })
  test.afterEach(() => agent.stop())
  test.use(PIXEL)

  test('exit 1 in the drawer list', async ({ page }) => {
    await agent.open(page)
    const sid = await newSession(page)
    await submit(page, 'exit 1')
    await waitText(page, EXIT_LINE)
    await openDrawer(page)
    const row = page.getByTestId(`session-${sid}`)
    await expect(row).toHaveAttribute('data-exited', 'true')
    await expect(row.locator('.sl-meta')).toHaveText('exit 1')
    await expect(row.locator('.sl-meta')).toHaveAttribute('data-failed', 'true')
  })
})

test.describe('E2E-18 no session mix-up after an agent restart', () => {
  let agent: Agent
  test.beforeEach(async () => {
    agent = await Agent.start()
  })
  test.afterEach(() => agent.stop())

  test("B reconnects with the old instance_id and resume{sid:1} -> gone; its screen does not continue with A's new session output", async ({ page, context }) => {
    // Tab A.
    await agent.open(page)
    const sid = (await hooks.sid(page))!
    expect(sid).toBe(1)

    // Tab B (same context: shared cookie, separate client_id) also watches sid 1 and builds up a lot of output.
    const pageB = await context.newPage()
    const netB = await installWSControl(pageB)
    await pageB.goto(agent.baseURL)
    await waitOnline(pageB)
    await waitFor(async () => (await hooks.sid(pageB)) === 1, 'B is watching sid 1')
    await submit(pageB, `${EMIT} 200 0; printf 'B-%s\\n' OLD`)
    await waitText(pageB, /^B-OLD$/m)
    const oldSeq = await outSeq(pageB)
    expect(oldSeq).toBeGreaterThan(10_000)
    const oldInstance = (await lastWelcome(pageB))!.instance_id

    // Keep B disconnected so A reconnects first.
    await netB.goOffline()
    await agent.restart()

    // A reconnects: all sessions are gone -> create one; it gets sid 1.
    await waitOnline(page)
    await expect(page.getByTestId('empty')).toBeVisible()
    await page.getByTestId('empty-new-session').click()
    await waitFor(async () => (await hooks.sid(page)) === 1, "A's new session got sid 1")
    await submit(page, "printf 'A-%s\\n' NEW")
    await waitText(page, /^A-NEW$/m)

    // B reconnects next: its hello carries the old instance_id and resume{sid:1, out_seq: large}.
    netB.goOnline()
    await waitOnline(pageB)
    const w = (await lastWelcome(pageB))!
    expect(w.instance_id, 'the agent did restart').not.toBe(oldInstance)
    expect(w.resumed.find((r) => r.sid === 1)?.status, `resumed=${JSON.stringify(w.resumed)}`).toBe('gone')
    await expect(pageB.getByTestId('toast')).toContainText('Session ended')

    // A's new session is not appended to B's old content: the old content is gone; if B shows sid 1,
    // it is the new session rebuilt from a snapshot.
    await pageB.waitForTimeout(1000)
    const text = await terminalText(pageB)
    expect(text, "B's old content must not remain on screen").not.toContain('B-OLD')
    if (text.includes('A-NEW')) expect(count(text, 'line 00001'), 'no old output in the new session').toBe(0)
  })
})
