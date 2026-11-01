/**
 * UT-seq-1 / UT-reconnect-1 / UT-hb-1: connection-layer accounting and reconnects.
 *
 * These four modules (ringbuf / oscparse / protocol / conn) are the entire resume
 * implementation. If they are wrong, the product's core promise is false, so they need
 * near-complete branch coverage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Backoff } from '../src/conn/backoff'
import { Connection, PROBE_TIMEOUT, type WebSocketLike } from '../src/conn/connection'
import { PENDING_LIMIT, PendingFullError, ResendQueue } from '../src/conn/resend'
import { FLAG_MORE, TYPE_INPUT, TYPE_OUTPUT, TYPE_SNAPSHOT, decodeFrame, encodeFrame } from '../src/protocol/frame'

/** A scriptable fake WebSocket. */
class FakeSocket implements WebSocketLike {
  binaryType = 'arraybuffer'
  readyState = 0
  sent: (string | Uint8Array)[] = []
  onopen: ((ev: unknown) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  closed = false

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(typeof data === 'string' ? data : new Uint8Array(data as ArrayBuffer))
  }
  close(): void {
    this.closed = true
    this.readyState = 3
    this.onclose?.({})
  }
  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }
  deliverText(obj: object): void {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }
  deliverFrame(f: Parameters<typeof encodeFrame>[0]): void {
    const b = encodeFrame(f)
    this.onmessage?.({ data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) })
  }
  /** Returns the hello that was sent. */
  hello(): Record<string, unknown> {
    const first = this.sent.find((s) => typeof s === 'string' && s.includes('"hello"'))
    return JSON.parse(first as string)
  }
  inputFrames() {
    return this.sent.filter((s) => s instanceof Uint8Array).map((b) => decodeFrame(b as Uint8Array))
  }
}

interface Harness {
  conn: Connection
  socket: () => FakeSocket
  output: { sid: number; data: Uint8Array; isReplay: boolean }[]
  snapshots: { sid: number; data: Uint8Array; seq: number }[]
  /** Events in arrival order (`out:1` / `snap:1` / `restart`). */
  events: string[]
  fatals: string[]
  errors: string[]
  recovered: number[]
  unauthorized: string[]
  closed: boolean[]
  states: { state: string; retryInMs?: number; rttMs?: number }[]
}

function harness(opts: { backoff?: Backoff } = {}): Harness {
  const sockets: FakeSocket[] = []
  const h: Omit<Harness, 'conn' | 'socket'> = {
    output: [],
    snapshots: [],
    events: [],
    fatals: [],
    errors: [],
    recovered: [],
    unauthorized: [],
    closed: [],
    states: [],
  }
  const conn = new Connection({
    url: 'ws://test/ws',
    clientID: 'tab-1',
    backoff: opts.backoff,
    socketFactory: () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
    handlers: {
      onOutput: (sid, data, isReplay) => {
        h.output.push({ sid, data, isReplay })
        h.events.push(`out:${sid}`)
      },
      onSnapshot: (sid, data, seq) => {
        h.snapshots.push({ sid, data, seq })
        h.events.push(`snap:${sid}`)
      },
      onMessage: () => {},
      onState: (state, info) => h.states.push({ state, ...info }),
      onRecovered: (bytes) => h.recovered.push(bytes),
      onRestart: () => h.events.push('restart'),
      onFatal: (r) => h.fatals.push(r),
      onError: (r) => h.errors.push(r),
      onUnauthorized: (m) => h.unauthorized.push(m),
      onClosed: (w) => h.closed.push(w),
    },
  })
  return { conn, socket: () => sockets[sockets.length - 1]!, ...h }
}

function welcome(extra: Record<string, unknown> = {}) {
  return {
    t: 'welcome',
    protocol: 2,
    server_version: 'test',
    instance_id: 'inst-1',
    limits: { max_sessions: 20, ring_bytes: 262144, max_frame_bytes: 262144 },
    sessions: [],
    resumed: [],
    ...extra,
  }
}

function sessionInfo(sid: number, head: number) {
  return {
    sid,
    name: 's',
    name_is_manual: false,
    cwd: '/tmp',
    status: 'running',
    exit_code: null,
    cols: 80,
    rows: 24,
    base_seq: 0,
    head_seq: head,
    created_at: 0,
  }
}

/** Connects and receives a welcome. */
function online(h: Harness, w: Record<string, unknown> = {}) {
  h.conn.connect()
  h.socket().open()
  h.socket().deliverText(welcome(w))
}

/** Disconnects → waits out the backoff → opens again (no welcome yet). */
function reconnect(h: Harness) {
  h.socket().close()
  vi.advanceTimersByTime(20_000)
  h.socket().open()
}

const text = (s: string) => new TextEncoder().encode(s)
const str = (b: Uint8Array) => new TextDecoder().decode(b)

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

// UT-seq-1: out_seq accounting: contiguous frames, gap detection, duplicate detection.
describe('UT-seq-1 output seq accounting', () => {
  it('accumulates contiguous frames byte by byte', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())

    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: text('abc') })
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 3n, payload: text('de') })

    expect(h.output.map((o) => str(o.data))).toEqual(['abc', 'de'])
    expect(h.conn.outSeqOf(1)).toBe(5)
  })

  it('closes the connection on a gap and resumes instead of patching it', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())

    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: text('abc') })
    // skips 3..9
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 10n, payload: text('xyz') })

    expect(h.errors.join()).toMatch(/gap/)
    expect(h.socket().closed).toBe(true)
    // Data after the gap must not reach the terminal; it would corrupt the screen
    expect(h.output.map((o) => str(o.data))).toEqual(['abc'])
  })

  it('drops fully duplicate frames', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())

    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: text('abc') })
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: text('abc') })

    expect(h.output).toHaveLength(1)
    expect(h.conn.outSeqOf(1)).toBe(3)
  })

  it('keeps only the unseen part of a partially overlapping frame', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())

    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: text('abc') })
    // resends 1..2 along with new 3..4
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 1n, payload: text('bcde') })

    expect(h.output.map((o) => str(o.data))).toEqual(['abc', 'de'])
    expect(h.conn.outSeqOf(1)).toBe(5)
  })

  it('closes the connection when the agent sends an INPUT frame (wrong direction)', () => {
    const h = harness()
    online(h)
    h.socket().deliverFrame({ type: TYPE_INPUT, flags: 0, sid: 1, seq: 0n, payload: text('x') })
    expect(h.errors.join()).toMatch(/INPUT/)
    expect(h.socket().closed).toBe(true)
  })
})

// UT-replay-1: the catch_up replay window (protocol §5.3) and snapshots (§3).
describe('UT-replay-1 replay window and snapshots', () => {
  it('welcome status=ok: OUTPUT before the session head_seq is replay', () => {
    const h = harness()
    online(h)
    h.conn.subscribe(1)
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: text('ab') })

    reconnect(h)
    h.socket().deliverText(
      welcome({ sessions: [sessionInfo(1, 10)], resumed: [{ sid: 1, status: 'ok', from_seq: 2, in_ack: 0 }] }),
    )
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 2n, payload: text('cdefghij') })
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 10n, payload: text('live') })
    expect(h.output.map((o) => o.isReplay)).toEqual([false, true, false])
  })

  it('subscribe with delta: output before the known head (tracked via session.updated) is replay', () => {
    const h = harness()
    online(h)
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: text('ab') })
    // While switched away the agent reports progress via session.updated (that is how unread is derived)
    h.socket().deliverText({ t: 'session.updated', sid: 1, head_seq: 100 })
    expect(h.conn.isUnread(1)).toBe(true)

    h.conn.subscribe(1)
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 2n, payload: text('c'.repeat(98)) })
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 100n, payload: text('live') })

    expect(h.output.map((o) => o.isReplay)).toEqual([false, true, false])
    expect(h.conn.isUnread(1)).toBe(false)
  })

  it('SNAPSHOT sets out_seq to its seq (snapshot bytes do not count), and later OUTPUT continues from seq as live', () => {
    const h = harness()
    online(h)
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: text('old') })
    h.conn.subscribe(1)
    h.socket().deliverFrame({ type: TYPE_SNAPSHOT, flags: 0, sid: 1, seq: 5000n, payload: text('\x1b[Hscreen') })

    expect(h.snapshots).toHaveLength(1)
    expect(h.snapshots[0]!.seq).toBe(5000)
    expect(str(h.snapshots[0]!.data)).toBe('\x1b[Hscreen')
    expect(h.conn.outSeqOf(1)).toBe(5000)

    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 5000n, payload: text('fresh') })
    expect(h.errors).toEqual([])
    expect(h.conn.outSeqOf(1)).toBe(5005)
    expect(h.output[h.output.length - 1]!.isReplay, 'output after the snapshot is live').toBe(false)
    expect(h.events).toEqual(['out:1', 'snap:1', 'out:1'])
  })

  it('delivers a multi-frame snapshot only once complete (MORE on all but the last frame)', () => {
    const h = harness()
    online(h)
    h.socket().deliverFrame({ type: TYPE_SNAPSHOT, flags: FLAG_MORE, sid: 1, seq: 42n, payload: text('aaa') })
    h.socket().deliverFrame({ type: TYPE_SNAPSHOT, flags: FLAG_MORE, sid: 1, seq: 42n, payload: text('bbb') })
    expect(h.snapshots, 'an incomplete snapshot must not be applied').toHaveLength(0)
    expect(h.conn.outSeqOf(1)).toBe(0)
    h.socket().deliverFrame({ type: TYPE_SNAPSHOT, flags: 0, sid: 1, seq: 42n, payload: text('cc') })
    expect(h.snapshots).toHaveLength(1)
    expect(str(h.snapshots[0]!.data)).toBe('aaabbbcc')
    expect(h.conn.outSeqOf(1)).toBe(42)
  })

  it('assembles snapshots of different sessions independently', () => {
    const h = harness()
    online(h)
    h.socket().deliverFrame({ type: TYPE_SNAPSHOT, flags: FLAG_MORE, sid: 1, seq: 10n, payload: text('1a') })
    h.socket().deliverFrame({ type: TYPE_SNAPSHOT, flags: FLAG_MORE, sid: 2, seq: 20n, payload: text('2a') })
    h.socket().deliverFrame({ type: TYPE_SNAPSHOT, flags: 0, sid: 2, seq: 20n, payload: text('2b') })
    h.socket().deliverFrame({ type: TYPE_SNAPSHOT, flags: 0, sid: 1, seq: 10n, payload: text('1b') })
    expect(h.snapshots.map((x) => `${x.sid}:${str(x.data)}`)).toEqual(['2:2a2b', '1:1a1b'])
  })

  it('treats OUTPUT for a session mid-snapshot as a protocol error and resumes', () => {
    const h = harness()
    online(h)
    h.socket().deliverFrame({ type: TYPE_SNAPSHOT, flags: FLAG_MORE, sid: 1, seq: 10n, payload: text('a') })
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: text('x') })
    expect(h.socket().closed).toBe(true)
    expect(h.output).toHaveLength(0)
  })

  it('treats mismatched seqs within one snapshot as a protocol error', () => {
    const h = harness()
    online(h)
    h.socket().deliverFrame({ type: TYPE_SNAPSHOT, flags: FLAG_MORE, sid: 1, seq: 10n, payload: text('a') })
    h.socket().deliverFrame({ type: TYPE_SNAPSHOT, flags: 0, sid: 1, seq: 11n, payload: text('b') })
    expect(h.socket().closed).toBe(true)
    expect(h.snapshots).toHaveLength(0)
  })

  it('drops a partial snapshot on disconnect; the agent decides again after reconnecting', () => {
    const h = harness()
    online(h)
    h.conn.subscribe(1)
    h.socket().deliverFrame({ type: TYPE_SNAPSHOT, flags: FLAG_MORE, sid: 1, seq: 10n, payload: text('half') })
    reconnect(h)
    h.socket().deliverText(welcome({ sessions: [sessionInfo(1, 30)], resumed: [{ sid: 1, status: 'snapshot', from_seq: 30, in_ack: 0 }] }))
    h.socket().deliverFrame({ type: TYPE_SNAPSHOT, flags: 0, sid: 1, seq: 30n, payload: text('whole') })
    expect(h.snapshots.map((x) => str(x.data))).toEqual(['whole'])
    expect(h.conn.outSeqOf(1)).toBe(30)
  })

  it('resumed status=snapshot waits for SNAPSHOT frames instead of reporting a gap', () => {
    const h = harness()
    online(h)
    h.conn.subscribe(1)
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: text('abc') })
    reconnect(h)
    // Fell out of the window: the agent sends a snapshot instead
    h.socket().deliverText(welcome({ sessions: [sessionInfo(1, 900000)], resumed: [{ sid: 1, status: 'snapshot', from_seq: 900000, in_ack: 0 }] }))
    h.socket().deliverFrame({ type: TYPE_SNAPSHOT, flags: 0, sid: 1, seq: 900000n, payload: text('S') })
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 900000n, payload: text('x') })
    expect(h.errors).toEqual([])
    expect(h.conn.outSeqOf(1)).toBe(900001)
    expect(h.output.map((o) => o.isReplay)).toEqual([false, false])
  })

  it('subscribe carries the size in the same message', () => {
    const h = harness()
    online(h)

    h.conn.subscribe(1, 90, 30)
    const sub = h.socket().sent.filter((s) => typeof s === 'string' && s.includes('"subscribe"'))
    expect(JSON.parse(sub[sub.length - 1] as string)).toMatchObject({ sid: 1, cols: 90, rows: 30 })

    // Without a size, omit it; the agent keeps the session's current size
    h.conn.subscribe(2)
    const sub2 = h.socket().sent.filter((s) => typeof s === 'string' && s.includes('"subscribe"'))
    const last = JSON.parse(sub2[sub2.length - 1] as string)
    expect(last.cols).toBeUndefined()
    expect(last.rows).toBeUndefined()
  })

  it('subscribe reports local progress, 0 on first open', () => {
    const h = harness()
    online(h)
    h.conn.subscribe(7)
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: text('abc') })
    h.conn.subscribe(1)
    const subs = h.socket().sent.filter((s) => typeof s === 'string' && s.includes('"subscribe"')).map((s) => JSON.parse(s as string))
    expect(subs[0]).toMatchObject({ sid: 7, out_seq: 0 })
    expect(subs[1]).toMatchObject({ sid: 1, out_seq: 3 })
  })

  it('frames() records received frame kinds (used by E2E-30 / 31)', () => {
    const h = harness()
    online(h)
    h.socket().deliverFrame({ type: TYPE_SNAPSHOT, flags: FLAG_MORE, sid: 1, seq: 9n, payload: text('ab') })
    h.socket().deliverFrame({ type: TYPE_SNAPSHOT, flags: 0, sid: 1, seq: 9n, payload: text('c') })
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 9n, payload: text('xyz') })
    expect(h.conn.frames()).toEqual([
      { type: 3, kind: 'SNAPSHOT', sid: 1, seq: 9, flags: 1, bytes: 2, replay: true },
      { type: 3, kind: 'SNAPSHOT', sid: 1, seq: 9, flags: 0, bytes: 1, replay: true },
      { type: 1, kind: 'OUTPUT', sid: 1, seq: 9, flags: 0, bytes: 3, replay: false },
    ])
  })
})

describe('"Resumed · caught up N KB" (AC-2.10)', () => {
  it('is not reported on the first connect', () => {
    const h = harness()
    online(h)
    expect(h.recovered).toEqual([])
  })

  it('is reported once after a reconnect when catch-up completes, with the caught-up byte count', () => {
    const h = harness()
    online(h)
    h.conn.subscribe(1)
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: text('ab') })
    reconnect(h)
    h.socket().deliverText(welcome({ sessions: [sessionInfo(1, 10)], resumed: [{ sid: 1, status: 'ok', from_seq: 2, in_ack: 0 }] }))
    expect(h.recovered, 'not caught up yet').toEqual([])
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 2n, payload: text('cdef') })
    expect(h.recovered).toEqual([])
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 6n, payload: text('ghij') })
    expect(h.recovered).toEqual([8])
  })

  it('counts a snapshot session as caught up when the snapshot arrives, using its size', () => {
    const h = harness()
    online(h)
    h.conn.subscribe(1)
    reconnect(h)
    h.socket().deliverText(welcome({ sessions: [sessionInfo(1, 500)], resumed: [{ sid: 1, status: 'snapshot', from_seq: 500, in_ack: 0 }] }))
    h.socket().deliverFrame({ type: TYPE_SNAPSHOT, flags: 0, sid: 1, seq: 500n, payload: text('0123456789') })
    expect(h.recovered).toEqual([10])
  })

  it('reports 0 right at welcome when nothing was missed', () => {
    const h = harness()
    online(h)
    h.conn.subscribe(1)
    reconnect(h)
    h.socket().deliverText(welcome({ sessions: [sessionInfo(1, 0)], resumed: [{ sid: 1, status: 'ok', from_seq: 0, in_ack: 0 }] }))
    expect(h.recovered).toEqual([0])
  })
})

describe('agent restarted (instance_id changed, AC-2.13)', () => {
  it('voids all local accounting, calls onRestart first and does not report resumed', () => {
    const h = harness()
    online(h)
    h.conn.subscribe(1)
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: text('abcdef') })
    h.conn.sendInput(1, text('pending'))
    reconnect(h)
    h.socket().deliverText(
      welcome({ instance_id: 'inst-2', sessions: [sessionInfo(1, 3)], resumed: [{ sid: 1, status: 'gone', from_seq: 0, in_ack: 0 }] }),
    )
    expect(h.events).toContain('restart')
    expect(h.conn.outSeqOf(1), 'the new sid 1 is a different session').toBe(0)
    expect(h.conn.unackedOf(1)).toBe(0)
    expect(h.recovered).toEqual([])
  })
})

// Resend queue (protocol §5.3).
describe('input resend queue', () => {
  it('drops acked bytes', () => {
    const q = new ResendQueue()
    q.push(text('hello'))
    q.push(text('world'))
    expect(q.inSeqNext).toBe(10)
    q.ack(5)
    expect(q.pending.map((p) => str(p.bytes))).toEqual(['world'])
  })

  it('trims the acked prefix of a partially acked item instead of dropping it', () => {
    const q = new ResendQueue()
    q.push(text('hello'))
    q.ack(2)
    expect(q.pending).toHaveLength(1)
    expect(str(q.pending[0]!.bytes)).toBe('llo')
    expect(q.pending[0]!.seq).toBe(2)
  })

  it('keeps inSeqNext contiguous after resumeFrom, or the next send would cause input_gap', () => {
    const q = new ResendQueue()
    q.push(text('aaaa'))
    q.push(text('bbbb'))
    const resend = q.resumeFrom(6) // the agent only wrote 6 bytes
    expect(resend.map((p) => [p.seq, str(p.bytes)])).toEqual([[6, 'bb']])
    expect(q.inSeqNext).toBe(8)
    // New input must continue right after
    expect(q.push(text('c')).seq).toBe(8)
  })

  it('throws when full instead of dropping silently', () => {
    const q = new ResendQueue()
    q.push(new Uint8Array(PENDING_LIMIT))
    expect(() => q.push(text('x'))).toThrow(PendingFullError)
  })
})

// UT-reconnect-1: exponential backoff sequence, jitter range, immediate retry.
describe('UT-reconnect-1 exponential backoff', () => {
  it('starts at 0.5s, grows ×1.5, caps at 15s', () => {
    const b = new Backoff({ jitter: 0, random: () => 0.5 })
    const seq = [b.next(), b.next(), b.next(), b.next()]
    expect(seq).toEqual([500, 750, 1125, 1688])
    for (let i = 0; i < 30; i++) b.next()
    expect(b.next()).toBe(15_000)
  })

  it('keeps jitter within ±20%', () => {
    for (const r of [0, 0.5, 1]) {
      const b = new Backoff({ random: () => r })
      const d = b.next()
      expect(d).toBeGreaterThanOrEqual(400)
      expect(d).toBeLessThanOrEqual(600)
    }
  })

  it('resets after a successful connection', () => {
    const b = new Backoff({ jitter: 0, random: () => 0.5 })
    b.next()
    b.next()
    b.reset()
    expect(b.next()).toBe(500)
  })

  it('reconnects with backoff after a disconnect and counts down live', () => {
    const h = harness({ backoff: new Backoff({ jitter: 0, random: () => 0.5 }) })
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())
    expect(h.states.at(-1)!.state).toBe('online')

    h.socket().close()
    const reconnecting = h.states.filter((s) => s.state === 'reconnecting')
    expect(reconnecting.length).toBeGreaterThan(0)
    expect(reconnecting[0]!.retryInMs).toBe(500)

    // The countdown is ticking
    vi.advanceTimersByTime(300)
    const later = h.states.filter((s) => s.state === 'reconnecting').at(-1)!
    expect(later.retryInMs!).toBeLessThan(500)
  })

  it('retryNow retries immediately and resets the backoff (the online event)', () => {
    const h = harness({ backoff: new Backoff({ jitter: 0, random: () => 0.5 }) })
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())
    h.socket().close()

    const before = h.socket()
    h.conn.retryNow()
    expect(h.socket()).not.toBe(before) // a new socket, without waiting for the backoff
  })
})

// Resume on reconnect: report progress, resend input from in_ack.
describe('resume on reconnect', () => {
  it('hello lists only subscribed sessions, with out_seq and instance_id', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())

    h.conn.subscribe(1)
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: text('12345') })
    h.conn.subscribe(2)
    h.conn.unsubscribe(2) // switched away

    h.socket().close()
    vi.advanceTimersByTime(2000)
    h.socket().open()

    const hello = h.socket().hello()
    expect(hello.instance_id).toBe('inst-1')
    expect(hello.resume).toEqual([{ sid: 1, out_seq: 5 }])
  })

  it('trims at welcome.resumed[].in_ack and resends unacked input', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())
    h.conn.subscribe(1)

    h.conn.sendInput(1, text('echo A\r'))
    h.conn.sendInput(1, text('echo B\r'))

    h.socket().close()
    vi.advanceTimersByTime(2000)
    h.socket().open()
    // The agent says it wrote only 7 bytes (the first item)
    h.socket().deliverText(welcome({ resumed: [{ sid: 1, status: 'ok', from_seq: 0, in_ack: 7 }] }))

    const frames = h.socket().inputFrames()
    expect(frames).toHaveLength(1)
    expect(frames[0]!.type).toBe(TYPE_INPUT)
    expect(frames[0]!.seq).toBe(7n)
    expect(str(frames[0]!.payload)).toBe('echo B\r')
  })

  it('hello carries protocol 2; first connect has a null instance_id and empty resume', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    const hello = h.socket().hello()
    expect(hello).toMatchObject({ t: 'hello', protocol: 2, client_id: 'tab-1', instance_id: null, resume: [] })
  })

  it('clears local session state on status=gone', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())
    h.conn.subscribe(1)
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: text('xx') })
    expect(h.conn.outSeqOf(1)).toBe(2)

    h.socket().close()
    vi.advanceTimersByTime(2000)
    h.socket().open()
    h.socket().deliverText(welcome({ resumed: [{ sid: 1, status: 'gone', from_seq: 0, in_ack: 0 }] }))

    expect(h.conn.outSeqOf(1)).toBe(0) // forgotten
  })

  it('queues input typed while offline and resends it in order after reconnecting', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())
    h.conn.subscribe(1)
    h.socket().close()

    // Typing while disconnected
    h.conn.sendInput(1, text('echo A1\r'))
    h.conn.sendInput(1, text('echo A2\r'))

    vi.advanceTimersByTime(2000)
    h.socket().open()
    h.socket().deliverText(welcome({ resumed: [{ sid: 1, status: 'ok', from_seq: 0, in_ack: 0 }] }))

    const payloads = h.socket().inputFrames().map((f) => str(f.payload))
    expect(payloads).toEqual(['echo A1\r', 'echo A2\r']) // in order, no duplicates, nothing lost
  })
})

// UT-hb-1: heartbeat interval and pong timeout.
describe('UT-hb-1 heartbeat', () => {
  it('sends a ping every 30 seconds', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())

    vi.advanceTimersByTime(30_000)
    const pings = h.socket().sent.filter((s) => typeof s === 'string' && s.includes('"ping"'))
    expect(pings).toHaveLength(1)
  })

  it('disconnects and reconnects when no pong arrives within 10 seconds', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())

    vi.advanceTimersByTime(30_000)
    expect(h.socket().closed).toBe(false)
    vi.advanceTimersByTime(10_000)
    expect(h.socket().closed).toBe(true)
  })

  it('stays connected on pong and reports the RTT', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())

    vi.advanceTimersByTime(30_000)
    h.socket().deliverText({ t: 'pong', ts: Date.now() })
    vi.advanceTimersByTime(10_000)
    expect(h.socket().closed).toBe(false)
    expect(h.states.some((s) => s.state === 'online' && s.rttMs !== undefined)).toBe(true)
  })
})

// UT-hb-2: zombie connections, probed immediately while we think we're online (AC-2.20, ADR-0020).
//
// A dead link doesn't always fire onclose (screen off, network switch, NAT timeout): the
// socket stays OPEN, the page thinks it is online, and typing goes into a dead socket. The
// heartbeat alone would take up to 30 + 10 = 40 seconds to notice, so the two known
// suspicious moments, online and page visible, probe right away.
describe('UT-hb-2 immediate probe for zombie connections', () => {
  it('retryNow sends a probe ping while online instead of doing nothing', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())
    const before = h.socket().sent.length

    h.conn.retryNow()

    const pings = h.socket().sent.filter((s) => typeof s === 'string' && s.includes('"ping"'))
    expect(pings, 'must probe even when it thinks it is online').toHaveLength(1)
    expect(h.socket().sent.length).toBe(before + 1)
    expect(h.socket().closed, 'must not close the moment the probe is sent').toBe(false)
  })

  it('closes and reconnects when the probe gets no pong within 2 seconds', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())
    const zombie = h.socket()

    h.conn.retryNow()
    vi.advanceTimersByTime(PROBE_TIMEOUT - 1)
    expect(zombie.closed, 'not timed out yet').toBe(false)
    vi.advanceTimersByTime(1)
    expect(zombie.closed).toBe(true)
    expect(h.states.some((s) => s.state === 'reconnecting')).toBe(true)
  })

  it('keeps the connection when the probe pong arrives in time', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())

    h.conn.retryNow()
    h.socket().deliverText({ t: 'pong', ts: Date.now() })
    vi.advanceTimersByTime(PROBE_TIMEOUT * 5)
    expect(h.socket().closed).toBe(false)
  })

  it('detects death much faster than the heartbeat: already reconnected by 10 seconds', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())
    const zombie = h.socket()

    h.conn.retryNow()
    vi.advanceTimersByTime(5_000)
    expect(zombie.closed, 'the heartbeat would not even have sent a ping yet').toBe(true)
  })

  it('when offline, reconnects immediately and resets the backoff without probing', () => {
    const backoff = new Backoff()
    const h = harness({ backoff })
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())
    h.socket().close() // dropped → reconnecting
    const closedAt = h.socket()

    h.conn.retryNow()

    expect(h.socket(), 'should have opened a new socket').not.toBe(closedAt)
    expect(backoff.attempts, 'retryNow must reset the backoff').toBe(0)
  })

  it('does not probe after close()', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())
    h.conn.close()
    const sentAfterClose = h.socket().sent.length

    h.conn.retryNow()

    expect(h.socket().sent.length).toBe(sentAfterClose)
  })
})

// Unread is derived from head_seq; it is not server state.
describe('unread derivation', () => {
  it('is unread when head_seq exceeds the local out_seq', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())

    expect(h.conn.isUnread(2)).toBe(false)
    h.socket().deliverText({ t: 'session.updated', sid: 2, head_seq: 500 })
    expect(h.conn.isUnread(2)).toBe(true)

    // Switching to it and catching up clears unread
    h.socket().deliverFrame({
      type: TYPE_OUTPUT,
      flags: 0,
      sid: 2,
      seq: 0n,
      payload: new Uint8Array(500),
    })
    expect(h.conn.isUnread(2)).toBe(false)
  })
})

describe('device revoked (AC-1.11)', () => {
  it('routes error{code:"unauthorized"} to onUnauthorized, not as a regular error', () => {
    const h = harness()
    online(h)
    h.socket().deliverText({ t: 'notice', level: 'error', message: 'This device has been revoked' })
    h.socket().deliverText({ t: 'error', code: 'unauthorized', message: 'device revoked' })
    expect(h.unauthorized).toEqual(['device revoked'])
    expect(h.fatals).toEqual([])
  })

  it('onClosed reports whether the socket got a welcome (none = upgrade likely rejected with 401)', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().close() // closed before any welcome
    vi.advanceTimersByTime(20_000)
    h.socket().open()
    h.socket().deliverText(welcome())
    h.socket().close()
    expect(h.closed).toEqual([false, true])
  })

  it('does not call onClosed after an explicit close()', () => {
    const h = harness()
    online(h)
    h.conn.close()
    expect(h.closed).toEqual([])
  })
})
