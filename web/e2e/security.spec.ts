/**
 * E2E-15 Device management (AC-1.3 / AC-1.11)
 * E2E-16 Unauthenticated access (AC-1.7 / AC-1.8, plus AC-1.6 pairing rate limits)
 * E2E-17 PWA (AC-1.14)
 * E2E-46 Sign out this device (AC-1.22)
 */
import { expect, test } from '@playwright/test'

import { Agent, installWSControl, waitFor, waitOnline } from './harness'

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

test('E2E-15 device management: two devices; revoking device two disconnects it within 5s and returns it to pairing; revoke all logs out this device too', async ({ page, browser }) => {
  await agent.open(page)

  // (1) This device, current: true.
  const one = await page.evaluate(async () => (await (await fetch('/api/devices', { credentials: 'same-origin' })).json()) as { id: string; current: boolean }[])
  expect(one.length).toBe(1)
  expect(one[0]!.current).toBe(true)

  // (2) A second device.
  const ctx2 = await browser.newContext()
  const page2 = await ctx2.newPage()
  await page2.goto(await agent.newPairLink())
  await page2.waitForURL((u) => u.pathname === '/' && !u.hash, { timeout: 20_000 })
  await waitOnline(page2)

  const devices = await page.evaluate(async () => (await (await fetch('/api/devices', { credentials: 'same-origin' })).json()) as { id: string; current: boolean }[])
  expect(devices.length, 'two devices').toBe(2)
  // `current` marks the requesting device; the UI uses it to avoid revoking itself by mistake.
  expect(devices.filter((d) => d.current).length).toBe(1)

  // (3) Revoke device two from device one: its WebSocket drops within 5s, and the UI says it was
  // revoked and switches to the pairing page.
  const other = devices.find((d) => !d.current)!
  const start = Date.now()
  const status = await page.evaluate(async (id) => (await fetch(`/api/devices/${id}`, { method: 'DELETE', credentials: 'same-origin' })).status, other.id)
  expect(status).toBe(204)
  await expect(page2.getByTestId('revoked')).toContainText('This device has been revoked', { timeout: 15_000 })
  expect(Date.now() - start, 'disconnects within 5s of revocation (plus 1s measurement slack)').toBeLessThan(6000)
  await expect(page2.getByTestId('unpaired'), 'shows the pairing page').toBeVisible()
  await expect(page2.getByTestId('terminal')).toHaveCount(0)
  // Opened again later (a new tab, the PWA from the home screen), it still says why (AC-1.11).
  const again = await ctx2.newPage()
  await again.goto(agent.baseURL)
  await expect(again.getByTestId('revoked')).toContainText('This device has been revoked')

  // This device is unaffected.
  await waitOnline(page)
  await ctx2.close()

  // (5) Revoke all -> this device is logged out too.
  const all = await page.evaluate(async () => {
    const r = await fetch('/api/devices/revoke-all', { method: 'POST', credentials: 'same-origin' })
    return { status: r.status, body: await r.json() }
  })
  expect(all.status).toBe(200)
  expect(all.body.revoked).toBeGreaterThanOrEqual(1)
  await expect(page.getByTestId('revoked')).toBeVisible({ timeout: 15_000 })
  expect(await page.evaluate(async () => (await fetch('/api/devices', { credentials: 'same-origin' })).status)).toBe(401)
})

const wsUpgrade = {
  Connection: 'Upgrade',
  Upgrade: 'websocket',
  'Sec-WebSocket-Version': '13',
  'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
}

test('E2E-16 unauthenticated access: static pages load, API and WebSocket upgrade return 401, forged Origin returns 403, pairing is rate limited with 429', async ({ page, request }) => {
  // (1) Without a cookie the static page still loads and the frontend asks for pairing.
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('unpaired')).toBeVisible()

  // (2)
  expect((await request.get(`${agent.baseURL}/api/devices`)).status()).toBe(401)
  // (3) The WebSocket upgrade must be 401 too; this is the one most easily missed.
  expect((await request.get(`${agent.baseURL}/ws`, { headers: wsUpgrade })).status(), 'unauthenticated GET /ws must be 401').toBe(401)

  // (4) Forged Origin: blocked with 403 even with a valid cookie.
  await agent.pair(page)
  const cookieHeader = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ')
  const forged = await request.get(`${agent.baseURL}/ws`, { headers: { ...wsUpgrade, Cookie: cookieHeader, Origin: 'https://evil.com' } })
  expect(forged.status(), 'cross-site Origin must be 403').toBe(403)

  // (5) Wrong pairing codes: 5 per minute per IP, plus exponential backoff on consecutive failures
  // (1s, 2s, 4s, ...; auth-pairing.md "Rate limiting"). Retrying at the backoff intervals, the first
  // 5 get 401; the 6th falls in the same minute -> 429 + Retry-After.
  const post = (i: number) => request.post(`${agent.baseURL}/auth/pair`, { data: { code: `wrong-${i}` } })
  const waits = [0, 0, 1100, 2100, 4100, 8100]
  const codes: number[] = []
  for (let i = 0; i < 6; i++) {
    if (waits[i]) await page.waitForTimeout(waits[i]!)
    const r = await post(i)
    codes.push(r.status())
    if (r.status() === 429) expect(r.headers()['retry-after'], '429 must include Retry-After').toBeTruthy()
  }
  expect(codes, 'first 5 get 401, the 6th gets 429').toEqual([401, 401, 401, 401, 401, 429])

  // Retrying without waiting out the backoff also gets 429.
  const fast = await post(99)
  expect(fast.status()).toBe(429)
})

test('E2E-17 PWA: complete manifest, service worker registers, offline reload shows a clear status page, API and /ws are not cached', async ({ page, context }) => {
  await agent.open(page)

  // (1) Manifest.
  const manifest = await page.evaluate(async () => (await (await fetch('/manifest.json')).json()) as Record<string, unknown>)
  expect(manifest.display, 'PWA must be standalone, otherwise the address bar stays').toBe('standalone')
  expect(manifest.name).toBe('webterm')
  expect(manifest.start_url).toBe('/')
  expect(Array.isArray(manifest.icons) && (manifest.icons as unknown[]).length).toBeTruthy()

  // (2) The service worker registers and controls the page.
  await waitFor(async () => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length > 0), 'service worker registered', 20_000)
  await waitFor(() => page.evaluate(() => navigator.serviceWorker.controller !== null), 'service worker controls the page', 20_000)
  // Load once more while online: this time the static shell goes through the SW and gets cached.
  await page.reload()
  await waitOnline(page)
  await page.evaluate(() => fetch('/api/devices', { credentials: 'same-origin' }))
  await page.waitForTimeout(500)

  // (4) The cache holds no /api/*, /auth/* or /ws.
  const cached = await page.evaluate(async () => {
    const out: string[] = []
    for (const name of await caches.keys()) {
      const c = await caches.open(name)
      for (const req of await c.keys()) out.push(new URL(req.url).pathname)
    }
    return out
  })
  for (const p of cached) {
    expect(p.startsWith('/api/'), `service worker cached an API response: ${p}`).toBe(false)
    expect(p.startsWith('/auth/'), `service worker cached a pairing endpoint: ${p}`).toBe(false)
    expect(p === '/ws', 'service worker cached /ws').toBe(false)
  }
  // The static shell should be cached, or there would be no status page to show offline.
  expect(cached.some((p) => p === '/' || p.endsWith('.js')), `cache should hold the static shell: ${cached}`).toBe(true)

  // (3) Reload while offline -> a clear "cannot reach the agent" status page (not the browser's
  // default error page, and not pretending to work).
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByTestId('offline')).toContainText("Can't reach the agent")
  await expect(page.getByTestId('terminal')).toHaveCount(0)
  await context.setOffline(false)
})

test('E2E-46 sign out this device: asks first; revokes on the agent, clears local data, other tabs follow, the old cookie is dead', async ({ page, context, request }) => {
  await agent.open(page)
  await waitFor(async () => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length > 0), 'service worker registered', 20_000)

  // (1) A second tab of this device, and a stored preference.
  const tab2 = await context.newPage()
  await tab2.goto(agent.baseURL)
  await waitOnline(tab2)
  await page.getByTestId('open-settings').click()
  await page.getByTestId('theme-dark').click()
  expect(await page.evaluate(() => localStorage.getItem('webterm.theme'))).toBe('dark')
  const cookieHeader = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ')

  // (2) It asks first; Cancel changes nothing.
  await page.getByTestId('sign-out').click()
  await expect(page.getByTestId('settings')).toHaveCount(0)
  await expect(page.getByTestId('sign-out-confirm')).toBeVisible()
  await page.getByTestId('sign-out-cancel').click()
  await expect(page.getByTestId('sign-out-confirm')).toHaveCount(0)
  await waitOnline(page)

  // (3) Confirm: the pairing page says "Signed out", and nothing is left locally.
  await page.getByTestId('open-settings').click()
  await page.getByTestId('sign-out').click()
  const start = Date.now()
  await page.getByTestId('sign-out-ok').click()
  await expect(page.getByTestId('signed-out')).toBeVisible()
  await expect(page.getByTestId('terminal')).toHaveCount(0)
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('webterm.')))).toEqual([])
  await waitFor(async () => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length === 0), 'service worker unregistered')
  expect(await page.evaluate(async () => (await caches.keys()).length)).toBe(0)

  // (4) The device's other tab is cut off within 5 seconds.
  await expect(tab2.getByTestId('unpaired')).toBeVisible({ timeout: 15_000 })
  expect(Date.now() - start, 'other tab cut off within 5s (plus 1s measurement slack)').toBeLessThan(6000)

  // (5) The old cookie, copied before signing out, no longer works.
  expect((await request.get(`${agent.baseURL}/api/devices`, { headers: { Cookie: cookieHeader } })).status()).toBe(401)
  expect((await request.get(`${agent.baseURL}/ws`, { headers: { ...wsUpgrade, Cookie: cookieHeader } })).status()).toBe(401)

  // (6) Reloading stays on the pairing page.
  await page.reload()
  await expect(page.getByTestId('unpaired')).toBeVisible()
})

test('E2E-46 offline: signing out only says it can\'t yet; the device stays signed in', async ({ page }) => {
  const net = await installWSControl(page)
  await agent.open(page)
  await net.goOffline()
  await expect(page.getByTestId('conn-text')).toContainText('Reconnecting', { timeout: 20_000 })

  await page.getByTestId('open-settings').click()
  await page.getByTestId('sign-out').click()
  await expect(page.getByTestId('toast')).toContainText("can't sign out")
  await expect(page.getByTestId('sign-out-confirm')).toHaveCount(0)

  net.goOnline()
  await waitOnline(page, 40_000)
  expect(await page.evaluate(async () => (await fetch('/api/devices', { credentials: 'same-origin' })).status)).toBe(200)
})
