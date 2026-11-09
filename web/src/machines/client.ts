/**
 * Talking to a machine that isn't the current one (ADR-0062 §3, §10, §13): pairing with it,
 * signing out of it, checking it. `fetch` is a parameter so tests can stand in for it.
 */
import { hostPort } from './machines'

type Fetch = (input: string, init?: RequestInit) => Promise<Pick<Response, 'status' | 'json'>>

const real: Fetch = (input, init) => fetch(input, init)

async function body(r: Pick<Response, 'json'>): Promise<{ code?: string; message?: string }> {
  try {
    return ((await r.json()) as { code?: string; message?: string }) ?? {}
  } catch {
    return {}
  }
}

/**
 * Pairs this device with `origin` using its 16 digits. Resolves to null when paired (the
 * machine's cookie is now in the browser's jar), or to the line `machine-error` shows.
 *
 * A request that gets no response at all is either a machine that can't be reached or one
 * that refused the preflight (an older webterm, or another site): a `no-cors` request to
 * `/healthz` tells them apart, since it needs no CORS to succeed (AC-10.13).
 */
export async function pairWith(origin: string, digits: string, f: Fetch = real): Promise<string | null> {
  let r: Pick<Response, 'status' | 'json'>
  try {
    r = await f(`${origin}/auth/pair`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: digits }),
    })
  } catch {
    try {
      await f(`${origin}/healthz`, { mode: 'no-cors', cache: 'no-store' })
      return `${hostPort(origin)} refused this page`
    } catch {
      return `Can't reach ${hostPort(origin)}`
    }
  }
  if (r.status === 200) return null
  if (r.status === 429) return 'Too many attempts. Try again later'
  const b = await body(r)
  if (b.code === 'cross_site') return "Not on this page's domain"
  if (r.status === 401) return 'Invalid or expired pairing code'
  return b.message ?? `${hostPort(origin)} answered HTTP ${r.status}`
}

/**
 * Signs this device out of `origin` (`POST /auth/logout`): `done` on 204 or 401 (not
 * signed in there either way), `unreachable` when no response came back, `failed` for
 * anything else.
 */
export async function leave(origin: string, f: Fetch = real): Promise<'done' | 'unreachable' | 'failed'> {
  try {
    const r = await f(`${origin}/auth/logout`, { method: 'POST', credentials: 'include' })
    return r.status === 204 || r.status === 401 ? 'done' : 'failed'
  } catch {
    return 'unreachable'
  }
}

export type Check = 'ok' | 'unpaired' | 'revoked' | 'unreachable'

/** Whether this device can use `base` (`''` = the page's own machine): `GET /api/devices`. */
export async function check(base: string, f: Fetch = real): Promise<Check> {
  try {
    const r = await f(`${base}/api/devices`, { credentials: 'include' })
    if (r.status !== 401) return 'ok'
    return (await body(r)).code === 'revoked' ? 'revoked' : 'unpaired'
  } catch {
    return 'unreachable'
  }
}
