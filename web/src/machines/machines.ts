/**
 * Several machines in one page (ADR-0062, session-ux.md §Machines): the logic without UI.
 *
 * A machine is an agent's origin. Machines on subdomains of the page's domain are on the
 * page's site, so the page talks to each directly and the browser sends that machine's own
 * `SameSite=Strict` cookie. The list lives here, in `localStorage`: addresses, not secrets.
 * The page's own machine is implied and never stored.
 */
import { safeGet, safeSet } from '../ui/prefs'

/** The parts of `location` that matter. */
export interface PageLoc {
  protocol: string
  hostname: string
  port: string
}

export const MACHINES_KEY = 'webterm.machines'
export const MACHINE_KEY = 'webterm.machine'

export type AddressError = 'invalid' | 'scheme' | 'ip' | 'page-ip' | 'other-site' | 'self' | 'duplicate'

export type Parsed = { origin: string } | { error: AddressError; message: string }

/** The page's own origin: what `location.origin` would be. */
export function pageOrigin(page: PageLoc): string {
  return `${page.protocol}//${page.hostname.toLowerCase()}${page.port ? `:${page.port}` : ''}`
}

function isDefaultPort(protocol: string, port: string): boolean {
  return (protocol === 'https:' && port === '443') || (protocol === 'http:' && port === '80')
}

function isIP(host: string): boolean {
  return host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host)
}

/** The last two labels: always part of the registrable domain, so differing ones mean another site. */
function lastTwo(host: string): string {
  return host.split('.').slice(-2).join('.')
}

function refuse(error: AddressError, page: PageLoc): Parsed {
  const message: Record<AddressError, string> = {
    invalid: 'Not an address',
    scheme: `Use ${page.protocol}// like this page`,
    ip: "IP addresses can't be added",
    'page-ip': 'This page is on an IP address; machines need a domain',
    'other-site': "Not on this page's domain",
    self: "That's this page's machine",
    duplicate: 'Already in the list',
  }
  return { error, message: message[error] }
}

/**
 * Turns what was typed into a machine's origin (ADR-0062 §3, AC-10.1): a host, `host:port`
 * or a URL; only scheme, host and port are kept. No port means the page's port. The scheme
 * is the page's. IP addresses, hosts certainly on another site (their last two labels
 * differ from the page's), the page's own origin and machines already listed are refused.
 */
export function parseAddress(input: string, page: PageLoc, existing: readonly string[]): Parsed {
  let rest = input.trim()
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(rest)
  if (scheme) {
    if (`${scheme[1]!.toLowerCase()}:` !== page.protocol) return refuse('scheme', page)
    rest = rest.slice(scheme[0].length)
  }
  rest = rest.split(/[/?#]/)[0] ?? ''
  if (rest === '' || rest.includes('@')) return refuse('invalid', page)
  let url: URL
  try {
    url = new URL(`${page.protocol}//${rest}`)
  } catch {
    return refuse('invalid', page)
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (host === '' || host.startsWith('.')) return refuse('invalid', page)
  if (isIP(host)) return refuse('ip', page)
  const pageHost = page.hostname.toLowerCase().replace(/\.$/, '')
  if (isIP(pageHost)) return refuse('page-ip', page)
  if (lastTwo(host) !== lastTwo(pageHost)) return refuse('other-site', page)
  // An explicit port the URL parser dropped is the scheme's default; none at all means the page's
  const explicit = /:\d+$/.test(rest)
  const port = explicit ? url.port : page.port
  const origin = `${page.protocol}//${host}${port && !isDefaultPort(page.protocol, port) ? `:${port}` : ''}`
  if (origin === pageOrigin(page)) return refuse('self', page)
  if (existing.includes(origin)) return refuse('duplicate', page)
  return { origin }
}

/** `host[:port]` of an origin, as rows show it. */
export function hostPort(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

/**
 * The names rows and the machine button show (AC-10.8): the first label of the host; when
 * two machines share it, both get the full host.
 */
export function machineNames(origins: readonly string[]): Map<string, string> {
  const hostOf = (o: string) => {
    try {
      return new URL(o).hostname
    } catch {
      return o
    }
  }
  const first = (o: string) => hostOf(o).split('.')[0] ?? o
  const count = new Map<string, number>()
  for (const o of origins) count.set(first(o), (count.get(first(o)) ?? 0) + 1)
  return new Map(origins.map((o) => [o, (count.get(first(o)) ?? 0) > 1 ? hostOf(o) : first(o)]))
}

const ORIGIN_RE = /^https?:\/\/[^/?#\s]+$/

/** The machines added on this device, in the order added; the page's own is never in it. */
export function readMachines(own: string): string[] {
  try {
    const v = JSON.parse(safeGet(MACHINES_KEY) ?? '[]') as unknown
    if (!Array.isArray(v)) return []
    const out: string[] = []
    for (const o of v) if (typeof o === 'string' && ORIGIN_RE.test(o) && o !== own && !out.includes(o)) out.push(o)
    return out
  } catch {
    return []
  }
}

export function writeMachines(list: readonly string[]): void {
  safeSet(MACHINES_KEY, JSON.stringify(list))
}

/** The machine used last, if it is one of `list`; otherwise the page's own. */
export function readCurrent(own: string, list: readonly string[]): string {
  const c = safeGet(MACHINE_KEY)
  return c && list.includes(c) ? c : own
}

export function writeCurrent(origin: string, own: string): void {
  if (origin === own) {
    try {
      localStorage.removeItem(MACHINE_KEY)
    } catch {
      /* storage unavailable */
    }
  } else safeSet(MACHINE_KEY, origin)
}
