/**
 * E2E-56 Several machines (AC-10.6–AC-10.12, ADR-0062).
 *
 * Two dev agents, A and B. The page is opened at `http://a.test.localhost:<A>`: Chromium
 * resolves every `*.localhost` to the loopback address, and the site of `a.test.localhost` and
 * `b.test.localhost` is `test.localhost`, so A and B are two machines on one site, as two
 * subdomains of one domain are in production. B has its own HOME with files only it has.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { devices, expect, test, type Page } from '@playwright/test'

import { Agent, focusTerm, hooks, submit, waitFor, waitOnline, waitText } from './harness'

/** A 1×1 PNG. */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4810000000049454e44ae426082', 'hex')

let A: Agent
let B: Agent
let bHome: string

test.beforeEach(async () => {
  bHome = mkdtempSync(join(tmpdir(), 'webterm-e2e-b-home-'))
  writeFileSync(join(bHome, 'only-on-b.txt'), 'b\n')
  writeFileSync(join(bHome, 'pic.png'), PNG)
  A = await Agent.start()
  B = await Agent.start({ home: bHome })
})
test.afterEach(() => {
  A.stop()
  B.stop()
})

const aHost = () => `a.test.localhost:${A.port}`
const bHost = () => `b.test.localhost:${B.port}`
const bOrigin = () => `http://${bHost()}`

/** Pairs the page with A at a.test.localhost and waits for its first session. */
async function openOnA(page: Page): Promise<void> {
  await page.goto(A.pairLink().replace('127.0.0.1', 'a.test.localhost'))
  await page.waitForURL((u) => u.pathname === '/' && !u.hash, { timeout: 20_000 })
  await waitOnline(page)
  await waitFor(async () => (await hooks.sid(page)) !== null, 'first session on A')
}

async function openMachines(page: Page): Promise<void> {
  if ((await hooks.form(page)) === 'compact' && !(await page.getByTestId('session-drawer').count())) await page.getByTestId('open-sessions').click()
  await page.getByTestId('machine-button').click()
  await expect(page.getByTestId('machines-sheet')).toBeVisible()
}

const rows = (page: Page) => page.getByTestId('machine-row')
const row = (page: Page, origin: string) => page.locator(`[data-testid=machine-row][data-origin="${origin}"]`)

/** Opens the Add sheet and fills it in; the caller clicks Add. */
async function fillAdd(page: Page, address: string, digits: string): Promise<void> {
  if (!(await page.getByTestId('machine-add-sheet').count())) {
    await openMachines(page)
    await page.getByTestId('machine-add').click()
  }
  await page.getByTestId('machine-address').fill(address)
  await page.getByTestId('machine-code').fill(digits)
}

/** The current machine's name on the machine button; on compact it is the session drawer's title. */
async function expectMachine(page: Page, name: string): Promise<void> {
  if ((await hooks.form(page)) !== 'compact') {
    await expect(page.getByTestId('machine-button')).toHaveText(name)
    return
  }
  if (!(await page.getByTestId('session-drawer').count())) await page.getByTestId('open-sessions').click()
  await expect(page.getByTestId('session-drawer').getByTestId('machine-button')).toHaveText(name)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('session-drawer')).toHaveCount(0)
}

async function addB(page: Page): Promise<void> {
  await fillAdd(page, bHost(), await B.newPairDigits())
  await page.getByTestId('machine-add-ok').click()
  await expect(page.getByTestId('machine-add-sheet')).toHaveCount(0)
  await expectMachine(page, 'b')
  await waitOnline(page)
  await waitFor(async () => (await hooks.sid(page)) !== null, 'a session on B')
}

async function pick(page: Page, origin: string, name: string): Promise<void> {
  await openMachines(page)
  await row(page, origin).click()
  await expect(page.getByTestId('machines-sheet')).toHaveCount(0)
  await expectMachine(page, name)
  await waitOnline(page)
}

/** The page's WebSockets, open or closed. */
function recordSockets(page: Page) {
  const list: { url: string; closed: boolean }[] = []
  page.on('websocket', (ws) => {
    const rec = { url: ws.url(), closed: false }
    list.push(rec)
    ws.on('close', () => (rec.closed = true))
  })
  return list
}

/** The cookies of one host, as a Cookie header. */
async function cookieOf(page: Page, host: string): Promise<string> {
  return (await page.context().cookies(`http://${host}`)).map((c) => `${c.name}=${c.value}`).join('; ')
}

test('E2E-56 (1)–(4) adding a machine, switching both ways, its files, and where the page opens', async ({ page }) => {
  const sockets = recordSockets(page)
  await openOnA(page)
  await focusTerm(page)
  await submit(page, 'echo A-MARK')
  await waitText(page, 'A-MARK')

  // (1) One machine so far, current; the button is the tab bar's first item on wide (8)
  await expect(page.getByTestId('machine-button')).toHaveText('a')
  expect(await page.locator('.topbar > :first-child').getAttribute('data-testid')).toBe('machine-button')
  await openMachines(page)
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page).first()).toHaveAttribute('aria-current', 'true')
  await page.getByTestId('machine-add').click()
  await expect(page.getByTestId('machine-add-ok')).toBeDisabled()

  const good = await B.newPairDigits()
  await fillAdd(page, `127.0.0.1:${B.port}`, good)
  await page.getByTestId('machine-add-ok').click()
  await expect(page.getByTestId('machine-error')).toHaveText("IP addresses can't be added")
  await fillAdd(page, `b.other.localhost:${B.port}`, good)
  await page.getByTestId('machine-add-ok').click()
  await expect(page.getByTestId('machine-error')).toHaveText("Not on this page's domain")
  await fillAdd(page, bHost(), '0000-0000-0000-0000')
  await page.getByTestId('machine-add-ok').click()
  await expect(page.getByTestId('machine-error')).toHaveText('Invalid or expired pairing code')
  await expect(page.getByTestId('machine-address')).toHaveValue(bHost())

  await page.getByTestId('machine-code').fill(good)
  await page.getByTestId('machine-add-ok').click()
  await expect(page.getByTestId('machine-add-sheet')).toHaveCount(0)
  await expect(page.getByTestId('machines-sheet')).toHaveCount(0)
  await expect(page.getByTestId('machine-button')).toHaveText('b')
  await waitOnline(page)
  await waitFor(async () => (await hooks.sid(page)) !== null, 'a session on B')
  await waitFor(async () => sockets.some((s) => s.url === `ws://${bHost()}/ws` && !s.closed), 'a WebSocket to B')
  expect(sockets.filter((s) => s.url.includes(aHost())).every((s) => s.closed), 'the WebSocket to A is closed').toBe(true)
  await focusTerm(page)
  await submit(page, 'echo "HOME=$HOME"')
  await waitText(page, `HOME=${bHome}`)

  // (2) Back to A: its session, its output
  await pick(page, `http://${aHost()}`, 'a')
  await waitText(page, 'A-MARK')
  await openMachines(page)
  expect(await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-origin')))).toEqual([`http://${aHost()}`, bOrigin()])
  await expect(rows(page).nth(1)).toContainText('b')
  await expect(rows(page).nth(1)).toContainText(bHost())
  await page.keyboard.press('Escape')

  // (3) B's files, previews loaded from B
  await pick(page, bOrigin(), 'b')
  await page.getByTestId('open-files').click()
  await expect(page.locator('[data-testid=files-row][data-name="only-on-b.txt"]')).toBeVisible()
  await page.locator('[data-testid=files-row][data-name="pic.png"]').click()
  const img = page.getByTestId('file-image')
  await expect(img).toHaveAttribute('src', new RegExp(`^${bOrigin()}/api/fs/raw`))
  await waitFor(async () => (await img.evaluate((e) => (e as HTMLImageElement).naturalWidth)) > 0, 'the image from B loaded')

  // (4) A reload opens on the machine used last; with it down, on the page's own
  await page.reload()
  await expect(page.getByTestId('machine-button')).toHaveText('b')
  await waitOnline(page)
  await B.halt()
  await page.reload()
  await expect(page.getByTestId('machine-button')).toHaveText('a')
  await waitOnline(page)
  await waitText(page, 'A-MARK')
  await B.resume()
})

test('E2E-56 (5)–(6) signed out on a machine; removing one, reachable or not', async ({ page, request }) => {
  await openOnA(page)
  await addB(page)

  // (5) B revokes the device: back on A with Add open for B
  await B.revokeAll()
  await expect(page.getByTestId('machine-add-sheet')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('machine-address')).toHaveValue(bHost())
  await expect(page.getByTestId('machine-error')).toHaveText('This device was revoked on b')
  await expect(page.getByTestId('machine-button')).toHaveText('a')
  await page.getByTestId('machine-code').fill(await B.newPairDigits())
  await page.getByTestId('machine-add-ok').click()
  await expect(page.getByTestId('machine-button')).toHaveText('b')
  await waitOnline(page)

  // (6) Remove B from A: signed out there, no Clear-Site-Data to this page, A untouched
  await pick(page, `http://${aHost()}`, 'a')
  const bCookie = await cookieOf(page, bHost())
  const aCookie = await cookieOf(page, aHost())
  expect(bCookie).toContain('webterm_session=')
  await openMachines(page)
  await row(page, bOrigin()).click({ button: 'right' })
  const logout = page.waitForResponse((r) => r.url() === `${bOrigin()}/auth/logout`)
  await page.getByTestId('machine-row-remove').click()
  const res = await logout
  expect(res.status()).toBe(204)
  expect((await res.allHeaders())['clear-site-data']).toBeUndefined()
  await expect(rows(page)).toHaveCount(1)
  expect((await request.get(`${B.baseURL}/api/devices`, { headers: { Cookie: bCookie } })).status()).toBe(401)
  expect(await cookieOf(page, aHost())).toBe(aCookie)
  await page.keyboard.press('Escape')
  await waitOnline(page)

  // Unreachable: asks; Cancel keeps it, Remove drops it
  await addB(page)
  await pick(page, `http://${aHost()}`, 'a')
  await B.halt()
  await openMachines(page)
  await row(page, bOrigin()).click({ button: 'right' })
  await page.getByTestId('machine-row-remove').click()
  await expect(page.getByTestId('machine-remove-confirm')).toBeVisible()
  await expect(page.getByTestId('machine-remove-confirm')).toContainText("Can't reach b. Remove it anyway?")
  await page.getByTestId('machine-remove-cancel').click()
  await expect(rows(page)).toHaveCount(2)
  await row(page, bOrigin()).click({ button: 'right' })
  await page.getByTestId('machine-row-remove').click()
  await page.getByTestId('machine-remove-ok').click()
  await expect(rows(page)).toHaveCount(1)
  expect(await page.evaluate(() => localStorage.getItem('webterm.machines'))).toBe('[]')
})

test('E2E-56 (7) signing out of the device signs out of every machine', async ({ page, request }) => {
  await openOnA(page)
  await addB(page)
  const bCookie = await cookieOf(page, bHost())
  const aCookie = await cookieOf(page, aHost())
  const order: string[] = []
  const headers: Record<string, string | undefined> = {}
  const read: Promise<void>[] = []
  page.on('response', (r) => {
    if (!r.url().endsWith('/auth/logout')) return
    const host = new URL(r.url()).host
    order.push(host)
    // headers() leaves out security headers such as Clear-Site-Data; allHeaders() has them
    read.push(r.allHeaders().then((h) => void (headers[host] = h['clear-site-data'])))
  })

  await page.getByTestId('open-settings').click()
  await page.getByTestId('sign-out').click()
  await page.getByTestId('sign-out-ok').click()
  await expect(page.getByTestId('signed-out')).toBeVisible()
  await expect(page.getByTestId('signed-out-left')).toHaveCount(0)
  expect(order).toEqual([bHost(), aHost()])
  await Promise.all(read)
  expect(headers[bHost()]).toBeUndefined()
  expect(headers[aHost()]).toContain('"storage"')
  expect(headers[aHost()]).toContain('"cache"')
  expect(headers[aHost()]).not.toContain('"cookies"')
  expect((await request.get(`${B.baseURL}/api/devices`, { headers: { Cookie: bCookie } })).status()).toBe(401)
  expect((await request.get(`${A.baseURL}/api/devices`, { headers: { Cookie: aCookie } })).status()).toBe(401)
})

test('E2E-56 (7) a machine that cannot be reached is named on the signed-out page', async ({ page }) => {
  await openOnA(page)
  await addB(page)
  await pick(page, `http://${aHost()}`, 'a')
  await B.halt()
  await page.getByTestId('open-settings').click()
  await page.getByTestId('sign-out').click()
  await page.getByTestId('sign-out-ok').click()
  await expect(page.getByTestId('signed-out')).toBeVisible()
  await expect(page.getByTestId('signed-out-left')).toContainText(bHost())
})

test.describe('phone', () => {
  const { defaultBrowserType: _p, ...PIXEL } = devices['Pixel 5']!
  test.use(PIXEL)

  test('E2E-56 (8) the drawer title is the machine button; a text-page draft survives switching (2)', async ({ page }) => {
    await openOnA(page)
    await page.getByTestId('open-sessions').tap()
    await expect(page.getByTestId('session-drawer').getByTestId('machine-button')).toHaveText('a')
    await page.getByTestId('machine-button').tap()
    await expect(page.getByTestId('machines-sheet')).toBeVisible()
    await page.getByTestId('machine-add').tap()
    await page.getByTestId('machine-address').fill(bHost())
    await page.getByTestId('machine-code').fill(await B.newPairDigits())
    await page.getByTestId('machine-add-ok').tap()
    await expectMachine(page, 'b')
    await waitOnline(page)
    await waitFor(async () => (await hooks.sid(page)) !== null, 'a session on B')

    await page.getByTestId('toggle-text').tap()
    await page.getByTestId('textinput').fill('draft on b')
    await pick(page, `http://${aHost()}`, 'a')
    await pick(page, bOrigin(), 'b')
    await waitFor(async () => (await hooks.sid(page)) !== null, 'B session back')
    await expect(page.getByTestId('toggle-text')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('textinput')).toHaveValue('draft on b')
  })
})
