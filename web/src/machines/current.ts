/**
 * The machine the page talks to right now (ADR-0062 §7). Every request and the WebSocket
 * go through here. The page's own machine keeps relative URLs, exactly as before; another
 * machine gets its origin in front. Requests carry `credentials: 'include'`, which on the
 * own machine is the same as `same-origin` and elsewhere sends that machine's own cookie.
 */

let base = ''

/** Points requests at `origin`; the page's own origin means relative URLs. */
export function setMachineBase(origin: string): void {
  base = origin === location.origin ? '' : origin
}

/** The URL of `path` (`/api/…`, `/auth/…`) on the current machine. */
export function apiURL(path: string): string {
  return base + path
}

/** The current machine's WebSocket endpoint. */
export function wsURL(): string {
  return `${(base || location.origin).replace(/^http/, 'ws')}/ws`
}
