/**
 * webterm Service Worker.
 *
 * Caches only the static shell (HTML/JS/CSS/fonts), stale-while-revalidate.
 *
 * Never caches terminal data or API responses:
 *   · terminal output never touches disk (invariant 3), and caching is writing to disk
 *   · /api/* responses carry device and auth data; caching them puts private data on disk
 *   · /ws must never pass through here at all
 *
 * See docs/40-frontend/layout.md §PWA.
 */

const CACHE = 'webterm-shell-v1'

self.addEventListener('install', (event) => {
  // Activate new versions immediately, but never reload the page automatically;
  // that would interrupt running sessions
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

/** Only the static shell is cached. */
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
  if (!isShell(url)) return // Straight to the network; keep nothing

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
        void network // stale-while-revalidate: serve the cached copy, update in the background
        return cached
      }
      const fresh = await network
      if (fresh) return fresh

      // Offline and not cached: return a clear status instead of pretending to work
      if (req.mode === 'navigate') {
        const shell = await cache.match('/index.html')
        if (shell) return shell
      }
      return new Response("Can't reach the agent", {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    })(),
  )
})
