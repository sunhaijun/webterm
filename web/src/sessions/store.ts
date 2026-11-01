/**
 * 会话在 client 侧的表示 —— docs/40-frontend/session-ux.md。
 *
 * 每个会话一个 xterm 实例，【切走时不销毁】，只把 DOM 摘下来：切回去时屏幕内容、
 * 滚动位置、选区全部保持（走增量时）。
 *
 * 这里管：会话元数据、终端实例、输出写入（OUTPUT / SNAPSHOT）、回放门、
 * 进程结束提示行、订阅（只订阅当前可见的 + 保持接收的）。不管 UI。
 */
import type { ITheme } from '@xterm/xterm'

import { inputTrace } from '../keys/inputstats'
import type { SessionInfo, SessionStatus } from '../protocol/messages'
import { createTerminal, exitLine, type TermHandle } from '../term/terminal'
import { moveBefore } from '../ui/reorder'
import { inUserInputEvent } from '../term/userinput'

/** store 需要的那一小块连接层。 */
export interface ConnLike {
  subscribe(sid: number, cols?: number, rows?: number): void
  unsubscribe(sid: number): void
  forget(sid: number): void
  outSeqOf(sid: number): number
  headSeqOf(sid: number): number
  isUnread(sid: number): boolean
}

/** 给 UI 的只读视图。 */
export interface SessionView {
  sid: number
  name: string
  cwd: string
  status: SessionStatus
  exitCode: number | null
  /** `[n]`：当前显示顺序里的第几个（从 1 开始，ADR-0040）。 */
  index: number
  /** 保持接收（pin 订阅）。 */
  pinned: boolean
  /** 非当前会话且 headSeq > outSeq。 */
  unread: boolean
  active: boolean
}

export interface StoreHooks {
  onChange(): void
  /** 过了回放门的 onData：用户输入，或 live 期间终端对查询的应答。 */
  onData(sid: number, data: string): void
  /** xterm 的 onBinary（部分鼠标上报编码），同样过了回放门。 */
  onBinary?(sid: number, data: string): void
  /** 应用级快捷键：返回 false 表示拦下来，不让它进 PTY。 */
  allowKey(e: KeyboardEvent): boolean
  theme(): ITheme | undefined
  /** 当前设置的终端字号（AC-5.3）：新建的实例用它。 */
  fontSize(): number
}

interface Entry {
  info: SessionInfo
  term: TermHandle
  /** 承载 xterm DOM 的容器，切走时从可见区摘下来。 */
  host: HTMLElement
  opened: boolean
  pinned: boolean
  /** 进程结束提示行已经写过（快照会清屏，写快照时复位）。 */
  exitShown: boolean
}

export class SessionStore {
  private readonly entries = new Map<number, Entry>()
  /** 显示顺序（ADR-0040）：agent 给的，新建的排最后。可能含还没收到 session.created 的 sid（占位）。 */
  private order: number[] = []
  private readonly conn: ConnLike
  private readonly h: StoreHooks
  private activeSid: number | null = null

  constructor(conn: ConnLike, hooks: StoreHooks) {
    this.conn = conn
    this.h = hooks
  }

  get active(): number | null {
    return this.activeSid
  }

  has(sid: number): boolean {
    return this.entries.has(sid)
  }

  info(sid: number): SessionInfo | undefined {
    return this.entries.get(sid)?.info
  }

  termOf(sid: number): TermHandle | undefined {
    return this.entries.get(sid)?.term
  }

  /** 按显示顺序（agent 给的，ADR-0040）。 */
  list(): SessionView[] {
    return this.ordered().map((e, i) => ({
      sid: e.info.sid,
      name: displayName(e.info),
      cwd: e.info.cwd,
      status: e.info.status,
      exitCode: e.info.exit_code,
      index: i + 1,
      pinned: e.pinned,
      unread: e.info.sid !== this.activeSid && this.conn.isUnread(e.info.sid),
      active: e.info.sid === this.activeSid,
    }))
  }

  upsert(info: SessionInfo): void {
    const existing = this.entries.get(info.sid)
    if (existing) {
      existing.info = { ...existing.info, ...info }
      this.maybeExitLine(existing)
      this.h.onChange()
      return
    }
    const term = createTerminal(this.h.theme(), this.h.fontSize())
    const host = document.createElement('div')
    host.className = 'term-host'
    host.dataset.sid = String(info.sid)
    const sid = info.sid

    // 回放门（§5.3 / ADR-0020）：回放的字节还没解析完时，只放行【正在派发用户输入事件】
    // 时产生的 onData；其余的是 xterm 对历史查询的自动应答，不能当按键送进 PTY
    const gate = (): boolean => {
      inputTrace.bump('data')
      if (!inUserInputEvent() && term.replaying()) {
        inputTrace.bumpGated()
        return false
      }
      return true
    }
    term.term.onData((data) => {
      if (gate()) this.h.onData(sid, data)
    })
    term.term.onBinary((data) => {
      if (gate()) this.h.onBinary?.(sid, data)
    })
    term.term.attachCustomKeyEventHandler((e) => e.type !== 'keydown' || this.h.allowKey(e))

    const entry: Entry = { info, term, host, opened: false, pinned: false, exitShown: false }
    this.entries.set(sid, entry)
    if (!this.order.includes(sid)) this.order.push(sid) // 新建的排最后（ADR-0040）
    this.maybeExitLine(entry)
    this.h.onChange()
  }

  patch(sid: number, patch: Partial<SessionInfo>): void {
    const e = this.entries.get(sid)
    if (!e) return
    e.info = { ...e.info, ...patch }
    this.maybeExitLine(e)
    this.h.onChange()
  }

  remove(sid: number): void {
    const e = this.entries.get(sid)
    if (!e) return
    e.term.dispose()
    e.host.remove()
    this.entries.delete(sid)
    this.order = this.order.filter((x) => x !== sid)
    this.conn.forget(sid)
    if (this.activeSid === sid) this.activeSid = null
    this.h.onChange()
  }

  /** 全部作废（agent 重启过）。 */
  clear(): void {
    for (const sid of [...this.entries.keys()]) this.remove(sid)
  }

  /**
   * 把某个会话挂到可见容器里并订阅它（session-ux.md §订阅策略）。
   *
   *   1. unsubscribe(当前会话)（开着保持接收的不退）
   *   2. 挂载 X.term 的 DOM → fit()
   *   3. subscribe(X, out_seq, cols, rows)   ← 尺寸【就在这条消息里】，不单发 resize
   */
  activate(sid: number, container: HTMLElement): void {
    const e = this.entries.get(sid)
    if (!e) return
    if (this.activeSid === sid && e.host.parentElement === container) return

    const prev = this.activeSid !== null ? this.entries.get(this.activeSid) : undefined
    if (prev && prev !== e) {
      prev.host.remove()
      if (!prev.pinned) this.conn.unsubscribe(prev.info.sid)
    }

    container.appendChild(e.host)
    if (!e.opened) {
      e.term.term.open(e.host)
      e.opened = true
    }
    e.term.fit()
    this.activeSid = sid
    this.conn.subscribe(sid, e.term.term.cols, e.term.term.rows)
    this.h.onChange()
  }

  /** 保持接收：切走也不退订。默认关闭，开了要付流量。 */
  togglePinned(sid: number): void {
    const e = this.entries.get(sid)
    if (!e) return
    e.pinned = !e.pinned
    if (sid !== this.activeSid) {
      if (e.pinned) this.conn.subscribe(sid)
      else this.conn.unsubscribe(sid)
    }
    this.h.onChange()
  }

  /** OUTPUT 帧（连接层已去重、已判好是不是补课）。 */
  output(sid: number, data: Uint8Array, replay: boolean): void {
    const e = this.entries.get(sid)
    if (!e) return
    e.term.output(data, replay)
    this.maybeExitLine(e)
  }

  /** SNAPSHOT（收齐的一份）：清屏重画；会话已退出就在后面再写一次提示行。 */
  snapshot(sid: number, data: Uint8Array): void {
    const e = this.entries.get(sid)
    if (!e) return
    e.term.snapshot(data)
    e.exitShown = false
    this.maybeExitLine(e)
  }

  /** 改了主题、或系统切换了深浅色：所有实例一起换（layout.md §主题）。 */
  setTheme(theme: ITheme | undefined): void {
    for (const e of this.entries.values()) e.term.term.options.theme = theme ?? {}
  }

  /**
   * 改字号：所有实例一起换，对挂着的那个 fit()；没挂着的切过去时 activate() 会 fit。
   * 【调用方还欠一条 resize】：字符格变了而容器没变，ResizeObserver 不会响（AC-5.3）。
   */
  setFontSize(px: number): void {
    for (const e of this.entries.values()) {
      e.term.term.options.fontSize = px
      if (e.opened && e.info.sid === this.activeSid) e.term.fit()
    }
  }

  /** 关闭之后切到相邻会话：优先后一个，没有就前一个。 */
  neighbourOf(sid: number): number | null {
    const ids = this.ordered().map((e) => e.info.sid)
    const i = ids.indexOf(sid)
    if (i < 0) return ids[0] ?? null
    return ids[i + 1] ?? ids[i - 1] ?? null
  }

  /** 上一个 / 下一个（Ctrl+Shift+↑ / ↓），到头回绕。 */
  step(delta: number): number | null {
    const ids = this.ordered().map((e) => e.info.sid)
    if (ids.length === 0) return null
    const i = this.activeSid === null ? -1 : ids.indexOf(this.activeSid)
    const next = (((i + delta) % ids.length) + ids.length) % ids.length
    return ids[next] ?? null
  }

  first(): number | null {
    return this.ordered()[0]?.info.sid ?? null
  }

  dispose(): void {
    for (const e of this.entries.values()) e.term.dispose()
    this.entries.clear()
    this.order = []
    this.activeSid = null
  }

  /**
   * agent 给的完整顺序（welcome.sessions[] 的顺序、session.order）：整个替换。
   * 【还不认识的 sid 也留着占位】：别的连接刚建的会话，session.order 可能先于它的
   * session.created 到（ADR-0040 §2），到了就落在 agent 给的位置上。
   * 里面没有的已知会话（刚建、正在关）按原来的相对顺序接在后面。
   */
  setOrder(sids: readonly number[]): void {
    const listed = new Set(sids)
    this.order = [...sids, ...this.order.filter((sid) => !listed.has(sid) && this.entries.has(sid))]
    this.h.onChange()
  }

  /** 本地先挪（松手立刻生效），之后以 agent 的 session.order 为准。 */
  move(sid: number, before: number | null): void {
    this.order = moveBefore(this.order, sid, before)
    this.h.onChange()
  }

  private ordered(): Entry[] {
    return this.order.map((sid) => this.entries.get(sid)).filter((e): e is Entry => e !== undefined)
  }

  /**
   * 进程结束提示行（AC-4.5）：会话已退出、并且输出已经追平（outSeq ≥ headSeq）时写一次。
   * 没追平就先不写 —— 否则补课的字节会排到提示行后面。
   */
  private maybeExitLine(e: Entry): void {
    if (e.exitShown || !shouldShowExitLine(e.info.status, this.conn.outSeqOf(e.info.sid), this.conn.headSeqOf(e.info.sid))) {
      return
    }
    e.exitShown = true
    e.term.local(exitLine(e.info.exit_code))
  }
}

/** 提示行该不该写：已退出且输出已经追平。 */
export function shouldShowExitLine(status: SessionStatus, outSeq: number, headSeq: number): boolean {
  return status === 'exited' && outSeq >= headSeq
}

/** 显示名：agent 已经按 CWD 算好了（AC-4.4），这里只兜底。 */
export function displayName(s: Pick<SessionInfo, 'name'>): string {
  return s.name || 'shell'
}

/**
 * 已退出会话里的输入（session-ux.md §会话结束）：`\r` = 关闭会话，其余丢弃 ——
 * PTY 已经不在了，提示行已经告诉用户该做什么。
 */
export function routeInput(status: SessionStatus, data: string): 'send' | 'close' | 'drop' {
  if (status !== 'exited') return 'send'
  return data === '\r' ? 'close' : 'drop'
}

/**
 * 抽屉里显示的 CWD：等于家目录、或在家目录之下时缩成 `~`，否则原样。
 * 家目录来自 `welcome.home`（§4.2）；拿不到就不缩写，不猜。
 */
export function shortCwd(cwd: string, home: string | null | undefined): string {
  if (!home || home === '/') return cwd
  const h = home.endsWith('/') ? home.slice(0, -1) : home
  if (cwd === h) return '~'
  if (cwd.startsWith(h + '/')) return '~' + cwd.slice(h.length)
  return cwd
}
