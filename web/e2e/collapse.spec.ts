/**
 * E2E-52 Collapsing the extra keys (AC-3.26, AC-3.18), ADR-0056.
 *
 * Real CDP touch drags on Pixel 5 and iPad Mini; `WebSocket.send` is hooked to record INPUT
 * frames. Each collapse and restore must change the terminal size exactly once.
 */
import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, hooks, newSession, recordSent, submit, switchTo, waitFor, type SentRecorder } from './harness'

const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
const { defaultBrowserType: _q, ...IPAD } = devices['iPad Mini']!

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

/** drag sends a real CDP touch drag from (x, y) by (dx, dy). */
async function drag(page: Page, x: number, y: number, dx: number, dy = 0, hold?: () => Promise<void>) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / 10, y: y + (dy * i) / 10 }] })
    await page.waitForTimeout(16)
  }
  if (hold) await hold()
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

/** tap sends a real CDP touch tap at the center of a test id. */
async function tapId(page: Page, id: string) {
  const b = (await page.getByTestId(id).boundingBox())!
  const cdp = await page.context().newCDPSession(page)
  const p = { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] })
  await page.waitForTimeout(40)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

const keysBox = async (page: Page) => (await page.locator('.ek-main').boundingBox())!

async function inputSince(rec: SentRecorder, n: number): Promise<string[]> {
  await new Promise((r) => setTimeout(r, 400))
  return (await rec.input()).slice(n)
}

/** collapse swipes right across the keys and waits for the terminal to settle. */
async function collapse(page: Page) {
  const b = await keysBox(page)
  await drag(page, b.x + 40, b.y + b.height / 2, 140)
  await expect(page.getByTestId('extrakeys')).toHaveAttribute('data-collapsed', 'true')
}

/** settledSize waits until the terminal size stops changing and returns it with the resize count. */
async function settled(page: Page) {
  let prev = ''
  await waitFor(async () => {
    await page.waitForTimeout(250)
    const now = JSON.stringify([await hooks.size(page), await hooks.resizes(page)])
    const same = now === prev
    prev = now
    return same
  }, 'terminal size settled', 5_000)
  return { rows: (await hooks.size(page)).rows, resizes: await hooks.resizes(page) }
}

test.describe('Pixel 5', () => {
  test.use(PIXEL)

  test('E2E-52 (1)-(5) a drag presses nothing; swipe right collapses with one resize; short swipes slide back; tap, swipe left or nothing from the edge', async ({ page }) => {
    const rec = await recordSent(page)
    await agent.open(page)
    const ek = page.getByTestId('extrakeys')
    const before = await settled(page)

    // (1) A drag starting on ESC sends nothing and leaves no pressed key; a tap still sends 1b
    const esc = (await page.getByTestId('key-Escape').boundingBox())!
    let n = (await rec.input()).length
    await drag(page, esc.x + esc.width / 2, esc.y + esc.height / 2, 0, -30, async () => {
      expect(await page.getByTestId('key-Escape').getAttribute('data-pressed'), 'pressed look dropped once the finger moved').toBeNull()
    })
    expect(await inputSince(rec, n), 'a drag sends nothing').toEqual([])
    n = (await rec.input()).length
    await tapId(page, 'key-Escape')
    expect(await inputSince(rec, n)).toEqual(['\x1b'])

    // (3) A short swipe slides back
    const b = await keysBox(page)
    await drag(page, b.x + 40, b.y + b.height / 2, 20)
    await expect(ek).not.toHaveAttribute('data-collapsed', 'true')

    // (2) Collapse
    n = (await rec.input()).length
    await collapse(page)
    const vw = page.viewportSize()!.width
    const btn = (await page.getByTestId('keys-restore').boundingBox())!
    expect(Math.abs(vw - (btn.x + btn.width) - 16), `restore button 16px from the right edge (${vw - btn.x - btn.width})`).toBeLessThanOrEqual(1)
    const collapsed = await settled(page)
    expect(collapsed.rows - before.rows, 'the terminal gained rows').toBeGreaterThanOrEqual(4)
    expect(collapsed.resizes - before.resizes, 'exactly one resize').toBe(1)
    expect(await inputSince(rec, n), 'collapsing sends no input').toEqual([])

    // (4) Tap to restore
    await tapId(page, 'keys-restore')
    await expect(ek).not.toHaveAttribute('data-collapsed', 'true')
    await expect(page.getByTestId('keys-restore')).toHaveCount(0)
    const restored = await settled(page)
    expect(restored.rows).toBe(before.rows)
    expect(restored.resizes - collapsed.resizes).toBe(1)

    // (5) Swipe left along the bottom restores; starting at the edge does nothing
    await collapse(page)
    const term = (await page.getByTestId('terminal').boundingBox())!
    await drag(page, 200, term.y + term.height - 30, -140)
    await expect(ek).not.toHaveAttribute('data-collapsed', 'true')
    await collapse(page)
    await drag(page, vw - 10, term.y + term.height - 30, -140)
    await page.waitForTimeout(300)
    await expect(ek, 'an edge swipe belongs to the system').toHaveAttribute('data-collapsed', 'true')
    // Dragging the button to the left restores too
    const rb = (await page.getByTestId('keys-restore').boundingBox())!
    await drag(page, rb.x + rb.width / 2, rb.y + rb.height / 2, -120)
    await expect(ek).not.toHaveAttribute('data-collapsed', 'true')
  })

  test('E2E-52 (6)-(8) the dot, persistence, and coming back on the text page', async ({ page }) => {
    await agent.open(page)
    const ek = page.getByTestId('extrakeys')
    const a = (await hooks.sid(page))!
    const b = await newSession(page)

    // (6) B rings while A is current and the bar is collapsed -> the dot is on the restore button
    await submit(page, `sleep 2; printf '\\a'`)
    await switchTo(page, a)
    await collapse(page)
    await expect(page.getByTestId('keys-restore')).toHaveAttribute('data-attention', 'true', { timeout: 10_000 })
    void b

    // (7) Reload keeps it collapsed
    await page.reload()
    await waitFor(async () => (await hooks.sid(page)) !== null, 'reloaded')
    await expect(ek).toHaveAttribute('data-collapsed', 'true')
    await expect(page.getByTestId('keys-restore')).toBeVisible()
    await tapId(page, 'keys-restore')
    await expect(ek).not.toHaveAttribute('data-collapsed', 'true')

    // (8) Collapse from the text page, restore -> back on the text page
    await page.getByTestId('toggle-text').tap()
    await expect(ek).toHaveAttribute('data-page', 'text')
    const box = (await page.getByTestId('textinput').boundingBox())!
    await drag(page, box.x + 30, box.y + box.height / 2, 140)
    await expect(ek).toHaveAttribute('data-collapsed', 'true')
    await tapId(page, 'keys-restore')
    await expect(ek).not.toHaveAttribute('data-collapsed', 'true')
    await expect(ek).toHaveAttribute('data-page', 'text')
  })
})

test.describe('iPad Mini (touch)', () => {
  test.use(IPAD)

  test('E2E-52 (9) tablets collapse and restore the same way', async ({ page }) => {
    await agent.open(page)
    const ek = page.getByTestId('extrakeys')
    const before = await settled(page)
    await collapse(page)
    const collapsed = await settled(page)
    expect(collapsed.rows).toBeGreaterThan(before.rows)
    expect(collapsed.resizes - before.resizes).toBe(1)
    await tapId(page, 'keys-restore')
    await expect(ek).not.toHaveAttribute('data-collapsed', 'true')
  })
})
