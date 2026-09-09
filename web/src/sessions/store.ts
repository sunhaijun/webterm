/**
 * 会话在 client 侧的表示 —— docs/40-frontend/session-ux.md。
 *
 * 【切走的会话不销毁 xterm 实例】。只把 DOM 摘下来，这样切回去时不需要
 * 重放缓冲，屏幕内容、滚动位置、选中状态全部保持。
 */
import { Connection } from '../conn/connection'
import { ModeMachine, type ModeState } from '../input/modes'
import type { SessionInfo } from '../protocol/messages'
import { MarkTracker } from '../term/marks'
import { installInteractive, type InteractiveDetector } from '../term/interactive'
import { createTerminal, type TermHandle } from '../term/terminal'
import type { IMarker } from '@xterm/xterm'

export interface SessionView extends SessionInfo {
  /** 用户开了"保持接收"：切走也保持订阅，代价是流量。 */
  pinnedSubscription: boolean
  inputMode: ModeState
}

interface Entry {
  info: SessionInfo
  term: TermHandle
  /** 承载 xterm DOM 的容器，切走时从可见区摘下来。 */
  host: HTMLElement
  modes: ModeMachine
  pinnedSubscription: boolean
  opened: boolean
  /** 有程序占屏：备用缓冲，或主屏就地重绘（claude / codex）。 */
  interactive: boolean
  detector: InteractiveDetector
  /** 输出流里的行锚点（ADR-0011 ④：「在终端里看」定位到块）。 */
  marks: MarkTracker
}

export interface SessionStoreHandlers {
  onChange(): void
  onModeChange(sid: number, state: ModeState): void
  /** Raw 模式下 xterm 产出的字节。调用方负责判断要不要发。 */
  onTermData(sid: number, data: string): void
  /** 应用级快捷键：返回 false 表示拦下来，不让它进 PTY。 */
  allowKey(e: KeyboardEvent): boolean
  /** 占屏状态切换（ADR-0011 ②：驱动读 ⇄ 控的自动切换）。备用缓冲 或 主屏就地重绘。 */
  onInteractive(sid: number, on: boolean): void
}

export class SessionStore {
  private readonly entries = new Map<number, Entry>()
  private readonly conn: Connection
  private readonly h: SessionStoreHandlers
  private readonly fontSize: () => number
  private activeSid: number | null = null

  constructor(conn: Connection, fontSize: () => number, h: SessionStoreHandlers) {
    this.conn = conn
    this.h = h
    this.fontSize = fontSize
  }

  get active(): number | null {
    return this.activeSid
  }

  list(): SessionView[] {
    return [...this.entries.values()]
      .sort((a, b) => a.info.sid - b.info.sid)
      .map((e) => ({
        ...e.info,
        pinnedSubscription: e.pinnedSubscription,
        inputMode: e.modes.current,
      }))
  }

  get(sid: number): SessionView | undefined {
    const e = this.entries.get(sid)
    if (!e) return undefined
    return { ...e.info, pinnedSubscription: e.pinnedSubscription, inputMode: e.modes.current }
  }

  termOf(sid: number): TermHandle | undefined {
    return this.entries.get(sid)?.term
  }

  modesOf(sid: number): ModeMachine | undefined {
    return this.entries.get(sid)?.modes
  }

  /** 未读 = agent 侧已产出的字节数超过本地已收到的。 */
  isUnread(sid: number): boolean {
    return this.conn.isUnread(sid)
  }

  upsert(info: SessionInfo): void {
    const existing = this.entries.get(info.sid)
    if (existing) {
      existing.info = { ...existing.info, ...info }
      existing.modes.onIntegration(existing.info.integration)
      // 重连后重新对齐 —— 离线期间的 prompt 变化已经丢了
      existing.modes.resync(info.prompt_state)
      this.h.onChange()
      return
    }
    const term = createTerminal(this.fontSize())
    const host = document.createElement('div')
    host.className = 'term-host'
    host.dataset.sid = String(info.sid)

    const modes = new ModeMachine({ onChange: (s) => this.h.onModeChange(info.sid, s) })
    modes.onIntegration(info.integration)
    modes.resync(info.prompt_state)

    // 每个终端实例创建时就把输入绑好，不用事后轮询去找它
    term.term.onData((data) => this.h.onTermData(info.sid, data))
    term.term.attachCustomKeyEventHandler((e) => e.type !== 'keydown' || this.h.allowKey(e))

    const entry: Entry = {
      info,
      term,
      host,
      modes,
      pinnedSubscription: false,
      opened: false,
      interactive: false,
      detector: installInteractive(term.term),
      marks: new MarkTracker(term.term),
    }
    // 占屏检测：vim/top/less 的备用缓冲，以及 claude/codex 的主屏就地重绘
    entry.detector.onChange((on) => {
      entry.interactive = on
      this.h.onInteractive(info.sid, on)
    })
    this.entries.set(info.sid, entry)
    this.h.onChange()
  }

  /** 该会话是否有程序占屏（备用缓冲 或 主屏就地重绘）。 */
  interactiveOf(sid: number): boolean {
    return this.entries.get(sid)?.interactive ?? false
  }

  /** 备用缓冲是否激活（仅缓冲类型，控态键条区分 vim/less 用）。 */
  altScreenOf(sid: number): boolean {
    return this.entries.get(sid)?.term.altScreen() ?? false
  }

  /** 命令边界：清掉主屏就地重绘的判定（新命令 / 回到 prompt）。 */
  resetInteractive(sid: number): void {
    this.entries.get(sid)?.detector.reset()
  }

  /** 重连 / 切到某会话后，从 xterm 当前模式补判占屏（top 这类可能在重连前就已在跑）。 */
  syncInteractive(sid: number): void {
    this.entries.get(sid)?.detector.sync()
  }

  patch(sid: number, patch: Partial<SessionInfo>): void {
    const e = this.entries.get(sid)
    if (!e) return
    e.info = { ...e.info, ...patch }
    if (patch.integration !== undefined) e.modes.onIntegration(patch.integration)
    this.h.onChange()
  }

  remove(sid: number): void {
    const e = this.entries.get(sid)
    if (!e) return
    e.modes.dispose()
    e.detector.dispose()
    e.term.dispose()
    e.host.remove()
    this.entries.delete(sid)
    this.conn.forget(sid)
    if (this.activeSid === sid) this.activeSid = null
    this.h.onChange()
  }

  /**
   * 把某个会话挂到可见容器里并订阅它。
   *
   * 只对当前可见的会话订阅：后台会话在 agent 侧照常运行和缓冲，
   * 那些字节【根本不过网络】—— 这是移动端的关键优化。
   */
  activate(sid: number, container: HTMLElement): void {
    const e = this.entries.get(sid)
    if (!e) return

    const prev = this.activeSid !== null ? this.entries.get(this.activeSid) : undefined
    if (prev && prev.info.sid !== sid) {
      // WebGL 上下文数有上限，切走就得放掉，否则 20 个会话必然撞线
      prev.term.detachWebgl()
      prev.host.remove()
      if (!prev.pinnedSubscription) this.conn.unsubscribe(prev.info.sid)
      // 对上一个会话的手动模式选择不该跨会话生效
      prev.modes.reset()
      prev.modes.onIntegration(prev.info.integration)
    }

    container.appendChild(e.host)
    if (!e.opened) {
      e.term.term.open(e.host)
      e.opened = true
    }
    e.term.attachWebgl()
    e.term.fit.fit()
    this.activeSid = sid
    this.conn.subscribe(sid)
    this.h.onChange()
  }

  /** 保持接收：切走也不退订。默认关闭，开了要付流量。 */
  togglePinnedSubscription(sid: number): void {
    const e = this.entries.get(sid)
    if (!e) return
    e.pinnedSubscription = !e.pinnedSubscription
    if (e.pinnedSubscription) this.conn.subscribe(sid)
    else if (this.activeSid !== sid) this.conn.unsubscribe(sid)
    this.h.onChange()
  }

  /**
   * 写一帧输出。startSeq 是 data[skip] 那个字节的 out_seq（skip 是不计数的渲染前缀），
   * 给行锚点用；不传就是普通写入。
   */
  write(sid: number, data: Uint8Array, startSeq = -1, skip = 0): void {
    const e = this.entries.get(sid)
    if (!e) return
    if (startSeq < 0) e.term.term.write(data)
    else e.marks.write(data, startSeq, skip)
  }

  /** 在 out_seq = seq 处登记锚点（command.start/end 到达时调）。位置已过去返回 false。 */
  markAt(sid: number, seq: number, key: string): boolean {
    return this.entries.get(sid)?.marks.markAt(seq, key) ?? false
  }

  markOf(sid: number, key: string): IMarker | undefined {
    return this.entries.get(sid)?.marks.get(key)
  }

  resetTerm(sid: number): void {
    const e = this.entries.get(sid)
    if (!e) return
    e.term.term.reset()
    // 缓冲清了，行号全部作废
    e.marks.reset()
  }

  /** 改字号：所有实例一起改，并重新 fit。 */
  setFontSize(px: number): void {
    for (const e of this.entries.values()) {
      e.term.term.options.fontSize = px
      if (e.opened) e.term.fit.fit()
    }
  }

  /** 相邻会话，用于关闭之后自动切过去。 */
  neighbourOf(sid: number): number | null {
    const ids = [...this.entries.keys()].sort((a, b) => a - b)
    const i = ids.indexOf(sid)
    if (i < 0) return ids[0] ?? null
    return ids[i + 1] ?? ids[i - 1] ?? null
  }

  /** 上一个 / 下一个（Ctrl+Shift+↑ / ↓）。 */
  step(delta: number): number | null {
    const ids = [...this.entries.keys()].sort((a, b) => a - b)
    if (ids.length === 0) return null
    const i = this.activeSid === null ? -1 : ids.indexOf(this.activeSid)
    const next = ((i + delta) % ids.length + ids.length) % ids.length
    return ids[next] ?? null
  }

  dispose(): void {
    for (const e of this.entries.values()) {
      e.modes.dispose()
      e.term.dispose()
    }
    this.entries.clear()
  }
}

/** 显示名：手动名优先，否则跟随 CWD。agent 已经算好了，这里只兜底。 */
export function displayName(s: SessionInfo): string {
  return s.name || 'shell'
}
