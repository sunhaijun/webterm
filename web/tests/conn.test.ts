/**
 * UT-seq-1 / UT-reconnect-1 / UT-hb-1 —— 连接层的记账与重连。
 *
 * 这四个模块（ringbuf / oscparse / protocol / conn）是"断线续传"的全部
 * 实现。它们错了，产品的核心承诺就是假的，所以要求近乎完全的分支覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Backoff } from '../src/conn/backoff'
import { Connection, type WebSocketLike } from '../src/conn/connection'
import { PENDING_LIMIT, PendingFullError, ResendQueue } from '../src/conn/resend'
import {
  ATTR_PREFIX,
  FLAG_ATTR_PREFIX,
  TYPE_INPUT,
  TYPE_OUTPUT,
  decodeFrame,
  encodeFrame,
} from '../src/protocol/frame'

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
  /** 按到达顺序记的事件流（`reset:1` / `out:1`）：清屏必须排在写入【之前】。 */
  events: string[]
  fatals: string[]
  states: { state: string; retryInMs?: number; replayedBytes?: number; rttMs?: number }[]
}

function harness(opts: { backoff?: Backoff } = {}): Harness {
  const sockets: FakeSocket[] = []
  const output: Harness['output'] = []
  const events: string[] = []
  const fatals: string[] = []
  const states: Harness['states'] = []
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
        output.push({ sid, data, isReplay })
        events.push(`out:${sid}`)
      },
      onResetScreen: (sid) => events.push(`reset:${sid}`),
      onMessage: () => {},
      onState: (state, info) => states.push({ state, ...info }),
      onFatal: (r) => fatals.push(r),
    },
  })
  return { conn, socket: () => sockets[sockets.length - 1]!, output, events, fatals, states }
}

function welcome(extra: Record<string, unknown> = {}) {
  return {
    t: 'welcome',
    protocol: 1,
    server_version: 'test',
    instance_id: 'inst-1',
    limits: { max_sessions: 20, ring_bytes: 1048576, max_frame_bytes: 262144 },
    sessions: [],
    resumed: [],
    ...extra,
  }
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

    expect(h.fatals.join()).toMatch(/空洞/)
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

  it('ATTR_PREFIX 的 4 个字节不计入 seq', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())

    const payload = new Uint8Array([...ATTR_PREFIX, ...text('hello')])
    h.socket().deliverFrame({
      type: TYPE_OUTPUT,
      flags: FLAG_ATTR_PREFIX,
      sid: 1,
      seq: 1000n,
      payload,
    })
    // seq 只按 data 长度推进；算错了两侧会永久错开 4 字节
    expect(h.conn.outSeqOf(1)).toBe(1005)
    expect(h.output[0]!.isReplay).toBe(true)
    // 但交给终端的字节【要】带上前缀，属性修正才生效
    expect(str(h.output[0]!.data)).toBe('\x1b[0mhello')
  })
})

// UT-replay-1：回放的两条纪律 —— 接不上的内容先清屏，补课的字节算回放（AC-2.6 / AC-2.15）。
describe('UT-replay-1 回放语义', () => {
  const resetFrame = (seq: bigint, body: string) => ({
    type: TYPE_OUTPUT,
    flags: FLAG_ATTR_PREFIX,
    sid: 1,
    seq,
    payload: new Uint8Array([...ATTR_PREFIX, ...text(body)]),
  })

  it('ATTR_PREFIX 帧先清屏再写，不依赖 reset 控制消息', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())

    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: text('old') })
    h.socket().deliverFrame(resetFrame(1000n, 'rebuilt'))

    // 没有任何 reset 控制消息，清屏也必须发生，而且排在写入之前 ——
    // 否则这段接不上的内容会被叠在旧屏幕后面（"很多份 logo"的成因）
    expect(h.events).toEqual(['out:1', 'reset:1', 'out:1'])
  })

  it('同一段 reset 回放到两次是重建两次，不是追加两次', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())

    h.socket().deliverFrame(resetFrame(1000n, 'rebuilt'))
    h.socket().deliverFrame(resetFrame(1000n, 'rebuilt'))

    expect(h.events).toEqual(['reset:1', 'out:1', 'reset:1', 'out:1'])
    // 记账不能因为重复而漂移
    expect(h.conn.outSeqOf(1)).toBe(1007)
  })

  it('reset 之后回到 live：后续帧不再算回放', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())

    h.socket().deliverFrame(resetFrame(1000n, 'rebuilt'))
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 1007n, payload: text('x') })

    expect(h.output.map((o) => o.isReplay)).toEqual([true, false])
  })

  it('subscribe 把切回时补的那段标成回放', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome({ sessions: [], resumed: [] }))

    // 切走期间 agent 用 session.updated 报进度（未读就是这么推导的）
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: text('ab') })
    h.socket().deliverText({ t: 'session.updated', sid: 1, head_seq: 100 })
    expect(h.conn.isUnread(1)).toBe(true)

    h.conn.subscribe(1)
    // 补课：追到 head_seq 之前都是回放 —— 历史里的 DSR/DA 应答不能被当成用户输入
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 2n, payload: text('c'.repeat(98)) })
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 100n, payload: text('live') })

    expect(h.output.map((o) => o.isReplay)).toEqual([false, true, false])
  })

  it('subscribe 上报的是本地进度', () => {
    const h = harness()
    h.conn.connect()
    h.socket().open()
    h.socket().deliverText(welcome())
    h.socket().deliverFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: text('abc') })

    h.conn.subscribe(1)
    const sub = h.socket().sent.filter((s) => typeof s === 'string' && s.includes('"subscribe"'))
    expect(JSON.parse(sub[sub.length - 1] as string)).toMatchObject({ sid: 1, out_seq: 3 })
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
