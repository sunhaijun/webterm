/**
 * 会话在 client 侧的表示 —— docs/40-frontend/session-ux.md。
 *
 * 【切走的会话不销毁 xterm 实例】。只把 DOM 摘下来，这样切回去时不需要
 * 重放缓冲，屏幕内容、滚动位置、选中状态全部保持。
 */
import { Connection } from '../conn/connection'
import { ModeMachine, type ModeState } from '../input/modes'
import type { SessionInfo } from '../protocol/messages'
import { BudgetWriter } from '../term/budgetwriter'
import { installInteractive, type InteractiveDetector } from '../term/interactive'
import { type FollowState, OutputQueue } from '../term/outputqueue'
import { createTerminal, type TermFont, type TermHandle } from '../term/terminal'
import { inUserInputEvent } from '../term/userinput'

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
  /** 正在灌回放输出的写次数（>0 时 xterm 对历史查询的自动应答别当输入送 PTY）。 */
  replayDepth: number
  /** 输出写入队列：按帧合并；用户滚上去读旧输出时暂停写入（session-ux.md §回看时暂停跟随）。 */
  queue: OutputQueue
  /**
   * 通往 xterm 的唯一入口（AC-5.16）。回放、快照恢复、回看期间的强制写入都从这里过，
   * 每帧至多 64 KiB。【必须是唯一入口】—— 有第二条路就没有统一的顺序可言。
   */
  writer: BudgetWriter
  /** 解绑 .xterm-viewport 的 DOM scroll 监听 —— 那个元素 open() 之后才有。 */
  unhookScroll?: () => void
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
  /** 跟随状态变了（离开 / 回到底部，或暂停中攒下的新增量变了）。给右下角提示条用。 */
  onFollow?(sid: number, s: FollowState): void
}

export class SessionStore {
  private readonly entries = new Map<number, Entry>()
  private readonly conn: Connection
  private readonly h: SessionStoreHandlers
  private readonly font: () => TermFont
  private activeSid: number | null = null

  constructor(conn: Connection, font: () => TermFont, h: SessionStoreHandlers) {
    this.conn = conn
    this.h = h
    this.font = font
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
    const f = this.font()
    const term = createTerminal(f.size, f.family)
    const host = document.createElement('div')
    host.className = 'term-host'
    host.dataset.sid = String(info.sid)

    const modes = new ModeMachine({ onChange: (s) => this.h.onModeChange(info.sid, s) })
    modes.onIntegration(info.integration)
    modes.resync(info.prompt_state)

    // 每个终端实例创建时就把输入绑好，不用事后轮询去找它。
    // 回放（重连续传 / 刷新重放）灌进来的历史输出里可能有终端查询（DSR/DA…），
    // xterm 会自动应答 —— 那不是用户输入，回放期间别把它送进 PTY（否则 claude 收到乱码）。
    //
    // 【但要拦的只是自动应答，不是用户的按键】（ADR-0020）。两者都从 onData 出来，
    // 区别在于谁产生的：按键同步发生在一次输入事件的派发里，自动应答发生在
    // term.write() 的解析里。按"此刻是否在回放"一刀切，就会把用户正在敲的字
    // 一起吞掉 —— 而回放窗口在 ring_bytes 满载时是【秒级】的。
    term.term.onData((data) => {
      if (!inUserInputEvent() && (this.entries.get(info.sid)?.replayDepth ?? 0) > 0) return
      this.h.onTermData(info.sid, data)
    })
    term.term.attachCustomKeyEventHandler((e) => e.type !== 'keydown' || this.h.allowKey(e))

    const writer = new BudgetWriter((data, done) => term.term.write(data, done))
    const entry: Entry = {
      info,
      term,
      host,
      modes,
      pinnedSubscription: false,
      opened: false,
      interactive: false,
      detector: installInteractive(term.term),
      replayDepth: 0,
      writer,
      // urgent = AC-5.9 那几个"一次写完"的时刻；其余交给写入器按预算慢滴（AC-5.16）
      queue: new OutputQueue((data, urgent) => (urgent ? writer.writeNow(data) : writer.write(data)), {
        onState: (s) => this.h.onFollow?.(info.sid, s),
      }),
    }
    // 跟随 / 回看：视口贴底就跟随，滚上去就暂停写入（session-ux.md §回看时暂停跟随）。
    // xterm 的 onScroll 只在【程序化】滚动时来：scrollLines / scrollToBottom（输入、占屏程序
    // 启动）以及输出把缓冲推着走。滚轮、触屏拖动、拖滚动条这些 DOM 驱动的滚动它【不报】
    // （xterm 5.5 的 Viewport 一律标 suppressScrollEvent），那一路在 activate() 里挂在
    // .xterm-viewport 的 DOM scroll 事件上。两路都不看事件带的位置，只按真实视口判定。
    // 备用缓冲没有 scrollback，永远算贴底
    term.term.onScroll(() => entry.queue.setFollowing(atBottom(term)))
    term.term.buffer.onBufferChange((buf) => {
      if (buf.type === 'alternate') entry.queue.setFollowing(true)
    })
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
    e.unhookScroll?.()
    e.queue.clear()
    e.writer.clear()
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
      // 滚轮 / 触屏拖动 / 拖滚动条：xterm 不发 onScroll 的那一路（见 upsert 里的注释）。
      // xterm 自己的 scroll 监听在 open() 时先挂上，先跑、先把 viewportY 更新好，这里再读
      const vp = e.host.querySelector<HTMLElement>('.xterm-viewport')
      if (vp) {
        const onScroll = () => e.queue.setFollowing(atBottom(e.term))
        vp.addEventListener('scroll', onScroll, { passive: true })
        e.unhookScroll = () => vp.removeEventListener('scroll', onScroll)
      }
    }
    e.term.attachWebgl()
    e.term.fit.fit()
    this.activeSid = sid
    // 【尺寸就在 subscribe 这条消息里，不单发 resize】。单发无论排前排后都有坑：
    // 排后面 agent 补的是按旧尺寸排版的积压；排前面，全屏程序被 SIGWINCH 逼出的
    // 整屏重画会落在 subscribe 之前、被 redraw.seq 跳过，那一屏反而丢了。
    // 见 docs/40-frontend/session-ux.md §订阅策略
    this.conn.subscribe(sid, e.term.term.cols, e.term.term.rows)
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

  /** 写一帧输出到终端。isReplay=回放（续传 / 重放历史）：这期间抑制 xterm 对历史查询的
   * 自动应答（见 onData 绑定）。用 write 回调把抑制窗口卡在【解析完这帧】为止 —— xterm
   * 是异步分片解析的，同步清标志会漏掉之后才触发的 onData。 */
  write(sid: number, data: Uint8Array, isReplay = false): void {
    const e = this.entries.get(sid)
    if (!e) return
    if (!isReplay) {
      // 实时帧走队列：贴底时按帧合并，滚上去时暂停（session-ux.md §回看时暂停跟随）。
      // 每帧按【真实视口位置】校正一次跟随状态：onScroll 可能漏（或报出中间位置），
      // 靠这一步自愈 —— 贴底就跟随，离底就暂停，永远不会卡在错误的一侧
      e.queue.setFollowing(atBottom(e.term))
      e.queue.push(data)
      return
    }
    // 回放不暂停也不合并：它是一段有界的补课，而且必须排在之前收到的实时帧【之后】。
    // 队列先一次写完（AC-5.9），回放本体则按预算慢滴（AC-5.16）—— 满窗口回放是单次
    // 写入量最大的一条路，整块灌进去会连着占掉几十帧，那正是"回放期间滚不动"的来源。
    e.queue.drain(true)
    e.replayDepth++
    // 【窗口在入队时就开】：跨帧慢滴时，等到某一片写完才开窗会在片与片之间留缝，
    // 缝里 xterm 对历史查询的自动应答就漏进 PTY 了（ADR-0020）
    e.writer.write(data, () => {
      if (e.replayDepth > 0) e.replayDepth--
    })
  }

  /** 某会话的跟随状态（切会话时给提示条对齐用）。 */
  followOf(sid: number): FollowState {
    return this.entries.get(sid)?.queue.state ?? { following: true, parked: null }
  }

  /** 回到底部并恢复跟随（提示条点击）。scrollToBottom 在已经贴底时不发 onScroll，所以显式恢复。 */
  follow(sid: number): void {
    const e = this.entries.get(sid)
    if (!e) return
    e.term.term.scrollToBottom()
    e.queue.setFollowing(true)
  }

  resetTerm(sid: number): void {
    const e = this.entries.get(sid)
    if (!e) return
    // 屏幕要按服务端缓冲重建，攒着的旧字节没有意义了；重建完视口在底部，恢复跟随。
    // 写入器里还在滴的也一起丢 —— 那是重建前的内容，写进去只会排在新内容前面
    e.queue.clear()
    e.writer.clear()
    e.term.term.reset()
    e.queue.setFollowing(true)
  }

  /**
   * 改字号 / 字体：所有实例一起改，并重新 fit。
   *
   * 【调用方还欠一条 `resize`】。cell 尺寸变了但容器一个像素没变，`ResizeObserver`
   * 不会响 —— 只 fit 不发的话客户端与 PTY 的 cols/rows 就分了家（AC-5.3 / AC-5.13）。
   */
  setFont(f: TermFont): void {
    for (const e of this.entries.values()) {
      e.term.term.options.fontSize = f.size
      e.term.term.options.fontFamily = f.family
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

  /** 最小 sid 的会话（关掉当前会话后自动切过去用）。 */
  firstSid(): number | null {
    const ids = [...this.entries.keys()].sort((a, b) => a - b)
    return ids[0] ?? null
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
      e.unhookScroll?.()
      e.queue.clear()
      e.writer.clear()
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

/** 视口是否贴底。备用缓冲没有 scrollback，永远算贴底。 */
function atBottom(t: TermHandle): boolean {
  const buf = t.term.buffer.active
  return buf.type === 'alternate' || buf.viewportY >= buf.baseY
}
