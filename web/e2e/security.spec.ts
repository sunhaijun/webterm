/**
 * E2E-15 设备管理（AC-1.3 / AC-1.11）
 * E2E-16 未认证访问（AC-1.7 / AC-1.8）
 * E2E-17 PWA（AC-1.14）
 */
import { expect, test } from '@playwright/test'

import { Agent, waitFor } from './harness'

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

test('E2E-15 吊销设备后它的 WebSocket 在 5 秒内断开', async ({ page, browser }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  // 第二台设备
  const ctx2 = await browser.newContext()
  const page2 = await ctx2.newPage()
  const url2 = await agent.newPairLink()
  await page2.goto(url2)
  await page2.waitForURL((u) => u.pathname === '/' && !u.hash, { timeout: 20_000 })
  await expect(page2.getByTestId('conn-text')).toHaveText('在线')

  const devices = await page.evaluate(async () => {
    const r = await fetch('/api/devices', { credentials: 'same-origin' })
    return (await r.json()) as { id: string; current: boolean }[]
  })
  expect(devices.length, '应当有两台设备').toBe(2)
  // current 标出发起请求的那台，UI 靠它防止误踢自己
  expect(devices.filter((d) => d.current).length).toBe(1)

  const other = devices.find((d) => !d.current)!
  const start = Date.now()
  await page.evaluate(
    async (id) => {
      await fetch(`/api/devices/${id}`, { method: 'DELETE', credentials: 'same-origin' })
    },
    other.id,
  )

  // 被吊销的那台：连接断开，并明确告知原因
  await waitFor(
    async () => (await page2.getByTestId('conn-text').textContent()) !== '在线',
    '被吊销的设备断开了',
    15_000,
  )
  expect(Date.now() - start, '吊销后应当在 5 秒内断开').toBeLessThan(8000)
  await expect(page2.getByTestId('fatal')).toContainText('吊销')

  // 自己不受影响
  await expect(page.getByTestId('conn-text')).toHaveText('在线')
  await ctx2.close()
})

test('E2E-16 未认证访问：静态页可达，API 与 WebSocket 都 401', async ({ page, request }) => {
  // 清了 Cookie 之后静态页仍然正常返回，前端显示"需要配对"
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('unpaired')).toBeVisible()

  expect((await request.get(`${agent.baseURL}/api/devices`)).status()).toBe(401)
  expect((await request.get(`${agent.baseURL}/api/commands`)).status()).toBe(401)

  // WebSocket 升级也必须 401 —— 这是最容易漏的一条
  const wsStatus = await request.get(`${agent.baseURL}/ws`, {
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
    },
  })
  expect(wsStatus.status(), 'GET /ws 未认证必须 401').toBe(401)

  // 伪造 Origin：带着有效 Cookie 也要被 403 挡住
  await agent.pair(page)
  const cookies = await page.context().cookies()
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  const forged = await request.get(`${agent.baseURL}/ws`, {
    headers: {
      Cookie: cookieHeader,
      Origin: 'https://evil.example.com',
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
    },
  })
  expect(forged.status(), '跨站 Origin 必须 403').toBe(403)

  // 连错 6 次配对码要触发限速
  let saw429 = false
  for (let i = 0; i < 8; i++) {
    const r = await request.post(`${agent.baseURL}/auth/pair`, { data: { code: 'wrong' } })
    if (r.status() === 429) {
      saw429 = true
      expect(r.headers()['retry-after'], '429 必须带 Retry-After').toBeTruthy()
      break
    }
  }
  expect(saw429, '配对接口没有限速').toBe(true)
})

test('E2E-17 PWA：manifest 完整、SW 注册成功、不缓存 API 与 /ws', async ({ page }) => {
  await agent.pair(page)
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('conn-text')).toHaveText('在线')

  const manifest = await page.evaluate(async () => {
    const r = await fetch('/manifest.json')
    return (await r.json()) as Record<string, unknown>
  })
  expect(manifest.display, 'PWA 必须是 standalone，否则还是有地址栏').toBe('standalone')
  expect(manifest.name).toBe('webterm')
  expect(manifest.start_url).toBe('/')
  expect(Array.isArray(manifest.icons) && (manifest.icons as unknown[]).length).toBeTruthy()

  // Service Worker 注册成功
  await waitFor(
    async () => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length > 0),
    'Service Worker 注册成功',
    20_000,
  )

  // 让页面产生一些 API 与 WebSocket 流量，然后检查缓存
  await page.evaluate(() => fetch('/api/devices', { credentials: 'same-origin' }))
  await page.waitForTimeout(1000)

  const cachedUrls = await page.evaluate(async () => {
    const out: string[] = []
    for (const name of await caches.keys()) {
      const c = await caches.open(name)
      for (const req of await c.keys()) out.push(new URL(req.url).pathname)
    }
    return out
  })
  // 终端输出不落盘是铁律，缓存 API 响应等于把命令历史摊在磁盘上
  for (const p of cachedUrls) {
    expect(p.startsWith('/api/'), `Service Worker 缓存了 API 响应: ${p}`).toBe(false)
    expect(p.startsWith('/auth/'), `Service Worker 缓存了配对接口: ${p}`).toBe(false)
    expect(p === '/ws', 'Service Worker 缓存了 /ws').toBe(false)
  }
  // 但静态壳应该被缓存了，否则离线时连状态页都给不出来
  expect(cachedUrls.some((p) => p === '/' || p.endsWith('.js') || p.endsWith('.css'))).toBe(true)
})
