/**
 * WebSocket 连接层 —— 协议 §5 的客户端一侧（v2）。
 *
 * 它负责：seq 记账、快照分帧拼装、回放区间（catchup_to）、输入重发队列、
 * 指数退避重连、心跳。"永不断线"这个承诺在客户端这边就落在这个文件里
 * （AC-2.1 / AC-2.4 / AC-2.6）。
 */
import {
  PROTOCOL_VERSION,
  TYPE_INPUT,
  TYPE_SNAPSHOT,
  decodeFrame,
  encodeFrame,
  hasMore,
  type Frame,
} from '../protocol/frame'
import {
  Code,
  T,
  decodeMessage,
  encodeMessage,
  type Hello,
  type ResumeReq,
  type ServerMessage,
  type Welcome,
} from '../protocol/messages'
import { inputTrace } from '../keys/inputstats'
import { Backoff } from './backoff'
import { PendingFullError, ResendQueue } from './resend'

/** 心跳与判死（协议 §5.5 / AC-2.8）。 */
export const PING_INTERVAL = 30_000
export const PONG_TIMEOUT = 10_000
/** 回到前台 / 网络恢复时那一次即时探活的超时（协议 §5.5 / AC-2.20）。 */
export const PROBE_TIMEOUT = 2_000
/** `frames()` 留最近多少帧（E2E 用来看收到的是 OUTPUT 还是 SNAPSHOT）。 */
export const FRAME_LOG = 512

export type ConnState = 'connecting' | 'online' | 'reconnecting' | 'closed'

/** 每会话的客户端侧记账。 */
interface SessionState {
  /** 已接收的累计输出字节数。续传时上报的就是它。 */
  outSeq: number
  /** agent 侧该会话的累计产出字节数，未读 = headSeq > outSeq。 */
  headSeq: number
  /** 回放门（§5.3）：outSeq 追到它之前收到的 OUTPUT 都算回放。 */
  catchupTo: number
  resend: ResendQueue
  subscribed: boolean
}

/** 一份正在收的快照：同一个 seq，除最后一帧外都带 MORE（§3）。 */
interface SnapshotAssembly {
  seq: number
  parts: Uint8Array[]
}

/** 收到的一帧（`__webterm.frames()`）。 */
export interface FrameRecord {
  type: number
  kind: 'OUTPUT' | 'SNAPSHOT'
  sid: number
  seq: number
  flags: number
  /** payload 字节数。 */
  bytes: number
  /** 这一帧是否按回放写入（快照恒为 true）。 */
  replay: boolean
}

export interface ConnectionHandlers {
  /**
   * 一段输出（OUTPUT 帧去重之后的新字节）。isReplay=true：这段在 `catchup_to` 之前，
   * 是补课 —— 写进终端时要拦住 xterm 对历史查询的自动应答（§5.3）。
   */
  onOutput(sid: number, data: Uint8Array, isReplay: boolean): void
  /**
   * 一份收齐的快照（§3）。消费方：reset → 换新的 UTF-8 解码器 → 当作回放写入。
   * 调用之前 outSeq 已经置为 seq。
   */
  onSnapshot(sid: number, data: Uint8Array, seq: number): void
  onMessage(msg: ServerMessage): void
  onState(state: ConnState, info: StateInfo): void
  /** 重连后，所有续传的会话都追平了：这一次补齐了多少字节（补课 + 快照）。首次连接不报。 */
  onRecovered?(bytes: number): void
  /**
   * agent 的 instance_id 变了（真重启过，§5.3）：本地每个会话都作废了。
   * 在把 welcome 交给 onMessage 之前调用。
   */
  onRestart?(): void
  /** agent 判了致命错误（协议版本不符）：重连也没用，要用户处理。 */
  onFatal?(reason: string): void
  /** 设备被吊销（`error{code:"unauthorized"}`，AC-1.11）。agent 随后会关连接。 */
  onUnauthorized?(message: string): void
  /** 可恢复的错误（seq 空洞、非法帧 → 已关连接走续传；离线输入已满）：提示一下即可。 */
  onError?(reason: string): void
  /**
   * 连接断了（不是 close() 主动关的）。welcomed=false：这条连接一个 welcome 都没收到 ——
   * 升级被拒（401 / 403）在浏览器里就长这样，WebSocket 不给 HTTP 状态码。
   */
  onClosed?(welcomed: boolean): void
}

export interface StateInfo {
  /** 重连中：距下次重试还有多少毫秒。 */
  retryInMs?: number
  rttMs?: number
}

export interface ConnectionOptions {
  url: string
  clientID: string
  handlers: ConnectionHandlers
  backoff?: Backoff
  /** 仅供测试注入。 */
  now?: () => number
  socketFactory?: (url: string) => WebSocketLike
}

/** WebSocket 的最小接口，方便单测替身。 */
export interface WebSocketLike {
  binaryType: string
  readyState: number
  send(data: string | ArrayBufferLike | ArrayBufferView): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
}

export class Connection {
  private readonly opts: ConnectionOptions
  private readonly backoff: Backoff
  private readonly now: () => number
  private ws: WebSocketLike | null = null
  private state: ConnState = 'closed'
  private sessions = new Map<number, SessionState>()
  private snapshots = new Map<number, SnapshotAssembly>()
  /** agent 实例 id。重连时带回去，不符说明 agent 重启过（协议 §5.3）。 */
  private instanceID: string | undefined
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private pongTimer: ReturnType<typeof setTimeout> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private countdownTimer: ReturnType<typeof setInterval> | undefined
  private lastPingAt = 0
  private stopped = false
  private welcomed = false
  /** 当前这条 socket 收到过 welcome 没有。 */
  private socketWelcomed = false
  /** 重连后还没追平的会话 → 要追到的 seq（-1 = 等快照），以及已经补了多少字节。 */
  private recovery: { targets: Map<number, number>; bytes: number } | null = null
  private readonly log: FrameRecord[] = []

  constructor(opts: ConnectionOptions) {
    this.opts = opts
    this.backoff = opts.backoff ?? new Backoff()
    this.now = opts.now ?? (() => Date.now())
  }

  get currentState(): ConnState {
    return this.state
  }

  /** 某会话的接收进度（续传时上报它）。 */
  outSeqOf(sid: number): number {
    return this.sessions.get(sid)?.outSeq ?? 0
  }

  /** agent 侧该会话已产出到哪里（已知的最大值）。 */
  headSeqOf(sid: number): number {
    return this.sessions.get(sid)?.headSeq ?? 0
  }

  /** 未读 = agent 侧已产出的字节数 超过 本地已收到的。 */
  isUnread(sid: number): boolean {
    const s = this.sessions.get(sid)
    return s ? s.headSeq > s.outSeq : false
  }

  /** 最近收到的二进制帧（只读副本）。 */
  frames(): FrameRecord[] {
    return this.log.slice()
  }

  connect(): void {
    this.stopped = false
    this.open()
  }

  close(): void {
    this.stopped = true
    this.clearTimers()
    this.ws?.close(1000, 'client closing')
    this.ws = null
    this.setState('closed')
  }

  // ---------- 发送 ----------

  /** 发一段输入。分配 in_seq、入重发队列、写线上。 */
  sendInput(sid: number, bytes: Uint8Array): void {
    const st = this.ensure(sid)
    let item
    try {
      item = st.resend.push(bytes)
    } catch (e) {
      if (e instanceof PendingFullError) {
        this.opts.handlers.onError?.('离线输入已满，请等待重连后再输入')
        return
      }
      throw e
    }
    // 输入路径探针的"发给 agent"那一段（AC-3.17）
    inputTrace.bump('sent')
    this.writeFrame(sid, item.seq, item.bytes)
  }

  /** 发了但 agent 还没 ack 的字节数（排障用，AC-3.17）：涨着不降 = 没送到。 */
  unackedOf(sid: number): number {
    return this.sessions.get(sid)?.resend.pendingBytes ?? 0
  }

  send(msg: object): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(encodeMessage(msg))
  }

  /**
   * 订阅某个会话。cols/rows 是当前终端尺寸 —— **必须和 subscribe 在同一条消息里**
   * （协议 §4.1）：agent 锁内先按尺寸决定走增量还是快照，锁外才 TIOCSWINSZ，
   * 程序因 SIGWINCH 重画的字节才一定排在后面。
   */
  subscribe(sid: number, cols = 0, rows = 0): void {
    const st = this.ensure(sid)
    st.subscribed = true
    // 切回时 agent 补的那一段是回放：outSeq 追到已知 head 之前的都拦自动应答（§5.3）。
    // agent 若改走快照，快照到达时 catchupTo 会重置成快照的 seq
    st.catchupTo = Math.max(st.catchupTo, st.headSeq)
    const msg: Record<string, unknown> = { t: T.subscribe, sid, out_seq: st.outSeq }
    if (cols > 0 && rows > 0) {
      msg.cols = cols
      msg.rows = rows
    }
    this.send(msg)
  }

  unsubscribe(sid: number): void {
    const st = this.sessions.get(sid)
    if (st) st.subscribed = false
    this.send({ t: T.unsubscribe, sid })
  }

  /** 会话已销毁：丢掉它的全部记账。 */
  forget(sid: number): void {
    this.sessions.delete(sid)
    this.snapshots.delete(sid)
    this.recovery?.targets.delete(sid)
  }

  private writeFrame(sid: number, seq: number, bytes: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== 1) return // 离线：留在 pending 里，重连后重发
    this.ws.send(encodeFrame({ type: TYPE_INPUT, flags: 0, sid, seq: BigInt(seq), payload: bytes }))
  }

  // ---------- 连接生命周期 ----------

  private open(): void {
    this.clearTimers()
    this.setState(this.backoff.attempts === 0 && !this.welcomed ? 'connecting' : 'reconnecting')

    const make = this.opts.socketFactory ?? ((u: string) => new WebSocket(u) as unknown as WebSocketLike)
    const ws = make(this.opts.url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => {
      // 只把【订阅中】的会话（当前可见的 + 保持接收的）列进 resume，避免重连瞬间
      // 涌入大量数据。其余会话在用户切过去时用 subscribe{out_seq} 补齐（协议 §5.3）。
      const resume: ResumeReq[] = []
      for (const [sid, st] of this.sessions) {
        if (st.subscribed) resume.push({ sid, out_seq: st.outSeq })
      }
      ws.send(
        encodeMessage({
          t: T.hello,
          protocol: PROTOCOL_VERSION,
          client_id: this.opts.clientID,
          instance_id: this.instanceID ?? null,
          resume,
        } satisfies Hello),
      )
    }

    this.socketWelcomed = false
    ws.onmessage = (ev) => this.onMessage(ev.data)
    ws.onerror = () => {
      /* onclose 会跟着来，统一在那里处理 */
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.clearTimers()
      // 半份快照没用了：重连后 agent 会按 out_seq 重新判定
      this.snapshots.clear()
      this.recovery = null
      if (this.stopped) {
        this.setState('closed')
        return
      }
      this.scheduleRetry()
      this.opts.handlers.onClosed?.(this.socketWelcomed)
    }
  }

  private scheduleRetry(): void {
    const delay = this.backoff.next()
    const until = this.now() + delay
    this.setState('reconnecting', { retryInMs: delay })
    // 倒计时实时更新，让"重连中 · 3s 后重试"这个提示是真的在走（AC-2.10）
    this.countdownTimer = setInterval(() => {
      const left = Math.max(0, until - this.now())
      this.opts.handlers.onState('reconnecting', { retryInMs: left })
    }, 250)
    this.retryTimer = setTimeout(() => this.open(), delay)
  }

  /**
   * 网络恢复 / 页面重新可见：立即重试一次并重置退避（AC-2.9）。
   *
   * **自认在线时不能直接返回**（AC-2.20 / ADR-0020）：线路断了不一定有 `onclose`
   * （息屏、切网、NAT 回收），这种僵尸连接只有心跳戳得穿。`online` / 重新可见是
   * 已知的可疑时刻，立刻探一次，2 秒没有 pong 就判死。判错的代价只是多一次无损重连。
   */
  retryNow(): void {
    if (this.stopped) return
    if (this.state === 'online') {
      this.sendPing(PROBE_TIMEOUT)
      return
    }
    this.backoff.reset()
    this.clearTimers()
    this.open()
  }

  // ---------- 接收 ----------

  private onMessage(data: unknown): void {
    if (typeof data === 'string') {
      const msg = decodeMessage(data)
      if (!msg) return // 未知 t 值：忽略，不关连接（前向兼容）
      this.handleControl(msg)
      return
    }
    if (data instanceof ArrayBuffer) this.handleBinary(new Uint8Array(data))
  }

  private handleBinary(raw: Uint8Array): void {
    let f: Frame
    try {
      f = decodeFrame(raw)
    } catch {
      this.fail('收到非法的二进制帧')
      return
    }
    if (f.type === TYPE_INPUT) {
      this.fail('agent 发来了 INPUT 帧')
      return
    }
    const st = this.ensure(f.sid)
    const seq = Number(f.seq)
    if (f.type === TYPE_SNAPSHOT) {
      this.handleSnapshot(st, f, seq)
      return
    }

    // agent 保证一份快照的各帧之间不夹杂同一会话的其它帧（§3）
    if (this.snapshots.has(f.sid)) {
      this.fail(`会话 ${f.sid} 的快照还没收齐就来了 OUTPUT`)
      return
    }
    if (seq > st.outSeq) {
      // 出现空洞 —— 不该发生。【立即关闭连接并走重连续传】，不要自行修补。
      this.fail(`会话 ${f.sid} 的输出流出现空洞（期望 ${st.outSeq}，收到 ${seq}）`)
      return
    }
    if (seq + f.payload.length <= st.outSeq) return // 完全重复的数据，丢弃
    // 部分重叠：只取没收过的那一段
    const skip = st.outSeq - seq
    const fresh = skip > 0 ? f.payload.subarray(skip) : f.payload
    const freshSeq = st.outSeq
    st.outSeq += fresh.length
    st.headSeq = Math.max(st.headSeq, st.outSeq)
    // outSeq 追到 catchupTo 之前的这些输出都是补课 —— 拦自动应答
    const replay = freshSeq < st.catchupTo
    this.record(f, seq, replay)
    this.recovered(f.sid, fresh.length, st.outSeq)
    this.opts.handlers.onOutput(f.sid, fresh, replay)
  }

  /** 收快照：同一 seq 的帧拼齐（最后一帧不带 MORE）再交出去。 */
  private handleSnapshot(st: SessionState, f: Frame, seq: number): void {
    let asm = this.snapshots.get(f.sid)
    if (asm && asm.seq !== seq) {
      this.fail(`会话 ${f.sid} 的快照帧 seq 不一致（${asm.seq} / ${seq}）`)
      return
    }
    if (!asm) {
      asm = { seq, parts: [] }
      this.snapshots.set(f.sid, asm)
    }
    asm.parts.push(f.payload)
    this.record(f, seq, true)
    if (hasMore(f)) return

    this.snapshots.delete(f.sid)
    const data = concat(asm.parts)
    // 快照的字节不计入 out_seq：它就是 seq 那一刻的完整画面，之后从 seq 接 OUTPUT
    st.outSeq = seq
    st.headSeq = Math.max(st.headSeq, seq)
    st.catchupTo = seq
    this.recovered(f.sid, data.length, Infinity)
    this.opts.handlers.onSnapshot(f.sid, data, seq)
  }

  private handleControl(msg: ServerMessage): void {
    switch (msg.t) {
      case T.welcome:
        this.onWelcome(msg)
        break

      case T.ack:
        this.ensure(msg.sid).resend.ack(msg.in_ack)
        break

      case T.sessionUpdated: {
        const st = this.ensure(msg.sid)
        if (msg.head_seq !== undefined) st.headSeq = Math.max(st.headSeq, msg.head_seq)
        break
      }

      case T.pong: {
        if (this.pongTimer) clearTimeout(this.pongTimer)
        this.pongTimer = undefined
        this.opts.handlers.onState('online', { rttMs: this.now() - this.lastPingAt })
        break
      }

      case T.error:
        // 致命错误由服务端随后关连接；这里只把原因透出去
        if (msg.code === Code.unauthorized) this.opts.handlers.onUnauthorized?.(msg.message)
        if (msg.code === Code.protocolUnsupported) {
          this.opts.handlers.onFatal?.(`agent 已升级，请刷新页面（${msg.message}）`)
        }
        break
    }
    this.opts.handlers.onMessage(msg)
  }

  private onWelcome(w: Welcome): void {
    const restarted = this.instanceID !== undefined && this.instanceID !== w.instance_id
    this.instanceID = w.instance_id
    this.backoff.reset()

    if (restarted) {
      // agent 真重启过：sid 会被重新分配，本地的进度一个都不能再用（AC-2.13）
      this.sessions.clear()
      this.snapshots.clear()
      this.opts.handlers.onRestart?.()
    }

    // 先记 head：status=ok 的补课要追到这里，回放门也按它划（§5.3 的表）
    for (const s of w.sessions) {
      const st = this.ensure(s.sid)
      st.headSeq = Math.max(st.headSeq, s.head_seq)
      st.catchupTo = Math.max(st.catchupTo, s.head_seq)
    }

    const targets = new Map<number, number>()
    for (const r of w.resumed) {
      const st = this.ensure(r.sid)
      if (r.status === 'gone') {
        // agent 重启过、或会话已销毁
        this.forget(r.sid)
        continue
      }
      if (r.status === 'snapshot') targets.set(r.sid, -1)
      else if (st.outSeq < st.headSeq) targets.set(r.sid, st.headSeq)
      // 按 in_ack 裁剪重发队列，然后【按 seq 升序】重发其后的全部输入（§5.4）
      for (const item of st.resend.resumeFrom(r.in_ack)) {
        this.writeFrame(r.sid, item.seq, item.bytes)
      }
    }

    const reconnect = this.welcomed
    this.welcomed = true
    this.socketWelcomed = true
    this.setState('online')
    this.startHeartbeat()
    this.recovery = reconnect && !restarted ? { targets, bytes: 0 } : null
    this.recovered(-1, 0, 0)
  }

  /** 续传进度：某会话补到了 outSeq（快照传 Infinity）。全部追平时报一次。 */
  private recovered(sid: number, bytes: number, outSeq: number): void {
    const r = this.recovery
    if (!r) return
    const target = r.targets.get(sid)
    if (target !== undefined) {
      r.bytes += bytes
      if (target >= 0 ? outSeq >= target : outSeq === Infinity) r.targets.delete(sid)
    }
    if (r.targets.size > 0) return
    this.recovery = null
    this.opts.handlers.onRecovered?.(r.bytes)
  }

  private record(f: Frame, seq: number, replay: boolean): void {
    this.log.push({
      type: f.type,
      kind: f.type === TYPE_SNAPSHOT ? 'SNAPSHOT' : 'OUTPUT',
      sid: f.sid,
      seq,
      flags: f.flags,
      bytes: f.payload.length,
      replay,
    })
    if (this.log.length > FRAME_LOG) this.log.splice(0, this.log.length - FRAME_LOG)
  }

  // ---------- 心跳 ----------

  private startHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => this.sendPing(PONG_TIMEOUT), PING_INTERVAL)
  }

  /**
   * 发一个 ping 并武装判死定时器：`timeout` 内没有 pong 就主动关闭并重连。
   * 心跳（10 秒）与即时探活（2 秒）问的是同一个问题，只是等的时间不同。
   */
  private sendPing(timeout: number): void {
    if (!this.ws || this.ws.readyState !== 1) return
    this.lastPingAt = this.now()
    this.send({ t: T.ping, ts: this.lastPingAt })
    if (this.pongTimer) clearTimeout(this.pongTimer)
    this.pongTimer = setTimeout(() => this.ws?.close(4000, 'pong timeout'), timeout)
  }

  // ---------- 杂项 ----------

  private ensure(sid: number): SessionState {
    let st = this.sessions.get(sid)
    if (!st) {
      st = { outSeq: 0, headSeq: 0, catchupTo: 0, resend: new ResendQueue(), subscribed: false }
      this.sessions.set(sid, st)
    }
    return st
  }

  private fail(reason: string): void {
    this.opts.handlers.onError?.(reason)
    this.ws?.close(4001, 'protocol error')
  }

  private setState(s: ConnState, info: StateInfo = {}): void {
    this.state = s
    this.opts.handlers.onState(s, info)
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.pongTimer) clearTimeout(this.pongTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.countdownTimer) clearInterval(this.countdownTimer)
    this.pingTimer = this.pongTimer = this.retryTimer = this.countdownTimer = undefined
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}
