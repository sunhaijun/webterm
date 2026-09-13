/**
 * WebSocket 连接层 —— 协议 §5 的客户端一侧。
 *
 * 它负责：seq 记账、输入重发队列、指数退避重连、心跳。
 * "永不断线"这个承诺在客户端这边就落在这个文件里（AC-2.1 / AC-2.4）。
 */
import {
  ATTR_PREFIX,
  FLAG_ATTR_PREFIX,
  PROTOCOL_VERSION,
  TYPE_INPUT,
  decodeFrame,
  encodeFrame,
  frameData,
} from '../protocol/frame'
import {
  Code,
  T,
  decodeMessage,
  encodeMessage,
  type Redraw,
  type ResumeReq,
  type ServerMessage,
  type Welcome,
} from '../protocol/messages'
import { Backoff } from './backoff'
import { PendingFullError, ResendQueue } from './resend'

/** 心跳与判死（协议 §5.4 / AC-2.8）。 */
export const PING_INTERVAL = 30_000
export const PONG_TIMEOUT = 10_000
/** 回到前台 / 网络恢复时那一次即时探活的超时（协议 §5.4 / AC-2.20）。 */
export const PROBE_TIMEOUT = 2_000

export type ConnState = 'connecting' | 'online' | 'reconnecting' | 'closed'

/** 每会话的客户端侧记账。 */
interface SessionState {
  /** 已接收的累计输出字节数。续传时上报的就是它。 */
  outSeq: number
  /** agent 侧该会话的累计产出字节数，未读 = headSeq > outSeq。 */
  headSeq: number
  /** 续传/重放时要追赶到的 seq：outSeq 追到它之前收到的输出都算【回放】。 */
  catchupTo: number
  resend: ResendQueue
  subscribed: boolean
}

export interface ConnectionHandlers {
  /**
   * 收到一段输出。isReplay=true 表示这是【回放】（续传或刷新重放历史）——
   * 消费方写这段时要抑制 xterm 对历史查询（DSR/DA…）的自动应答，别当输入送 PTY。
   * （data 若带 reset 前缀，前 4 字节是渲染修正、不计入 seq，withPrefix 已处理。）
   */
  onOutput(sid: number, data: Uint8Array, isReplay: boolean): void
  /**
   * 该会话的屏幕要清掉重建：紧接着的那一帧与屏幕上现有的内容【接不上】。
   *
   * 由帧上的 ATTR_PREFIX 驱动（协议 §3），**不等** `reset` 控制消息 —— 帧自己
   * 就带着"这是重建不是续写"的语义。少了这一步，一段接不上的内容会被叠在旧
   * 屏幕后面，来回切几次会话就叠几份（"很多份 logo"的由来）。
   */
  onResetScreen(sid: number): void
  /**
   * 备用屏会话的重建（协议 §4.2 `redraw`，ADR-0019）：清屏 → 写 `modes` 恢复
   * 粘性模式 → 等程序自己整屏重画。
   *
   * 与 onResetScreen 的区别是**不回放历史**：备用屏没有 scrollback，窗口里的
   * 差分帧离开会话开头那一个 ESC[?1049h 就没有意义。也【不提示"历史已截断"】——
   * 那条提示在这里是误导。
   */
  onRedraw(sid: number, modes: string): void
  onMessage(msg: ServerMessage): void
  onState(state: ConnState, info: StateInfo): void
  /** 出现无法自行修补的错误（如 seq 空洞）。 */
  onFatal?(reason: string): void
}

export interface StateInfo {
  /** 重连中：距下次重试还有多少毫秒。 */
  retryInMs?: number
  /** 已恢复：这一次续传补齐了多少字节。 */
  replayedBytes?: number
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
  /** agent 实例 id。重连时带回去，不符说明 agent 重启过（协议 §5.2）。 */
  private instanceID: string | undefined
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private pongTimer: ReturnType<typeof setTimeout> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private countdownTimer: ReturnType<typeof setInterval> | undefined
  private lastPingAt = 0
  private replayedBytes = 0
  private stopped = false

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

  /** 未读 = agent 侧已产出的字节数 超过 本地已收到的。 */
  isUnread(sid: number): boolean {
    const s = this.sessions.get(sid)
    return s ? s.headSeq > s.outSeq : false
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
        this.opts.handlers.onFatal?.('离线输入已满，请等待重连后再输入')
        return
      }
      throw e
    }
    this.writeFrame(sid, item.seq, item.bytes)
  }

  send(msg: object): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(encodeMessage(msg))
  }

  /**
   * 订阅某个会话。cols/rows 是当前终端尺寸 —— **必须和 subscribe 在同一条消息里**
   * （协议 §4.1）：单发 resize 无论排前排后都有坑，排后面 agent 补的是按旧尺寸
   * 排版的积压，排前面程序的整屏重画会落在 redraw.seq 之前被跳过。
   */
  subscribe(sid: number, cols = 0, rows = 0): void {
    const st = this.ensure(sid)
    st.subscribed = true
    // 切回时 agent 补的那一段是【回放】，不是实时输出：outSeq 追到 headSeq
    // 之前收到的都要抑制 xterm 对历史查询的自动应答（协议 §5.2）。
    // 漏标的话，每切回一次就给前台程序喂一串乱码"按键"
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

  forget(sid: number): void {
    this.sessions.delete(sid)
  }

  private writeFrame(sid: number, seq: number, bytes: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== 1) return // 离线：留在 pending 里，重连后重发
    this.ws.send(
      encodeFrame({ type: TYPE_INPUT, flags: 0, sid, seq: BigInt(seq), payload: bytes }),
    )
  }

  // ---------- 连接生命周期 ----------

  private open(): void {
    this.clearTimers()
    this.setState(this.backoff.attempts === 0 ? 'connecting' : 'reconnecting')
    this.replayedBytes = 0

    const make = this.opts.socketFactory ?? ((u: string) => new WebSocket(u) as unknown as WebSocketLike)
    const ws = make(this.opts.url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => {
      // 只把【当前可见】的会话列进 resume，避免重连瞬间涌入大量数据。
      // 其余会话由 UI 在用户切过去时用 subscribe{out_seq} 补齐（协议 §5.2）。
      const resume: ResumeReq[] = []
      for (const [sid, st] of this.sessions) {
        if (st.subscribed) resume.push({ sid, out_seq: st.outSeq })
      }
      ws.send(
        encodeMessage({
          t: T.hello,
          protocol: PROTOCOL_VERSION,
          client_id: this.opts.clientID,
          instance_id: this.instanceID,
          resume,
        }),
      )
    }

    ws.onmessage = (ev) => this.onMessage(ev.data)
    ws.onerror = () => {
      /* onclose 会跟着来，统一在那里处理 */
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.clearTimers()
      if (this.stopped) {
        this.setState('closed')
        return
      }
      this.scheduleRetry()
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
   * **自认在线时不能直接返回**（AC-2.20 / ADR-0020）。线路断了不一定有
   * `onclose` —— 息屏、切 App、Wi-Fi 切蜂窝、NAT 回收，TCP 上都没有 FIN，
   * socket 的 `readyState` 一直是 OPEN。这种【僵尸连接】自认在线，打字全写进
   * 一条死 socket，屏幕上什么都不变，而唯一的暴露渠道只有心跳，最坏 40 秒。
   *
   * 而 `online` / 页面重新可见是**已知的可疑时刻**：此时连接要么活着（本机
   * RTT 远小于 2 秒），要么就是死的。所以这里立刻探一次，2 秒没有 pong 就判死。
   * 判错的代价只是多一次重连，而重连是无损的（续传 + 按 in_ack 重发）。
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
    let f
    try {
      f = decodeFrame(raw)
    } catch {
      this.fail('收到非法的二进制帧')
      return
    }
    const st = this.ensure(f.sid)
    const attrPrefix = (f.flags & FLAG_ATTR_PREFIX) !== 0
    const data = frameData(f)
    const seq = Number(f.seq)

    if (attrPrefix) {
      // reset 回放：客户端清屏，然后从这里重新开始记账。
      // 前置的 4 个字节是渲染修正，【不计入 seq】。
      st.outSeq = seq + data.length
      st.headSeq = Math.max(st.headSeq, st.outSeq)
      st.catchupTo = st.outSeq // reset 已重绘到当前，之后就是 live
      this.replayedBytes += data.length
      // 【先清屏再写】。这一帧与屏幕上的内容接不上：它的起点是缓冲窗口的开头，
      // 中间那段已经被裁掉了。不清屏就是把两段无关的内容首尾相接。
      // 也【不做去重】—— 清屏之后屏幕是空的，重复到达的同一段必须照写一遍
      this.opts.handlers.onResetScreen(f.sid)
      this.opts.handlers.onOutput(f.sid, withPrefix(data), true) // reset 回放 = isReplay
      return
    }

    if (seq > st.outSeq) {
      // 出现空洞 —— 不该发生。【立即关闭连接并走重连续传】，不要自行修补。
      this.fail(`会话 ${f.sid} 的输出流出现空洞（期望 ${st.outSeq}，收到 ${seq}）`)
      return
    }
    if (seq + data.length <= st.outSeq) {
      return // 完全重复的数据，丢弃
    }
    // 部分重叠：只取没收过的那一段
    const skip = st.outSeq - seq
    const fresh = skip > 0 ? data.subarray(skip) : data
    const freshSeq = st.outSeq
    st.outSeq += fresh.length
    st.headSeq = Math.max(st.headSeq, st.outSeq)
    this.replayedBytes += fresh.length
    // outSeq 追到 catchupTo 之前的这些输出都是续传回放 —— 抑制查询自动应答
    this.opts.handlers.onOutput(f.sid, fresh, freshSeq < st.catchupTo)
  }

  private handleControl(msg: ServerMessage): void {
    switch (msg.t) {
      case T.welcome:
        this.onWelcome(msg as Welcome)
        break

      case T.ack: {
        const st = this.ensure(msg.sid)
        st.resend.ack(msg.in_ack)
        break
      }

      case T.redraw: {
        const m = msg as Redraw
        const st = this.ensure(m.sid)
        // modes 不计入 seq（协议 §3）；out_seq 直接跳到 seq，
        // 跳过的那些字节是备用屏的差分帧，【有意丢弃】
        st.outSeq = m.seq
        st.headSeq = Math.max(st.headSeq, m.seq)
        st.catchupTo = m.seq // 重画之后就是 live
        this.opts.handlers.onRedraw(m.sid, m.modes)
        break
      }

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

      case T.error: {
        // 致命错误由服务端随后关连接；这里只把原因透出去
        if (msg.code === Code.unauthorized || msg.code === Code.protocolUnsupported) {
          this.opts.handlers.onFatal?.(msg.message)
        }
        break
      }
    }
    this.opts.handlers.onMessage(msg)
  }

  private onWelcome(w: Welcome): void {
    this.instanceID = w.instance_id
    this.backoff.reset()

    for (const r of w.resumed) {
      const st = this.ensure(r.sid)
      if (r.status === 'gone') {
        // agent 重启过、或会话已销毁
        st.resend.reset()
        this.sessions.delete(r.sid)
        continue
      }
      if (r.status === 'reset') {
        st.outSeq = r.from_seq
      }
      // 按 in_ack 裁剪重发队列，然后【按 seq 升序】重发其后的全部输入
      for (const item of st.resend.resumeFrom(r.in_ack)) {
        this.writeFrame(r.sid, item.seq, item.bytes)
      }
    }
    for (const s of w.sessions) {
      const st = this.ensure(s.sid)
      st.headSeq = Math.max(st.headSeq, s.head_seq)
      // 续传要把 outSeq 追到 head_seq；这段追赶输出都是回放，抑制查询自动应答
      st.catchupTo = s.head_seq
    }

    this.setState('online', { replayedBytes: this.replayedBytes })
    this.startHeartbeat()
  }

  // ---------- 心跳 ----------

  private startHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => this.sendPing(PONG_TIMEOUT), PING_INTERVAL)
  }

  /**
   * 发一个 ping 并武装判死定时器：`timeout` 内没有 pong 就主动关闭并重连。
   *
   * 心跳（10 秒）与即时探活（2 秒）走同一条路 —— 区别只有超时长短，
   * 因为它们问的是同一个问题：这条连接还活着吗。
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
    this.opts.handlers.onFatal?.(reason)
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

function withPrefix(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(ATTR_PREFIX.length + data.length)
  out.set(ATTR_PREFIX)
  out.set(data, ATTR_PREFIX.length)
  return out
}
