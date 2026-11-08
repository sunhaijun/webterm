/**
 * WebSocket connection layer: the client side of protocol §5 (v2).
 *
 * Handles seq accounting, snapshot reassembly, the replay window (catchup_to), the input
 * resend queue, exponential-backoff reconnects and heartbeats. On the client, the "never
 * lose the session" promise lives in this file (AC-2.1 / AC-2.4 / AC-2.6).
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
import { PENDING_LIMIT, PendingFullError, ResendQueue } from './resend'

/** Heartbeat and dead-connection detection (protocol §5.5 / AC-2.8). */
export const PING_INTERVAL = 30_000
export const PONG_TIMEOUT = 10_000
/** Timeout for the immediate probe when the page returns to the foreground or the network comes back (protocol §5.5 / AC-2.20). */
export const PROBE_TIMEOUT = 2_000
/** How many recent frames `frames()` keeps (E2E uses it to tell OUTPUT from SNAPSHOT). */
export const FRAME_LOG = 512

export type ConnState = 'connecting' | 'online' | 'reconnecting' | 'closed'

/** Per-session client-side accounting. */
interface SessionState {
  /** Total output bytes received; this is what we report when resuming. */
  outSeq: number
  /** Total output bytes the agent has produced for this session; the replay gate's catchupTo follows it. */
  headSeq: number
  /** Replay gate (§5.3): OUTPUT received before outSeq reaches this counts as replay. */
  catchupTo: number
  resend: ResendQueue
  subscribed: boolean
}

/** A snapshot being received: all frames share one seq; all but the last carry MORE (§3). */
interface SnapshotAssembly {
  seq: number
  parts: Uint8Array[]
}

/** A received frame (`__webterm.frames()`). */
export interface FrameRecord {
  type: number
  kind: 'OUTPUT' | 'SNAPSHOT'
  sid: number
  seq: number
  flags: number
  /** Payload size in bytes. */
  bytes: number
  /** Whether the frame was written as replay (always true for snapshots). */
  replay: boolean
}

export interface ConnectionHandlers {
  /**
   * New output bytes (OUTPUT frames after dedup). isReplay=true means the bytes precede
   * `catchup_to` and are catch-up: xterm's automatic replies to old queries must be
   * suppressed when writing them (§5.3).
   */
  onOutput(sid: number, data: Uint8Array, isReplay: boolean): void
  /**
   * A complete snapshot (§3). The consumer resets, swaps in a fresh UTF-8 decoder, and
   * writes it as replay. outSeq is already set to seq when this is called.
   */
  onSnapshot(sid: number, data: Uint8Array, seq: number): void
  onMessage(msg: ServerMessage): void
  onState(state: ConnState, info: StateInfo): void
  /** After a reconnect, every resumed session has caught up; reports the bytes fetched (catch-up + snapshots). Not called on the first connect. */
  onRecovered?(bytes: number): void
  /**
   * The agent's instance_id changed (it really restarted, §5.3), so every local session is
   * void. Called before the welcome is passed to onMessage.
   */
  onRestart?(): void
  /** The agent reported a fatal error (protocol version mismatch); reconnecting won't help, the user must act. */
  onFatal?(reason: string): void
  /** Device revoked (`error{code:"unauthorized"}`, AC-1.11). The agent closes the connection next. */
  onUnauthorized?(message: string): void
  /** Recoverable errors worth a notice: seq gap or bad frame (connection closed, will resume), offline input full. */
  onError?(reason: string): void
  /**
   * The connection dropped (not via close()). welcomed=false means this socket never got a
   * welcome, which is how a rejected upgrade (401 / 403) looks in a browser: WebSocket
   * doesn't expose the HTTP status.
   */
  onClosed?(welcomed: boolean): void
}

export interface StateInfo {
  /** While reconnecting: milliseconds until the next attempt. */
  retryInMs?: number
  rttMs?: number
}

export interface ConnectionOptions {
  url: string
  clientID: string
  handlers: ConnectionHandlers
  backoff?: Backoff
  /** Test injection only. */
  now?: () => number
  socketFactory?: (url: string) => WebSocketLike
}

/** The minimal WebSocket surface, so unit tests can substitute a fake. */
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
  /** Agent instance id. Sent back on reconnect; a mismatch means the agent restarted (protocol §5.3). */
  private instanceID: string | undefined
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private pongTimer: ReturnType<typeof setTimeout> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private countdownTimer: ReturnType<typeof setInterval> | undefined
  private lastPingAt = 0
  private stopped = false
  private welcomed = false
  /** Whether the current socket has received a welcome. */
  private socketWelcomed = false
  /** After a reconnect: sessions not caught up yet → target seq (-1 = awaiting snapshot), plus bytes fetched so far. */
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

  /** How far a session has been received (reported when resuming). */
  outSeqOf(sid: number): number {
    return this.sessions.get(sid)?.outSeq ?? 0
  }

  /** How far the agent has produced output for a session (highest known). */
  headSeqOf(sid: number): number {
    return this.sessions.get(sid)?.headSeq ?? 0
  }

  /** Recently received binary frames (a copy). */
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

  // ---------- Sending ----------

  /**
   * Sends input: assigns in_seq, queues it for resend, writes it to the wire. Returns false
   * when the input was refused (too large, or the resend queue is full); the user has been
   * told, and the caller must not act as if it was sent (protocol §5.4).
   */
  sendInput(sid: number, bytes: Uint8Array): boolean {
    const st = this.ensure(sid)
    let item
    try {
      item = st.resend.push(bytes)
    } catch (e) {
      if (e instanceof PendingFullError) {
        this.opts.handlers.onError?.(
          bytes.length > PENDING_LIMIT
            ? `Input too large (over ${PENDING_LIMIT >> 10} KiB); send it in smaller pieces`
            : 'Input buffer full; wait for the connection to catch up',
        )
        return false
      }
      throw e
    }
    // The "sent to agent" stage of the input-path probe (AC-3.17)
    inputTrace.bump('sent')
    this.writeFrame(sid, item.seq, item.bytes)
    return true
  }

  /** Bytes sent but not yet acked by the agent (for debugging, AC-3.17); growing and never shrinking means they aren't arriving. */
  unackedOf(sid: number): number {
    return this.sessions.get(sid)?.resend.pendingBytes ?? 0
  }

  send(msg: object): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(encodeMessage(msg))
  }

  /**
   * Subscribes to a session. cols/rows are the current terminal size and must travel in the
   * same message as subscribe (protocol §4.1): under its lock the agent picks delta or
   * snapshot by size, and only then applies TIOCSWINSZ, so the program's SIGWINCH redraw is
   * guaranteed to come after.
   */
  subscribe(sid: number, cols = 0, rows = 0): void {
    const st = this.ensure(sid)
    st.subscribed = true
    // What the agent sends on switch-back is replay: suppress automatic replies until outSeq
    // reaches the known head (§5.3). If the agent sends a snapshot instead, catchupTo is reset
    // to the snapshot's seq when it arrives.
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

  /** The session is gone: drop all its accounting. */
  forget(sid: number): void {
    this.sessions.delete(sid)
    this.snapshots.delete(sid)
    this.recovery?.targets.delete(sid)
  }

  private writeFrame(sid: number, seq: number, bytes: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== 1) return // Offline: it stays pending and is resent after reconnecting
    this.ws.send(encodeFrame({ type: TYPE_INPUT, flags: 0, sid, seq: BigInt(seq), payload: bytes }))
  }

  // ---------- Connection lifecycle ----------

  private open(): void {
    this.clearTimers()
    // A socket still connecting (retryNow while reconnecting) must not live on next to the
    // new one: it would complete its own hello and become an orphan connection.
    if (this.ws) abandon(this.ws, 'superseded')
    this.setState(this.backoff.attempts === 0 && !this.welcomed ? 'connecting' : 'reconnecting')

    const make = this.opts.socketFactory ?? ((u: string) => new WebSocket(u) as unknown as WebSocketLike)
    const ws = make(this.opts.url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => {
      // Only subscribed sessions (the visible one plus pinned ones) go into resume, to avoid
      // a flood of data on reconnect. Others catch up via subscribe{out_seq} when the user
      // switches to them (protocol §5.3).
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
      /* onclose follows; everything is handled there */
    }
    ws.onclose = () => {
      if (this.ws === ws) this.lost()
    }
  }

  /**
   * The current socket is finished: closed by the browser, or given up on by us (no pong,
   * protocol error). Giving up doesn't wait for `onclose`: on a dead link the browser fires
   * it only when its closing handshake times out, which can take a minute, and until then
   * the page would sit "online" on a zombie (protocol §5.5).
   */
  private lost(reason = 'closed'): void {
    if (this.ws) abandon(this.ws, reason)
    this.ws = null
    this.clearTimers()
    // A partial snapshot is useless; after reconnecting the agent decides again from out_seq
    this.snapshots.clear()
    this.recovery = null
    if (this.stopped) {
      this.setState('closed')
      return
    }
    this.scheduleRetry()
    this.opts.handlers.onClosed?.(this.socketWelcomed)
  }

  private scheduleRetry(): void {
    const delay = this.backoff.next()
    const until = this.now() + delay
    this.setState('reconnecting', { retryInMs: delay })
    // Tick the countdown so "Reconnecting · retry in 3s" actually counts down (AC-2.10)
    this.countdownTimer = setInterval(() => {
      const left = Math.max(0, until - this.now())
      this.opts.handlers.onState('reconnecting', { retryInMs: left })
    }, 250)
    this.retryTimer = setTimeout(() => this.open(), delay)
  }

  /**
   * Network back / page visible again: retry immediately and reset the backoff (AC-2.9).
   *
   * Don't just return when we think we're online (AC-2.20 / ADR-0020): a dead link doesn't
   * always fire `onclose` (screen off, network switch, NAT timeout), and only a heartbeat
   * exposes such a zombie connection. `online` and becoming visible are known suspicious
   * moments, so probe right away and declare it dead after 2s without a pong. A false
   * positive only costs one lossless reconnect.
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

  // ---------- Receiving ----------

  private onMessage(data: unknown): void {
    if (typeof data === 'string') {
      const msg = decodeMessage(data)
      if (!msg) return // Unknown t: ignore without closing (forward compatibility)
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
      this.fail('Received a malformed binary frame')
      return
    }
    if (f.type === TYPE_INPUT) {
      this.fail('Agent sent an INPUT frame')
      return
    }
    const st = this.ensure(f.sid)
    const seq = Number(f.seq)
    if (f.type === TYPE_SNAPSHOT) {
      this.handleSnapshot(st, f, seq)
      return
    }

    // The agent guarantees no other frames for the session interleave with a snapshot (§3)
    if (this.snapshots.has(f.sid)) {
      this.fail(`Session ${f.sid}: OUTPUT arrived before the snapshot was complete`)
      return
    }
    if (seq > st.outSeq) {
      // A gap should never happen. Close the connection and resume via reconnect; don't try to patch it.
      this.fail(`Session ${f.sid}: gap in the output stream (expected seq ${st.outSeq}, got ${seq})`)
      return
    }
    if (seq + f.payload.length <= st.outSeq) return // Entirely duplicate data: drop it
    // Partial overlap: keep only the part we haven't seen
    const skip = st.outSeq - seq
    const fresh = skip > 0 ? f.payload.subarray(skip) : f.payload
    const freshSeq = st.outSeq
    st.outSeq += fresh.length
    st.headSeq = Math.max(st.headSeq, st.outSeq)
    // Output before outSeq reaches catchupTo is catch-up: suppress automatic replies
    const replay = freshSeq < st.catchupTo
    this.record(f, seq, replay)
    this.recovered(f.sid, fresh.length, st.outSeq)
    this.opts.handlers.onOutput(f.sid, fresh, replay)
  }

  /** Receives a snapshot: collects frames with the same seq until one without MORE, then delivers it. */
  private handleSnapshot(st: SessionState, f: Frame, seq: number): void {
    let asm = this.snapshots.get(f.sid)
    if (asm && asm.seq !== seq) {
      this.fail(`Session ${f.sid}: snapshot frames disagree on seq (${asm.seq} / ${seq})`)
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
    // Snapshot bytes don't count toward out_seq: it is the full screen as of seq, and OUTPUT continues from seq
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
        // For fatal errors the server closes the connection next; just pass the reason on
        if (msg.code === Code.unauthorized) this.opts.handlers.onUnauthorized?.(msg.message)
        if (msg.code === Code.protocolUnsupported) {
          this.opts.handlers.onFatal?.(`Agent was upgraded; reload the page (${msg.message})`)
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
      // The agent really restarted: sids get reassigned and no local progress is usable (AC-2.13)
      this.sessions.clear()
      this.snapshots.clear()
      this.opts.handlers.onRestart?.()
    }

    // Record heads first: status=ok catch-up runs up to here, and the replay gate is drawn here too (table in §5.3)
    for (const s of w.sessions) {
      const st = this.ensure(s.sid)
      st.headSeq = Math.max(st.headSeq, s.head_seq)
      st.catchupTo = Math.max(st.catchupTo, s.head_seq)
    }

    const targets = new Map<number, number>()
    const resumed = new Set<number>()
    for (const r of w.resumed) {
      resumed.add(r.sid)
      const st = this.ensure(r.sid)
      if (r.status === 'gone') {
        // The agent restarted or the session is gone
        this.forget(r.sid)
        continue
      }
      if (r.status === 'snapshot') targets.set(r.sid, -1)
      else if (st.outSeq < st.headSeq) targets.set(r.sid, st.headSeq)
      // Trim the resend queue at in_ack, then resend everything after it in ascending seq order (§5.4)
      for (const item of st.resend.resumeFrom(r.in_ack)) {
        this.writeFrame(r.sid, item.seq, item.bytes)
      }
    }
    // Input typed into a session we then switched away from is still pending, but that
    // session isn't in resume, so there's no in_ack to trim by. Resend it as is: it starts
    // at or before what the agent accepted, and the agent drops the duplicate prefix (§3).
    // Waiting until the user switches back would hold it indefinitely.
    if (!restarted) {
      for (const s of w.sessions) {
        if (resumed.has(s.sid) || s.status !== 'running') continue
        for (const item of this.sessions.get(s.sid)?.resend.pending ?? []) {
          this.writeFrame(s.sid, item.seq, item.bytes)
        }
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

  /** Resume progress: a session reached outSeq (Infinity for a snapshot). Reports once when all have caught up. */
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

  // ---------- Heartbeat ----------

  private startHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = setInterval(() => this.sendPing(PONG_TIMEOUT), PING_INTERVAL)
  }

  /**
   * Sends a ping and arms the dead-connection timer: no pong within `timeout` closes the
   * socket and reconnects. The heartbeat (10s) and the immediate probe (2s) ask the same
   * question with different patience.
   */
  private sendPing(timeout: number): void {
    if (!this.ws || this.ws.readyState !== 1) return
    this.lastPingAt = this.now()
    this.send({ t: T.ping, ts: this.lastPingAt })
    if (this.pongTimer) clearTimeout(this.pongTimer)
    this.pongTimer = setTimeout(() => this.lost('pong timeout'), timeout)
  }

  // ---------- Misc ----------

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
    // Stop reading this socket now: frames still in flight would land on broken accounting
    if (this.ws) this.lost('protocol error')
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

/** Detaches a socket we no longer use and closes it without waiting for its events. */
function abandon(ws: WebSocketLike, reason: string): void {
  ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
  try {
    ws.close(4000, reason)
  } catch {
    /* already closed */
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
