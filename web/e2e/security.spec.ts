/**
 * E2E-15 设备管理 —— AC-1.3 / AC-1.11
 * E2E-16 未认证访问 —— AC-1.7 / AC-1.8（含 AC-1.6 的配对限速）
 * E2E-17 PWA —— AC-1.14
 */
import { expect, test } from '@playwright/test'

import { Agent, waitFor, waitOnline } from './harness'

let agent: Agent
test.beforeEach(async () => {
  agent = await Agent.start()
})
test.afterEach(() => agent.stop())

test('E2E-15 设备管理：两台设备、吊销设备二 5 秒内断开并回到配对引导、一键吊销全部连自己也退出', async ({ page, browser }) => {
  await agent.open(page)

  // ① 当前设备，current: true
  const one = await page.evaluate(async () => (await (await fetch('/api/devices', { credentials: 'same-origin' })).json()) as { id: string; current: boolean }[])
  expect(one.length).toBe(1)
  expect(one[0]!.current).toBe(true)

  // ② 第二台设备
  const ctx2 = await browser.newContext()
  const page2 = await ctx2.newPage()
  await page2.goto(await agent.newPairLink())
  await page2.waitForURL((u) => u.pathname === '/' && !u.hash, { timeout: 20_000 })
  await waitOnline(page2)

  const devices = await page.evaluate(async () => (await (await fetch('/api/devices', { credentials: 'same-origin' })).json()) as { id: string; current: boolean }[])
  expect(devices.length, '应当有两台设备').toBe(2)
  // current 标出发起请求的那台，UI 靠它防止误踢自己
  expect(devices.filter((d) => d.current).length).toBe(1)

  // ③ 从设备一吊销设备二：它的 WebSocket 5 秒内断开，界面写明被吊销并换成配对引导页
  const other = devices.find((d) => !d.current)!
  const start = Date.now()
  const status = await page.evaluate(async (id) => (await fetch(`/api/devices/${id}`, { method: 'DELETE', credentials: 'same-origin' })).status, other.id)
  expect(status).toBe(204)
  await expect(page2.getByTestId('revoked')).toContainText('此设备已被吊销', { timeout: 15_000 })
  expect(Date.now() - start, '吊销后应当在 5 秒内断开（留 1 秒测量余量）').toBeLessThan(6000)
  await expect(page2.getByTestId('unpaired'), '跳到配对引导页').toBeVisible()
  await expect(page2.getByTestId('terminal')).toHaveCount(0)

  // 自己不受影响
  await waitOnline(page)
  await ctx2.close()

  // ⑤ 一键吊销全部 → 自己也退出
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

test('E2E-16 未认证访问：静态页可达、API 与 WebSocket 升级都 401、伪造 Origin 403、配对限速 429', async ({ page, request }) => {
  // ① 清了 Cookie 之后静态页仍然正常返回，前端显示"需要配对"
  await page.goto(agent.baseURL)
  await expect(page.getByTestId('unpaired')).toBeVisible()

  // ②
  expect((await request.get(`${agent.baseURL}/api/devices`)).status()).toBe(401)
  // ③ WebSocket 升级也必须 401 —— 这是最容易漏的一条
  expect((await request.get(`${agent.baseURL}/ws`, { headers: wsUpgrade })).status(), 'GET /ws 未认证必须 401').toBe(401)

  // ④ 伪造 Origin：带着有效 Cookie 也要被 403 挡住
  await agent.pair(page)
  const cookieHeader = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ')
  const forged = await request.get(`${agent.baseURL}/ws`, { headers: { ...wsUpgrade, Cookie: cookieHeader, Origin: 'https://evil.com' } })
  expect(forged.status(), '跨站 Origin 必须 403').toBe(403)

  // ⑤ 错误的配对码：5 次 / 分钟 / IP，连续失败另有指数退避（1s, 2s, 4s…，auth-pairing.md §限速）。
  // 按退避间隔重试，前 5 次都是 401；第 6 次落在同一分钟里 → 429 + Retry-After
  const post = (i: number) => request.post(`${agent.baseURL}/auth/pair`, { data: { code: `wrong-${i}` } })
  const waits = [0, 0, 1100, 2100, 4100, 8100]
  const codes: number[] = []
  for (let i = 0; i < 6; i++) {
    if (waits[i]) await page.waitForTimeout(waits[i]!)
    const r = await post(i)
    codes.push(r.status())
    if (r.status() === 429) expect(r.headers()['retry-after'], '429 必须带 Retry-After').toBeTruthy()
  }
  expect(codes, '前 5 次 401，第 6 次 429').toEqual([401, 401, 401, 401, 401, 429])

  // 退避期间连发同样是 429（不等退避就重试）
  const fast = await post(99)
  expect(fast.status()).toBe(429)
})

test('E2E-17 PWA：manifest 完整、SW 注册成功、断网刷新给明确状态页、不缓存 API 与 /ws', async ({ page, context }) => {
  await agent.open(page)

  // ① manifest
  const manifest = await page.evaluate(async () => (await (await fetch('/manifest.json')).json()) as Record<string, unknown>)
  expect(manifest.display, 'PWA 必须是 standalone，否则还是有地址栏').toBe('standalone')
  expect(manifest.name).toBe('webterm')
  expect(manifest.start_url).toBe('/')
  expect(Array.isArray(manifest.icons) && (manifest.icons as unknown[]).length).toBeTruthy()

  // ② Service Worker 注册成功并接管页面
  await waitFor(async () => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length > 0), 'Service Worker 注册成功', 20_000)
  await waitFor(() => page.evaluate(() => navigator.serviceWorker.controller !== null), 'SW 接管页面', 20_000)
  // 再加载一次（在线）：这一次的静态壳经过 SW，被缓存下来
  await page.reload()
  await waitOnline(page)
  await page.evaluate(() => fetch('/api/devices', { credentials: 'same-origin' }))
  await page.waitForTimeout(500)

  // ④ 缓存里没有任何 /api/*、/auth/*、/ws
  const cached = await page.evaluate(async () => {
    const out: string[] = []
    for (const name of await caches.keys()) {
      const c = await caches.open(name)
      for (const req of await c.keys()) out.push(new URL(req.url).pathname)
    }
    return out
  })
  for (const p of cached) {
    expect(p.startsWith('/api/'), `Service Worker 缓存了 API 响应: ${p}`).toBe(false)
    expect(p.startsWith('/auth/'), `Service Worker 缓存了配对接口: ${p}`).toBe(false)
    expect(p === '/ws', 'Service Worker 缓存了 /ws').toBe(false)
  }
  // 但静态壳应该被缓存了，否则离线时连状态页都给不出来
  expect(cached.some((p) => p === '/' || p.endsWith('.js')), `缓存里应当有静态壳：${cached}`).toBe(true)

  // ③ 断网后刷新 → 明确的「无法连接到 agent」状态页（不是浏览器默认错误页，也不假装能用）
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByTestId('offline')).toContainText('无法连接到 agent')
  await expect(page.getByTestId('terminal')).toHaveCount(0)
  await context.setOffline(false)
})
