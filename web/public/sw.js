/**
 * webterm Service Worker。
 *
 * 【只缓存静态壳】（HTML/JS/CSS/字体），策略 stale-while-revalidate。
 *
 * 绝不缓存任何终端数据或 API 响应：
 *   · 终端输出不落盘是产品的铁律（不变式 3），缓存等于落盘
 *   · /api/* 的响应带着设备与认证信息，缓存它等于把隐私摊在磁盘上
 *   · /ws 根本不该经过这里
 *
 * 见 docs/40-frontend/layout.md §PWA。
 */

const CACHE = 'webterm-shell-v1'

self.addEventListener('install', (event) => {
  // 新版本立刻可用；页面侧会提示"有更新 · 刷新"，但【不自动刷新】——
  // 那会打断正在进行的会话
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== CACHE) await caches.delete(key)
      }
      await self.clients.claim()
    })(),
  )
})

/** 只有静态壳走缓存。 */
function isShell(url) {
  if (url.origin !== self.location.origin) return false
  if (url.pathname.startsWith('/api/')) return false
  if (url.pathname.startsWith('/auth/')) return false
  if (url.pathname === '/ws') return false
  if (url.pathname === '/healthz') return false
  return true
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (!isShell(url)) return // 交给网络，一个字节都不留

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)
      const cached = await cache.match(req)
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone())
          return res
        })
        .catch(() => null)

      if (cached) {
        void network // stale-while-revalidate：先给旧的，后台更新
        return cached
      }
      const fresh = await network
      if (fresh) return fresh

      // 离线且没缓存：给一个明确的状态页，不假装能用
      if (req.mode === 'navigate') {
        const shell = await cache.match('/index.html')
        if (shell) return shell
      }
      return new Response('无法连接到 agent。', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    })(),
  )
})
