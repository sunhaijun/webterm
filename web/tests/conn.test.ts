/**
 * UT-seq-1 / UT-reconnect-1 / UT-hb-1 —— 连接层的记账与重连。
 *
 * 这四个模块（ringbuf / oscparse / protocol / conn）是"断线续传"的全部
 * 实现。它们错了，产品的核心承诺就是假的，所以要求近乎完全的分支覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Backoff } from '../src/conn/backoff'
import { Connection, PROBE_TIMEOUT, type WebSocketLike } from '../src/conn/connection'
import { PENDING_LIMIT, PendingFullError, ResendQueue } from '../src/conn/resend'
import { FLAG_MORE, TYPE_INPUT, TYPE_OUTPUT, TYPE_SNAPSHOT, decodeFrame, encodeFrame } from '../src/protocol/frame'

/** 一个可编程的 WebSocket 替身。 */
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
  /** 取出发出去的 hello。 */
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
  /** 按到达顺序记的事件流（`out:1` / `snap:1` / `restart`）。 */
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

/** 连上、收到 welcome。 */
function online(h: Harness, w: Record<string, unknown> = {}) {
  h.conn.connect()
  h.socket().open()
  h.socket().deliverText(welcome(w))
}

/** 断开 → 等退避 → 重新 open（还没 welcome）。 */
function reconnect(h: Harness) {
  h.socket().close()
  vi.advanceTimersByTime(20_000)
  h.socket().open()
}

const text = (s: string) => new TextEncoder().encode(s)
const str = (b: Uint8Array) => new TextDecoder().decode(b)

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

// UT-seq-1：out_seq 记账 —— 连续帧、空洞检测、重复检测。
describe('UT-seq-1 输出 seq 记账', () => {
  it('连续帧按字节累加', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())

    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: text('abc') })
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 3n, payload: text('de') })

    expect(h.output.map((o) => str(o.data))).toEqual(['abc', 'de'])
    expect(h.conn.outSeqOf(1)).toBe(5)
  })

  it('出现空洞立即关连接走续传，不自行修补', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())

    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: text('abc') })
    // 跳过了 3..9
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 10n, payload: text('xyz') })

    expect(h.errors.join()).toMatch(/空洞/)
    expect(h.socket().closed).toBe(true)
    // 空洞后的数据【不能】交给终端 —— 那会让屏幕错位
    expect(h.output.map((o) => str(o.data))).toEqual(['abc'])
  })

  it('完全重复的帧被丢弃', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())

    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: text('abc') })
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: text('abc') })

    expect(h.output).toHaveLength(1)
    expect(h.conn.outSeqOf(1)).toBe(3)
  })

  it('部分重叠时只取没收过的那一段', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())

    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: text('abc') })
    // 重发了 1..2 并带上新的 3..4
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 1n, payload: text('bcde') })

    expect(h.output.map((o) => str(o.data))).toEqual(['abc', 'de'])
    expect(h.conn.outSeqOf(1)).toBe(5)
  })

  it('agent 发来 INPUT 帧 = 方向不对，关连接', () => {
    const h = harness()
    online(h)
    h.socket().deliverFrame({ type: TYPE_INPUT, flags: 0, sid: 1, seq: 0n, payload: text('x') })
    expect(h.errors.join()).toMatch(/INPUT/)
    expect(h.socket().closed).toBe(true)
  })
})

// UT-replay-1：回放区间 catch_up（协议 §5.3）与快照（§3）。
describe('UT-replay-1 回放区间与快照', () => {
  it('welcome status=ok：追到该会话 head_seq 之前的 OUTPUT 都是回放', () => {
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

  it('subscribe 走增量：追到已知 head（session.updated 维护）之前都是回放', () => {
    const h = harness()
    online(h)
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: text('ab') })
    // 切走期间 agent 用 session.updated 报进度（未读就是这么推导的）
    h.socket().deliverText({ t: 'session.updated', sid: 1, head_seq: 100 })
    expect(h.conn.isUnread(1)).toBe(true)

    h.conn.subscribe(1)
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 2n, payload: text('c'.repeat(98)) })
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 100n, payload: text('live') })

    expect(h.output.map((o) => o.isReplay)).toEqual([false, true, false])
    expect(h.conn.isUnread(1)).toBe(false)
  })

  it('SNAPSHOT：out_seq 置为快照的 seq（快照字节不计入 seq），之后从 seq 接 OUTPUT，是 live', () => {
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
    expect(h.output[h.output.length - 1]!.isReplay, '快照之后就是 live').toBe(false)
    expect(h.events).toEqual(['out:1', 'snap:1', 'out:1'])
  })

  it('快照拆成多帧：除最后一帧外都带 MORE，收齐才交出去', () => {
    const h = harness()
    online(h)
    h.socket().deliverFrame({ type: TYPE_SNAPSHOT, flags: FLAG_MORE, sid: 1, seq: 42n, payload: text('aaa') })
    h.socket().deliverFrame({ type: TYPE_SNAPSHOT, flags: FLAG_MORE, sid: 1, seq: 42n, payload: text('bbb') })
    expect(h.snapshots, '没收齐不能应用').toHaveLength(0)
    expect(h.conn.outSeqOf(1)).toBe(0)
    h.socket().deliverFrame({ type: TYPE_SNAPSHOT, flags: 0, sid: 1, seq: 42n, payload: text('cc') })
    expect(h.snapshots).toHaveLength(1)
    expect(str(h.snapshots[0]!.data)).toBe('aaabbbcc')
    expect(h.conn.outSeqOf(1)).toBe(42)
  })

  it('不同会话的快照各拼各的', () => {
    const h = harness()
    online(h)
    h.socket().deliverFrame({ type: TYPE_SNAPSHOT, flags: FLAG_MORE, sid: 1, seq: 10n, payload: text('1a') })
    h.socket().deliverFrame({ type: TYPE_SNAPSHOT, flags: FLAG_MORE, sid: 2, seq: 20n, payload: text('2a') })
    h.socket().deliverFrame({ type: TYPE_SNAPSHOT, flags: 0, sid: 2, seq: 20n, payload: text('2b') })
    h.socket().deliverFrame({ type: TYPE_SNAPSHOT, flags: 0, sid: 1, seq: 10n, payload: text('1b') })
    expect(h.snapshots.map((x) => `${x.sid}:${str(x.data)}`)).toEqual(['2:2a2b', '1:1a1b'])
  })

  it('快照没收齐就来了同一会话的 OUTPUT = 协议错误，关连接走续传', () => {
    const h = harness()
    online(h)
    h.socket().deliverFrame({ type: TYPE_SNAPSHOT, flags: FLAG_MORE, sid: 1, seq: 10n, payload: text('a') })
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: text('x') })
    expect(h.socket().closed).toBe(true)
    expect(h.output).toHaveLength(0)
  })

  it('同一份快照的帧 seq 不一致 = 协议错误', () => {
    const h = harness()
    online(h)
    h.socket().deliverFrame({ type: TYPE_SNAPSHOT, flags: FLAG_MORE, sid: 1, seq: 10n, payload: text('a') })
    h.socket().deliverFrame({ type: TYPE_SNAPSHOT, flags: 0, sid: 1, seq: 11n, payload: text('b') })
    expect(h.socket().closed).toBe(true)
    expect(h.snapshots).toHaveLength(0)
  })

  it('断线时丢掉半份快照：重连后 agent 重新判定', () => {
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

  it('resumed status=snapshot：等 SNAPSHOT 帧，不当成空洞', () => {
    const h = harness()
    online(h)
    h.conn.subscribe(1)
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: text('abc') })
    reconnect(h)
    // 落出窗口：agent 改发快照
    h.socket().deliverText(welcome({ sessions: [sessionInfo(1, 900000)], resumed: [{ sid: 1, status: 'snapshot', from_seq: 900000, in_ack: 0 }] }))
    h.socket().deliverFrame({ type: TYPE_SNAPSHOT, flags: 0, sid: 1, seq: 900000n, payload: text('S') })
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 900000n, payload: text('x') })
    expect(h.errors).toEqual([])
    expect(h.conn.outSeqOf(1)).toBe(900001)
    expect(h.output.map((o) => o.isReplay)).toEqual([false, false])
  })

  it('subscribe 把尺寸带在同一条消息里', () => {
    const h = harness()
    online(h)

    h.conn.subscribe(1, 90, 30)
    const sub = h.socket().sent.filter((s) => typeof s === 'string' && s.includes('"subscribe"'))
    expect(JSON.parse(sub[sub.length - 1] as string)).toMatchObject({ sid: 1, cols: 90, rows: 30 })

    // 拿不到尺寸时就别发 —— agent 会沿用会话当前尺寸
    h.conn.subscribe(2)
    const sub2 = h.socket().sent.filter((s) => typeof s === 'string' && s.includes('"subscribe"'))
    const last = JSON.parse(sub2[sub2.length - 1] as string)
    expect(last.cols).toBeUndefined()
    expect(last.rows).toBeUndefined()
  })

  it('subscribe 上报的是本地进度；第一次打开报 0', () => {
    const h = harness()
    online(h)
    h.conn.subscribe(7)
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: text('abc') })
    h.conn.subscribe(1)
    const subs = h.socket().sent.filter((s) => typeof s === 'string' && s.includes('"subscribe"')).map((s) => JSON.parse(s as string))
    expect(subs[0]).toMatchObject({ sid: 7, out_seq: 0 })
    expect(subs[1]).toMatchObject({ sid: 1, out_seq: 3 })
  })

  it('frames() 记下收到的帧类型（E2E-30 / 31 用）', () => {
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

describe('「已恢复 · 补齐 N KB」（AC-2.10）', () => {
  it('首次连接不报', () => {
    const h = harness()
    online(h)
    expect(h.recovered).toEqual([])
  })

  it('重连后补课追平时报一次，字节数 = 补课的量', () => {
    const h = harness()
    online(h)
    h.conn.subscribe(1)
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: text('ab') })
    reconnect(h)
    h.socket().deliverText(welcome({ sessions: [sessionInfo(1, 10)], resumed: [{ sid: 1, status: 'ok', from_seq: 2, in_ack: 0 }] }))
    expect(h.recovered, '还没追平').toEqual([])
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 2n, payload: text('cdef') })
    expect(h.recovered).toEqual([])
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 6n, payload: text('ghij') })
    expect(h.recovered).toEqual([8])
  })

  it('走快照的会话：快照到了就算追平，字节数算快照的大小', () => {
    const h = harness()
    online(h)
    h.conn.subscribe(1)
    reconnect(h)
    h.socket().deliverText(welcome({ sessions: [sessionInfo(1, 500)], resumed: [{ sid: 1, status: 'snapshot', from_seq: 500, in_ack: 0 }] }))
    h.socket().deliverFrame({ type: TYPE_SNAPSHOT, flags: 0, sid: 1, seq: 500n, payload: text('0123456789') })
    expect(h.recovered).toEqual([10])
  })

  it('什么都没错过：welcome 一到就报 0', () => {
    const h = harness()
    online(h)
    h.conn.subscribe(1)
    reconnect(h)
    h.socket().deliverText(welcome({ sessions: [sessionInfo(1, 0)], resumed: [{ sid: 1, status: 'ok', from_seq: 0, in_ack: 0 }] }))
    expect(h.recovered).toEqual([0])
  })
})

describe('agent 重启过（instance_id 变了，AC-2.13）', () => {
  it('本地记账全部作废，先通知 onRestart，不报「已恢复」', () => {
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
    expect(h.conn.outSeqOf(1), '新的 sid 1 是另一个会话').toBe(0)
    expect(h.conn.unackedOf(1)).toBe(0)
    expect(h.recovered).toEqual([])
  })
})

// 重发队列（协议 §5.3）。
describe('输入重发队列', () => {
  it('ack 后丢弃已确认的部分', () => {
    const q = new ResendQueue()
    q.push(text('hello'))
    q.push(text('world'))
    expect(q.inSeqNext).toBe(10)
    q.ack(5)
    expect(q.pending.map((p) => str(p.bytes))).toEqual(['world'])
  })

  it('部分 ack 时裁掉前部而不是整条丢弃', () => {
    const q = new ResendQueue()
    q.push(text('hello'))
    q.ack(2)
    expect(q.pending).toHaveLength(1)
    expect(str(q.pending[0]!.bytes)).toBe('llo')
    expect(q.pending[0]!.seq).toBe(2)
  })

  it('resumeFrom 之后 inSeqNext 必须接得上，否则下一次发送就 input_gap', () => {
    const q = new ResendQueue()
    q.push(text('aaaa'))
    q.push(text('bbbb'))
    const resend = q.resumeFrom(6) // agent 只写进去 6 字节
    expect(resend.map((p) => [p.seq, str(p.bytes)])).toEqual([[6, 'bb']])
    expect(q.inSeqNext).toBe(8)
    // 继续发新内容，seq 必须紧接着
    expect(q.push(text('c')).seq).toBe(8)
  })

  it('队列满时报错而不是静默丢弃', () => {
    const q = new ResendQueue()
    q.push(new Uint8Array(PENDING_LIMIT))
    expect(() => q.push(text('x'))).toThrow(PendingFullError)
  })
})

// UT-reconnect-1：指数退避序列、抖动范围、立即重试。
describe('UT-reconnect-1 指数退避', () => {
  it('从 0.5s 起、×1.5、上限 15s', () => {
    const b = new Backoff({ jitter: 0, random: () => 0.5 })
    const seq = [b.next(), b.next(), b.next(), b.next()]
    expect(seq).toEqual([500, 750, 1125, 1688])
    for (let i = 0; i < 30; i++) b.next()
    expect(b.next()).toBe(15_000)
  })

  it('抖动落在 ±20% 以内', () => {
    for (const r of [0, 0.5, 1]) {
      const b = new Backoff({ random: () => r })
      const d = b.next()
      expect(d).toBeGreaterThanOrEqual(400)
      expect(d).toBeLessThanOrEqual(600)
    }
  })

  it('连接成功后重置', () => {
    const b = new Backoff({ jitter: 0, random: () => 0.5 })
    b.next()
    b.next()
    b.reset()
    expect(b.next()).toBe(500)
  })

  it('断开后按退避重连，并实时倒计时', () => {
    const h = harness({ backoff: new Backoff({ jitter: 0, random: () => 0.5 }) })
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())
    expect(h.states.at(-1)!.state).toBe('online')

    h.socket().close()
    const reconnecting = h.states.filter((s) => s.state === 'reconnecting')
    expect(reconnecting.length).toBeGreaterThan(0)
    expect(reconnecting[0]!.retryInMs).toBe(500)

    // 倒计时在走
    vi.advanceTimersByTime(300)
    const later = h.states.filter((s) => s.state === 'reconnecting').at(-1)!
    expect(later.retryInMs!).toBeLessThan(500)
  })

  it('retryNow 立即重试并重置退避（对应 online 事件）', () => {
    const h = harness({ backoff: new Backoff({ jitter: 0, random: () => 0.5 }) })
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())
    h.socket().close()

    const before = h.socket()
    h.conn.retryNow()
    expect(h.socket()).not.toBe(before) // 开了新 socket，没等退避
  })
})

// 重连续传：resume 上报进度，按 in_ack 重发输入。
describe('重连续传', () => {
  it('hello 只列当前订阅的会话，并带上 out_seq 与 instance_id', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())

    h.conn.subscribe(1)
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: text('12345') })
    h.conn.subscribe(2)
    h.conn.unsubscribe(2) // 切走了

    h.socket().close()
    vi.advanceTimersByTime(2000)
    h.socket().open()

    const hello = h.socket().hello()
    expect(hello.instance_id).toBe('inst-1')
    expect(hello.resume).toEqual([{ sid: 1, out_seq: 5 }])
  })

  it('按 welcome.resumed[].in_ack 裁剪并重发未确认的输入', () => {
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
    // agent 说只写进去 7 字节（第一条）
    h.socket().deliverText(welcome({ resumed: [{ sid: 1, status: 'ok', from_seq: 0, in_ack: 7 }] }))

    const frames = h.socket().inputFrames()
    expect(frames).toHaveLength(1)
    expect(frames[0]!.type).toBe(TYPE_INPUT)
    expect(frames[0]!.seq).toBe(7n)
    expect(str(frames[0]!.payload)).toBe('echo B\r')
  })

  it('hello 带 protocol 2；首次连接 instance_id 为 null、resume 为空', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    const hello = h.socket().hello()
    expect(hello).toMatchObject({ t: 'hello', protocol: 2, client_id: 'tab-1', instance_id: null, resume: [] })
  })

  it('status=gone 时清掉本地会话状态', () => {
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

    expect(h.conn.outSeqOf(1)).toBe(0) // 已被遗忘
  })

  it('离线时提交的输入留在队列里，重连后按顺序补发', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())
    h.conn.subscribe(1)
    h.socket().close()

    // 断线期间打字
    h.conn.sendInput(1, text('echo A1\r'))
    h.conn.sendInput(1, text('echo A2\r'))

    vi.advanceTimersByTime(2000)
    h.socket().open()
    h.socket().deliverText(welcome({ resumed: [{ sid: 1, status: 'ok', from_seq: 0, in_ack: 0 }] }))

    const payloads = h.socket().inputFrames().map((f) => str(f.payload))
    expect(payloads).toEqual(['echo A1\r', 'echo A2\r']) // 顺序正确、不重不漏
  })
})

// UT-hb-1：心跳间隔与 pong 超时判死。
describe('UT-hb-1 心跳', () => {
  it('每 30 秒发一次 ping', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())

    vi.advanceTimersByTime(30_000)
    const pings = h.socket().sent.filter((s) => typeof s === 'string' && s.includes('"ping"'))
    expect(pings).toHaveLength(1)
  })

  it('发出 ping 后 10 秒没有 pong 就主动断开重连', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())

    vi.advanceTimersByTime(30_000)
    expect(h.socket().closed).toBe(false)
    vi.advanceTimersByTime(10_000)
    expect(h.socket().closed).toBe(true)
  })

  it('收到 pong 就不判死，并报出 RTT', () => {
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

// UT-hb-2：僵尸连接 —— 自认在线时的即时探活（AC-2.20，ADR-0020）。
//
// 线路断了不一定有 onclose（息屏、切网、NAT 回收），socket 的 readyState 还是
// OPEN，页面自认在线，打字全写进一条死 socket。唯一的暴露渠道原本只有心跳，
// 最坏 30 + 10 = 40 秒。所以 online / 页面可见这两个【已知的可疑时刻】要立刻探活。
describe('UT-hb-2 僵尸连接的即时探活', () => {
  it('自认在线时 retryNow 发一次 ping 探活，而不是什么都不做', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())
    const before = h.socket().sent.length

    h.conn.retryNow()

    const pings = h.socket().sent.filter((s) => typeof s === 'string' && s.includes('"ping"'))
    expect(pings, '自认在线也要探一下，不能直接 return').toHaveLength(1)
    expect(h.socket().sent.length).toBe(before + 1)
    expect(h.socket().closed, '探针发出去的这一刻还不能关连接').toBe(false)
  })

  it('探针 2 秒内没有 pong 就关连接走重连', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())
    const zombie = h.socket()

    h.conn.retryNow()
    vi.advanceTimersByTime(PROBE_TIMEOUT - 1)
    expect(zombie.closed, '还没到点，不能提前判死').toBe(false)
    vi.advanceTimersByTime(1)
    expect(zombie.closed).toBe(true)
    expect(h.states.some((s) => s.state === 'reconnecting')).toBe(true)
  })

  it('探针的 pong 按时回来就不关，连接照旧', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())

    h.conn.retryNow()
    h.socket().deliverText({ t: 'pong', ts: Date.now() })
    vi.advanceTimersByTime(PROBE_TIMEOUT * 5)
    expect(h.socket().closed).toBe(false)
  })

  it('探针比心跳判死快得多 —— 10 秒时早已判死并重连', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())
    const zombie = h.socket()

    h.conn.retryNow()
    vi.advanceTimersByTime(5_000)
    expect(zombie.closed, '心跳那条路这时候连 ping 都还没发').toBe(true)
  })

  it('不在线时保持原行为：立刻重连并重置退避，不发探针', () => {
    const backoff = new Backoff()
    const h = harness({ backoff })
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())
    h.socket().close() // 断了 → reconnecting
    const closedAt = h.socket()

    h.conn.retryNow()

    expect(h.socket(), '应当已经开了一条新 socket').not.toBe(closedAt)
    expect(backoff.attempts, 'retryNow 要重置退避').toBe(0)
  })

  it('已经 close() 过的连接不探活', () => {
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

// 未读由 head_seq 推导，不是服务端状态。
describe('未读推导', () => {
  it('head_seq 超过本地 out_seq 就是未读', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())

    expect(h.conn.isUnread(2)).toBe(false)
    h.socket().deliverText({ t: 'session.updated', sid: 2, head_seq: 500 })
    expect(h.conn.isUnread(2)).toBe(true)

    // 切过去补齐之后未读消失
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

describe('设备被吊销（AC-1.11）', () => {
  it('error{code:"unauthorized"} 交给 onUnauthorized，不当成普通错误', () => {
    const h = harness()
    online(h)
    h.socket().deliverText({ t: 'notice', level: 'error', message: '此设备已被吊销' })
    h.socket().deliverText({ t: 'error', code: 'unauthorized', message: 'device revoked' })
    expect(h.unauthorized).toEqual(['device revoked'])
    expect(h.fatals).toEqual([])
  })

  it('onClosed 报这条连接有没有收到过 welcome：没收到 = 升级多半被拒（401）', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().close() // 没有 welcome 就断了
    vi.advanceTimersByTime(20_000)
    h.socket().open()
    h.socket().deliverText(welcome())
    h.socket().close()
    expect(h.closed).toEqual([false, true])
  })

  it('主动 close() 不报 onClosed', () => {
    const h = harness()
    online(h)
    h.conn.close()
    expect(h.closed).toEqual([])
  })
})
