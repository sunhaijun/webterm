/** Several machines in one page (ADR-0062): addresses, names, the stored list, and the requests to other machines. */
import { afterEach, describe, expect, it } from 'vitest'

import { check, leave, pairWith } from '../src/machines/client'
import {
  MACHINES_KEY,
  MACHINE_KEY,
  hostPort,
  machineNames,
  pageOrigin,
  parseAddress,
  readCurrent,
  readMachines,
  writeCurrent,
  writeMachines,
} from '../src/machines/machines'

const page = { protocol: 'https:', hostname: 'tokyo.example.com', port: '8443' }
const page443 = { protocol: 'https:', hostname: 'tokyo.example.com', port: '' }
const origin = (s: string) => {
  const r = parseAddress(s, page, [])
  return 'origin' in r ? r.origin : r.error
}

describe('UT-machines-1 parseAddress (AC-10.1)', () => {
  it('accepts a host, host:port or a URL and keeps scheme, host and port', () => {
    for (const s of [
      'la.example.com',
      'la.example.com:8443',
      'https://la.example.com:8443',
      'https://la.example.com:8443/pair?x#y',
      '  LA.Example.COM.  ',
      'la.example.com/',
    ]) {
      expect(origin(s), s).toBe('https://la.example.com:8443')
    }
  })
  it('no port means the page port; a default port is left out', () => {
    expect(parseAddress('la.example.com', page443, [])).toEqual({ origin: 'https://la.example.com' })
    expect(origin('la.example.com:443')).toBe('https://la.example.com')
    expect(origin('la.example.com:9443')).toBe('https://la.example.com:9443')
    expect(origin('a.b.example.com')).toBe('https://a.b.example.com:8443')
    expect(origin('example.com')).toBe('https://example.com:8443')
  })
  it('refuses what cannot be a machine on this page', () => {
    expect(origin('')).toBe('invalid')
    expect(origin('   ')).toBe('invalid')
    expect(origin('user@la.example.com')).toBe('invalid')
    expect(origin('la exa.com')).toBe('invalid')
    expect(origin('http://la.example.com')).toBe('scheme')
    expect(origin('ftp://la.example.com')).toBe('scheme')
    expect(origin('203.0.113.5')).toBe('ip')
    expect(origin('203.0.113.5:8443')).toBe('ip')
    expect(origin('[2001:db8::1]:8443')).toBe('ip')
    expect(origin('la.example.org')).toBe('other-site')
    expect(origin('example.org')).toBe('other-site')
    expect(origin('tokyo.example.com')).toBe('self')
    expect(origin('https://tokyo.example.com:8443/')).toBe('self')
    expect(parseAddress('la.example.com', page, ['https://la.example.com:8443'])).toMatchObject({ error: 'duplicate' })
    expect(parseAddress('la.example.com', { protocol: 'https:', hostname: '203.0.113.5', port: '' }, [])).toMatchObject({ error: 'page-ip' })
  })
  it('gives each refusal a line to show', () => {
    expect(parseAddress('203.0.113.5', page, [])).toEqual({ error: 'ip', message: "IP addresses can't be added" })
    expect(parseAddress('la.example.org', page, [])).toEqual({ error: 'other-site', message: "Not on this page's domain" })
    expect(parseAddress('http://la.example.com', page, [])).toMatchObject({ message: 'Use https:// like this page' })
  })
  it('works for dev hosts under *.localhost', () => {
    const dev = { protocol: 'http:', hostname: 'a.test.localhost', port: '4000' }
    expect(parseAddress('b.test.localhost:5000', dev, [])).toEqual({ origin: 'http://b.test.localhost:5000' })
    expect(parseAddress('b.other.localhost:5000', dev, [])).toMatchObject({ error: 'other-site' })
    expect(parseAddress('127.0.0.1:5000', dev, [])).toMatchObject({ error: 'ip' })
  })
  it('pageOrigin matches location.origin', () => {
    expect(pageOrigin(page)).toBe('https://tokyo.example.com:8443')
    expect(pageOrigin(page443)).toBe('https://tokyo.example.com')
  })
})

describe('UT-machines-3 names (AC-10.8)', () => {
  it('the first label, or the full host when two share it', () => {
    const names = machineNames(['https://tokyo.example.com:8443', 'https://la.example.com:8443', 'https://web.a.example.com', 'https://web.b.example.com'])
    expect([...names.values()]).toEqual(['tokyo', 'la', 'web.a.example.com', 'web.b.example.com'])
  })
  it('hostPort shows a non-default port only', () => {
    expect(hostPort('https://la.example.com:8443')).toBe('la.example.com:8443')
    expect(hostPort('https://la.example.com')).toBe('la.example.com')
  })
})

describe('UT-machines-4 the stored list and the machine used last (AC-10.9)', () => {
  const own = 'https://tokyo.example.com:8443'
  afterEach(() => localStorage.clear())
  it('round-trips in the order added, without the own machine or junk', () => {
    writeMachines(['https://la.example.com:8443', 'https://fra.example.com:8443'])
    expect(readMachines(own)).toEqual(['https://la.example.com:8443', 'https://fra.example.com:8443'])
    localStorage.setItem(MACHINES_KEY, JSON.stringify([own, 'https://la.example.com:8443', 42, 'javascript:alert(1)', 'https://la.example.com:8443', 'https://x/y']))
    expect(readMachines(own)).toEqual(['https://la.example.com:8443'])
    localStorage.setItem(MACHINES_KEY, '{not json')
    expect(readMachines(own)).toEqual([])
  })
  it('the machine used last only if it is still listed; the own one is not stored', () => {
    const list = ['https://la.example.com:8443']
    expect(readCurrent(own, list)).toBe(own)
    writeCurrent('https://la.example.com:8443', own)
    expect(readCurrent(own, list)).toBe('https://la.example.com:8443')
    expect(readCurrent(own, [])).toBe(own)
    writeCurrent(own, own)
    expect(localStorage.getItem(MACHINE_KEY)).toBeNull()
  })
})

type Reply = { status: number; body?: unknown } | 'network'
function fakeFetch(replies: Record<string, Reply>) {
  const calls: { url: string; init?: RequestInit }[] = []
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const r = replies[url]
    if (!r || r === 'network') throw new TypeError('Failed to fetch')
    return { status: r.status, json: async () => r.body ?? {} }
  }
  return { f, calls }
}

describe('UT-machines-2 requests to another machine (AC-10.7, AC-10.13)', () => {
  const la = 'https://la.example.com:8443'
  it('pairs with credentials and the digits', async () => {
    const { f, calls } = fakeFetch({ [`${la}/auth/pair`]: { status: 200 } })
    expect(await pairWith(la, '1234567812345678', f)).toBeNull()
    expect(calls[0]!.init).toMatchObject({ method: 'POST', credentials: 'include', body: JSON.stringify({ code: '1234567812345678' }) })
  })
  it('says why pairing failed', async () => {
    const say = async (r: Reply, health: Reply = 'network') => pairWith(la, '1', fakeFetch({ [`${la}/auth/pair`]: r, [`${la}/healthz`]: health }).f)
    expect(await say({ status: 401, body: { code: 'invalid_code', message: 'Invalid or expired pairing code' } })).toBe('Invalid or expired pairing code')
    expect(await say({ status: 429 })).toBe('Too many attempts. Try again later')
    expect(await say({ status: 403, body: { code: 'cross_site' } })).toBe("Not on this page's domain")
    expect(await say('network', { status: 0 })).toBe('la.example.com:8443 refused this page')
    expect(await say('network', 'network')).toBe("Can't reach la.example.com:8443")
    expect(await say({ status: 500, body: {} })).toBe('la.example.com:8443 answered HTTP 500')
  })
  it('probes /healthz without CORS', async () => {
    const { f, calls } = fakeFetch({ [`${la}/healthz`]: { status: 0 } })
    await pairWith(la, '1', f)
    expect(calls[1]).toMatchObject({ url: `${la}/healthz`, init: { mode: 'no-cors' } })
  })
  it('signing out of a machine', async () => {
    expect(await leave(la, fakeFetch({ [`${la}/auth/logout`]: { status: 204 } }).f)).toBe('done')
    expect(await leave(la, fakeFetch({ [`${la}/auth/logout`]: { status: 401 } }).f)).toBe('done')
    expect(await leave(la, fakeFetch({ [`${la}/auth/logout`]: { status: 500 } }).f)).toBe('failed')
    expect(await leave(la, fakeFetch({}).f)).toBe('unreachable')
  })
  it('checking a machine', async () => {
    expect(await check(la, fakeFetch({ [`${la}/api/devices`]: { status: 200 } }).f)).toBe('ok')
    expect(await check(la, fakeFetch({ [`${la}/api/devices`]: { status: 401, body: { code: 'revoked' } } }).f)).toBe('revoked')
    expect(await check(la, fakeFetch({ [`${la}/api/devices`]: { status: 401, body: { code: 'unauthorized' } } }).f)).toBe('unpaired')
    expect(await check(la, fakeFetch({}).f)).toBe('unreachable')
  })
})
