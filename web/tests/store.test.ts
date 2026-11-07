/**
 * Session store (session-ux.md): list and indices, waiting for you, subscriptions, neighbors, the
 * process-exited line, and input routing in exited sessions.
 */
import { beforeAll, describe, expect, it } from 'vitest'

import {
  SessionStore,
  displayName,
  routeInput,
  shortCwd,
  shouldShowExitLine,
  type ConnLike,
} from '../src/sessions/store'
import { flush, info, lines } from './helpers'

// jsdom lacks matchMedia; term.open() uses it to measure devicePixelRatio
beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
  }
})

class FakeConn implements ConnLike {
  calls: string[] = []
  out = new Map<number, number>()
  head = new Map<number, number>()
  subscribe(sid: number, cols?: number, rows?: number) {
    this.calls.push(cols ? `sub:${sid}:${cols}x${rows}` : `sub:${sid}`)
  }
  unsubscribe(sid: number) {
    this.calls.push(`unsub:${sid}`)
  }
  forget(sid: number) {
    this.calls.push(`forget:${sid}`)
  }
  outSeqOf(sid: number) {
    return this.out.get(sid) ?? 0
  }
  headSeqOf(sid: number) {
    return this.head.get(sid) ?? 0
  }
}

function make() {
  const conn = new FakeConn()
  let changes = 0
  const store = new SessionStore(conn, {
    onChange: () => changes++,
    onData() {},
    allowKey: () => true,
    theme: () => undefined,
    fontSize: () => 14,
  })
  const area = document.createElement('div')
  document.body.appendChild(area)
  return { conn, store, area, changes: () => changes }
}

const enc = (s: string) => new TextEncoder().encode(s)

describe('list', () => {
  it('UT-order-1 orders by the agent (not created_at), appends new sessions, and numbers [n] from 1, renumbering after a close', () => {
    const { store } = make()
    store.upsert(info(5, { created_at: 300 }))
    store.upsert(info(2, { created_at: 100 }))
    store.upsert(info(9, { created_at: 200 }))
    const view = () => store.list().map((s) => `${s.index}:${s.sid}`)
    expect(view(), 'no order given: arrival order').toEqual(['1:5', '2:2', '3:9'])
    store.setOrder([9, 5, 2])
    expect(view()).toEqual(['1:9', '2:5', '3:2'])
    store.remove(5)
    expect(view()).toEqual(['1:9', '2:2'])
    store.upsert(info(7))
    expect(view(), 'new sessions go last').toEqual(['1:9', '2:2', '3:7'])
  })

  it('UT-order-1 session.order keeps placeholders for unknown sids (placed there when session.created arrives late), appends unlisted known sessions in relative order, and moves locally first', () => {
    const { store } = make()
    for (const sid of [1, 2, 3, 4]) store.upsert(info(sid))
    store.setOrder([3, 99, 1])
    expect(store.list().map((s) => s.sid)).toEqual([3, 1, 2, 4])
    store.upsert(info(99))
    expect(store.list().map((s) => s.sid), 'late 99 lands where the agent put it').toEqual([3, 99, 1, 2, 4])
    store.remove(99)
    store.move(4, 3)
    expect(store.list().map((s) => s.sid)).toEqual([4, 3, 1, 2])
    store.move(4, null)
    expect(store.list().map((s) => s.sid)).toEqual([3, 1, 2, 4])
    expect(store.step(1), 'no active session: start from the beginning').toBe(3)
  })

  it('shows attention from the agent on other sessions; output alone shows nothing; the active session never shows it (ADR-0052)', () => {
    const { store, conn, area } = make()
    store.upsert(info(1))
    store.upsert(info(2))
    store.upsert(info(3))
    conn.head.set(3, 10) // output the page hasn't received: no longer marks anything
    store.activate(1, area)
    store.patch(1, { attention: true })
    store.patch(2, { attention: true })
    const v = store.list()
    expect(v.find((s) => s.sid === 1)!.attention, 'active session').toBe(false)
    expect(v.find((s) => s.sid === 2)!.attention).toBe(true)
    expect(v.find((s) => s.sid === 3)!.attention, 'output alone').toBe(false)
    expect(v.find((s) => s.sid === 1)!.active).toBe(true)
    store.patch(2, { attention: false })
    expect(store.list().find((s) => s.sid === 2)!.attention).toBe(false)
  })

  it('upsert merges into an existing session without recreating its terminal', () => {
    const { store } = make()
    store.upsert(info(1, { name: 'a' }))
    const term = store.termOf(1)
    store.upsert(info(1, { name: 'b' }))
    expect(store.termOf(1)).toBe(term)
    expect(store.list()[0]!.name).toBe('b')
  })
})

describe('subscriptions (only the visible session plus pinned ones)', () => {
  it('switching unsubscribes the previous one, then mounts and subscribes the new one with its size', () => {
    const { store, conn, area } = make()
    store.upsert(info(1))
    store.upsert(info(2))
    store.activate(1, area)
    store.activate(2, area)
    const t1 = store.termOf(1)!.term
    const t2 = store.termOf(2)!.term
    expect(conn.calls).toEqual([`sub:1:${t1.cols}x${t1.rows}`, 'unsub:1', `sub:2:${t2.cols}x${t2.rows}`])
    expect(area.querySelectorAll('.term-host')).toHaveLength(1)
    expect(store.active).toBe(2)
  })

  it('does nothing when switching to the active session (no duplicate subscribe)', () => {
    const { store, conn, area } = make()
    store.upsert(info(1))
    store.activate(1, area)
    store.activate(1, area)
    expect(conn.calls.filter((c) => c.startsWith('sub'))).toHaveLength(1)
  })

  it('pinned sessions stay subscribed after switching away; toggling in the background subscribes / unsubscribes immediately', () => {
    const { store, conn, area } = make()
    store.upsert(info(1))
    store.upsert(info(2))
    store.activate(1, area)
    store.togglePinned(1) // the active session: already subscribed
    store.activate(2, area)
    expect(conn.calls).not.toContain('unsub:1')
    store.togglePinned(1) // turned off in the background
    expect(conn.calls[conn.calls.length - 1]).toBe('unsub:1')
    store.togglePinned(1)
    expect(conn.calls[conn.calls.length - 1]).toBe('sub:1')
    expect(store.list().find((s) => s.sid === 1)!.pinned).toBe(true)
  })

  it('remove disposes the terminal, forgets accounting, and clears active if it was active', () => {
    const { store, conn, area } = make()
    store.upsert(info(1))
    store.activate(1, area)
    store.remove(1)
    expect(conn.calls).toContain('forget:1')
    expect(store.active).toBeNull()
    expect(area.querySelectorAll('.term-host')).toHaveLength(0)
  })
})

describe('neighbors', () => {
  it('prefers the next session after a close, else the previous one', () => {
    const { store } = make()
    for (const sid of [1, 2, 3]) store.upsert(info(sid))
    expect(store.neighbourOf(2)).toBe(3)
    expect(store.neighbourOf(3)).toBe(2)
    expect(store.neighbourOf(1)).toBe(2)
  })

  it('Ctrl+Shift+↑/↓ wraps around', () => {
    const { store, area } = make()
    for (const sid of [1, 2, 3]) store.upsert(info(sid))
    store.activate(3, area)
    expect(store.step(1)).toBe(1)
    expect(store.step(-1)).toBe(2)
    store.activate(1, area)
    expect(store.step(-1)).toBe(3)
  })
})

describe('process-exited line (AC-4.5)', () => {
  it('requires exited and caught up', () => {
    expect(shouldShowExitLine('running', 10, 10)).toBe(false)
    expect(shouldShowExitLine('exited', 5, 10)).toBe(false)
    expect(shouldShowExitLine('exited', 10, 10)).toBe(true)
  })

  it('waits for catch-up bytes when not caught up at exit, so the line comes last', async () => {
    const { store, conn } = make()
    store.upsert(info(1))
    conn.head.set(1, 10)
    conn.out.set(1, 0)
    store.patch(1, { status: 'exited', exit_code: 1 })
    const t = store.termOf(1)!.term
    await flush(t)
    expect(lines(t)).toEqual([])
    conn.out.set(1, 10)
    store.output(1, enc('LAST-LINE\r\n'), true)
    await flush(t)
    await flush(t)
    expect(lines(t)).toEqual(['LAST-LINE', '[Exited (code 1) · Enter to close]'])
  })

  it('writes once, and again after a snapshot (which clears the screen), so there is always exactly one line after reloads and reconnects', async () => {
    const { store, conn } = make()
    store.upsert(info(1, { status: 'exited', exit_code: 0 }))
    const t = store.termOf(1)!.term
    store.patch(1, { name: 'x' })
    store.output(1, enc(''), false)
    await flush(t)
    await flush(t)
    expect(lines(t).filter((l) => l.includes('[Exited'))).toHaveLength(1)

    conn.out.set(1, 50)
    conn.head.set(1, 50)
    store.snapshot(1, enc('restored\r\n'))
    await flush(t)
    await flush(t)
    expect(lines(t)).toEqual(['restored', '[Exited (code 0) · Enter to close]'])
  })

  it('does not change outSeq (the line is a local write, not in the agent\'s emulator)', () => {
    const { store, conn } = make()
    conn.out.set(1, 7)
    conn.head.set(1, 7)
    store.upsert(info(1, { status: 'exited', exit_code: 2 }))
    expect(conn.outSeqOf(1)).toBe(7)
  })
})

describe('input routing and display', () => {
  it('in an exited session \\r closes and anything else is dropped; running sessions send as usual', () => {
    expect(routeInput('running', '\r')).toBe('send')
    expect(routeInput('running', 'ls')).toBe('send')
    expect(routeInput('exited', '\r')).toBe('close')
    expect(routeInput('exited', 'q')).toBe('drop')
    expect(routeInput('exited', 'echo hi')).toBe('drop')
  })

  it('abbreviates the home directory (welcome.home) to ~ only when equal to it or below it', () => {
    const home = '/home/sun'
    expect(shortCwd('/home/sun/github/webterm', home)).toBe('~/github/webterm')
    expect(shortCwd('/home/sun', home)).toBe('~')
    expect(shortCwd('/home/sunny/x', home), 'a shared string prefix does not count').toBe('/home/sunny/x')
    expect(shortCwd('/srv/api', home)).toBe('/srv/api')
    expect(shortCwd('/root/x', '/root')).toBe('~/x')
    expect(shortCwd('/home/sun/x', '/home/sun/'), 'home with a trailing slash works too').toBe('~/x')
  })

  it('does not abbreviate or guess /home/<user> when the welcome has no home', () => {
    expect(shortCwd('/home/sun/github', null)).toBe('/home/sun/github')
    expect(shortCwd('/root', undefined)).toBe('/root')
    expect(shortCwd('/etc', '/'), 'no abbreviation when home is /').toBe('/etc')
  })

  it('falls back to shell for an empty name', () => {
    expect(displayName({ name: '' })).toBe('shell')
    expect(displayName({ name: 'api' })).toBe('api')
  })
})
