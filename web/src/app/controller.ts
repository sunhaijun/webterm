/**
 * 装配层的逻辑：连接 ⇄ 会话 ⇄ 输入 ⇄ 界面状态。组件（app.tsx 及其子组件）只做渲染，
 * 状态与动作都在这里 —— 老 app.tsx 把这些和 JSX 搅在一起，积成 1271 行（ADR-0025 §9）。
 */
import { Connection, type ConnState, type StateInfo, type WebSocketLike } from '../conn/connection'
import { inputTrace, viewOf } from '../keys/inputstats'
import { Sticky, appAction, extraKeyBytes, type ExtraKeyId } from '../keys/keymap'
import { RawIme, cursorPosition } from '../keys/raw'
import { TextPages, type KeyPage, type TextPageEls, type TextSend } from '../keys/textpage'
import { Code, T, type ServerMessage, type Welcome } from '../protocol/messages'
import { SessionStore, routeInput, type SessionView } from '../sessions/store'
import { installDragWheel, installTapToggle } from '../term/gestures'
import { themeFromCss } from '../term/terminal'
import { inUserInputEvent } from '../term/userinput'
import { applyTheme, readFontSize, readTheme, validFontSize, writeFontSize, writeTheme, type Theme } from '../ui/prefs'
import { debounce, installAppFit, isCoarsePointer, watchCoarse } from '../ui/viewport'
import { readForm, type Form } from './form'

export interface Toast {
  id: number
  kind: 'recovered' | 'info' | 'warn' | 'error'
  text: string
}

export interface ImePreviewState {
  text: string
  left: number
  top: number
}

export interface AppState {
  form: Form
  coarse: boolean
  conn: ConnState
  connInfo: StateInfo
  /** 重连也没用的错误（协议不符）。 */
  fatal: string | null
  /** 设备被吊销（AC-1.11）：连接已停，界面要换成配对引导页。 */
  revoked: boolean
  /** agent 用户的家目录（welcome.home），CWD 里的它缩成 `~`；没有就不缩写。 */
  home: string | null
  /** 收到过 welcome：之前还不知道有哪些会话，不显示空状态。 */
  welcomed: boolean
  sessions: SessionView[]
  active: number | null
  maxSessions: number
  toast: Toast | null
  preview: ImePreviewState | null
  /** compact 的会话抽屉。 */
  sessionsOpen: boolean
  /** 设置浮层（AC-5.3，ADR-0037）。 */
  settingsOpen: boolean
  /** 等用户确认要关的会话（AC-4.11，ADR-0038）。 */
  closing: number | null
  theme: Theme
  /** 终端字号（px）。 */
  fontSize: number
  /** 当前会话的附加键槽停在哪一页（ADR-0036：每个会话各记一份）。 */
  page: KeyPage
}

const TOAST_MS = 3000

export class AppController {
  readonly sticky = new Sticky()
  private state: AppState
  private readonly listeners = new Set<() => void>()
  private readonly conn: Connection
  private readonly store: SessionStore
  private readonly enc = new TextEncoder()
  private area: HTMLElement | null = null
  /** 文本页跟着会话走（AC-3.22，ADR-0036）：各会话的页与草稿。 */
  private readonly pages = new TextPages()
  private textPage: TextPageEls | null = null
  private untrackText: (() => void) | null = null
  /** 文本框里此刻是哪个会话的草稿。 */
  private textOwner: number | null = null
  /** 文本框正在组字（输入法候选还没选）。 */
  private composing = false
  private ime: RawIme | null = null
  private imeEl: HTMLTextAreaElement | null = null
  private lastWelcome: Welcome | null = null
  private resizeCount = 0
  private reqSeq = 0
  private toastSeq = 0
  private toastTimer: ReturnType<typeof setTimeout> | undefined
  /** 自己发起的 session.create → 建好之后要不要把焦点给它。 */
  private readonly pendingCreate = new Map<string, boolean>()
  /**
   * 浮层关掉之后要不要把焦点还给输入处（AC-4.8 / ADR-0037 §4 / ADR-0038 §3）：打开时记下。
   * 抽屉记的是「打开前在不在打字」，选中会话、新建时再按形态算。
   */
  private drawerTyping = false
  private settingsRefocus = false
  private closeRefocus = false
  /**
   * 已经发了 session.close、还没收到 session.closed 的会话（ADR-0038 §5）。agent 先把会话从表里
   * 删掉、再等进程退出（最多 2s），这段时间里发给它的任何东西都会换来 unknown_session。
   */
  private closeSent = new Set<number>()
  /** 附加键 / 文本页正在往终端里送字节：onData 出口别再套一次粘滞修饰。 */
  private keyBypass = false
  private lastW = 0
  private lastH = 0
  private readonly sendResize = debounce(() => this.sendResizeNow(), 100)

  /** 问一次「这台设备还认证着吗」：返回 HTTP 状态码。 */
  private readonly authProbe: () => Promise<number>
  private probing = false

  constructor(
    opts: {
      url?: string
      clientID?: string
      socketFactory?: (url: string) => WebSocketLike
      authProbe?: () => Promise<number>
    } = {},
  ) {
    this.authProbe = opts.authProbe ?? (() => fetch('/api/devices', { credentials: 'same-origin' }).then((r) => r.status))
    this.state = {
      form: readForm(),
      coarse: isCoarsePointer(),
      conn: 'connecting',
      connInfo: {},
      fatal: null,
      revoked: false,
      home: null,
      welcomed: false,
      sessions: [],
      active: null,
      maxSessions: 20,
      toast: null,
      preview: null,
      sessionsOpen: false,
      settingsOpen: false,
      closing: null,
      theme: readTheme(),
      fontSize: readFontSize(),
      page: 'keys',
    }
    this.conn = new Connection({
      url: opts.url ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
      clientID: opts.clientID ?? clientID(),
      socketFactory: opts.socketFactory,
      handlers: {
        onOutput: (sid, data, replay) => this.store.output(sid, data, replay),
        onSnapshot: (sid, data) => this.store.snapshot(sid, data),
        onMessage: (msg) => this.onMessage(msg),
        onState: (conn, connInfo) => this.set({ conn, connInfo }),
        onRecovered: (bytes) => this.toast('recovered', `已恢复 · 补齐 ${formatBytes(bytes)}`),
        onRestart: () => {
          const had = this.store.list().length > 0
          this.store.clear()
          if (had) this.toast('warn', '会话已结束（agent 可能已重启）')
        },
        onFatal: (reason) => this.set({ fatal: reason }),
        onUnauthorized: () => this.revoke(),
        onClosed: (welcomed) => {
          // 一个 welcome 都没收到就断了：升级多半被拒了。浏览器不给 WebSocket 的 HTTP 状态码，
          // 问一次 REST：401 就是设备被吊销（离线期间被吊销的走这条）
          if (!welcomed) this.probeAuth()
        },
        onError: (reason) => this.toast('error', reason),
      },
    })
    this.store = new SessionStore(this.conn, {
      onChange: () => this.refresh(),
      onData: (sid, data) => this.onTermData(sid, data),
      onBinary: (sid, data) => this.onTermBinary(sid, data),
      allowKey: (e) => appAction(e) === null,
      theme: () => cssTheme(),
      fontSize: () => this.state.fontSize,
    })
  }

  // ---------- 状态 ----------

  get(): AppState {
    return this.state
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch }
    for (const fn of this.listeners) fn()
  }

  private refresh(): void {
    this.syncTextPage()
    // 确认浮层开着时会话没了（别处关掉、agent 重启）：跟着关，sid 会复用（ADR-0038 §4）
    const closing = this.state.closing !== null && this.store.has(this.state.closing) ? this.state.closing : null
    this.set({ sessions: this.store.list(), active: this.store.active, page: this.pages.page(this.store.active), closing })
  }

  private toast(kind: Toast['kind'], text: string): void {
    if (this.toastTimer) clearTimeout(this.toastTimer)
    this.set({ toast: { id: ++this.toastSeq, kind, text } })
    this.toastTimer = setTimeout(() => this.set({ toast: null }), TOAST_MS)
  }

  /**
   * 设备被吊销（AC-1.11 / E2E-15）：停止重连，界面换成配对引导页。
   * 继续重连只会一遍遍被 401 拒掉，用户还以为是网络问题。
   */
  private revoke(): void {
    if (this.state.revoked) return
    this.conn.close()
    this.set({ revoked: true, fatal: '此设备已被吊销' })
  }

  private probeAuth(): void {
    if (this.probing || this.state.revoked) return
    this.probing = true
    this.authProbe()
      .then((status) => {
        if (status === 401) this.revoke()
      })
      .catch(() => {
        /* 网络不通：照常重连 */
      })
      .finally(() => {
        this.probing = false
      })
  }

  // ---------- 挂载 ----------

  /** 终端容器与 `.app` 就位之后调用一次。返回卸载函数。 */
  mount(area: HTMLElement, root: HTMLElement): () => void {
    this.area = area

    // 【只在容器尺寸真的变了才 fit】：ResizeObserver 会因内容变化、亚像素抖动反复触发
    const ro = new ResizeObserver(() => this.measure())
    ro.observe(area)
    const unfit = installAppFit(root)
    // 形态在页面加载时算一次，之后不再变（layout.md §形态）：resize 里不重算 ——
    // 有的环境（Playwright 的设备模拟、部分安卓 WebView）里 screen 会跟着视口变，
    // 重算就会在弹键盘时把平板翻成 compact。窗口挪到别的显示器上，刷新一次即可。
    const uncoarse = watchCoarse((coarse) => this.set({ coarse }))

    // 网络恢复 / 页面重新可见 → 立即重试或探活（AC-2.9 / AC-2.20）
    const kick = () => this.conn.retryNow()
    const onVisible = () => {
      if (document.visibilityState === 'visible') kick()
    }
    window.addEventListener('online', kick)
    document.addEventListener('visibilitychange', onVisible)

    // 输入路径探针的头两段（AC-3.17）。【必须是捕获阶段】：xterm 处理掉的键会
    // preventDefault + stopPropagation，冒泡阶段根本收不到
    const onKeyTrace = () => {
      inputTrace.bump('keydown')
      if (document.activeElement?.classList.contains('xterm-helper-textarea')) inputTrace.bump('toTerm')
    }
    const onKey = (e: KeyboardEvent) => this.onShortcut(e)
    window.addEventListener('keydown', onKeyTrace, true)
    window.addEventListener('keydown', onKey)

    const untap = installTapToggle(area, () => {
      const t = this.activeTerm()
      if (!t) return null
      return {
        mouseTracking: () => t.mouseTracking(),
        focused: () => document.activeElement === t.term.textarea,
        focus: () => t.term.focus(),
        blur: () => t.term.blur(),
      }
    })
    const undrag = installDragWheel(area, () => this.activeTerm() ?? null)

    // 主题跟随系统时（AC-5.3）：系统切深浅色时 CSS 变量已经变了，xterm 的要重读一遍。
    // 强制了浅色 / 深色时重读的结果不变，无害
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    const onScheme = () => this.store.setTheme(cssTheme())
    mq?.addEventListener('change', onScheme)

    ;(window as unknown as { __webterm: unknown }).__webterm = this.hooks()
    this.conn.connect()

    return () => {
      window.removeEventListener('online', kick)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('keydown', onKeyTrace, true)
      window.removeEventListener('keydown', onKey)
      mq?.removeEventListener('change', onScheme)
      ro.disconnect()
      unfit()
      uncoarse()
      untap()
      undrag()
      this.sendResize.cancel()
      this.ime?.dispose()
      this.untrackText?.()
      this.conn.close()
      this.store.dispose()
      if (this.toastTimer) clearTimeout(this.toastTimer)
      this.area = null
    }
  }

  /**
   * 附加键组件交上来（或收回）文本页的 DOM。之后切会话时由这里同步翻页、换草稿、给焦点。
   * 附加键可能晚于会话出现（`pointer: coarse` 在运行中变了），所以交上来时先装上当前会话的那一份。
   */
  registerTextPage(els: TextPageEls | null): void {
    const old = this.textPage
    if (old) this.pages.setDraft(this.textOwner, old.text.value)
    this.untrackText?.()
    this.untrackText = null
    this.composing = false
    this.textPage = els
    if (!els) return
    els.text.value = this.pages.draft(this.textOwner)
    els.slot.dataset.page = this.pages.page(this.textOwner)
    const start = () => (this.composing = true)
    const end = () => (this.composing = false)
    els.text.addEventListener('compositionstart', start)
    els.text.addEventListener('compositionend', end)
    els.text.addEventListener('blur', end)
    this.untrackText = () => {
      els.text.removeEventListener('compositionstart', start)
      els.text.removeEventListener('compositionend', end)
      els.text.removeEventListener('blur', end)
    }
  }

  // ---------- 会话 ----------

  /**
   * 切到某个会话。焦点跟着会话走（AC-4.8）：`activate()` 把上一个会话的 DOM 摘掉时
   * 焦点会落回 body，所以先记下「焦点在不在终端或文本框里」，切完还给**新会话的输入处**
   * （它停在文本页就是文本框，否则是终端，ADR-0036）；非触摸设备无条件还。
   * `focus` 显式给出时以它为准（从抽屉切换：看打开抽屉之前）。点的就是当前会话时不挪焦点。
   */
  select(sid: number, focus?: boolean): void {
    const area = this.area
    if (!area || !this.store.has(sid)) return
    const typing = this.typing()
    const same = sid === this.store.active
    this.store.activate(sid, area)
    this.attachIme()
    this.syncTextPage()
    if ((focus ?? this.refocus(typing)) && !(same && typing)) this.focusInput()
    this.refresh()
  }

  step(delta: number): void {
    const next = this.store.step(delta)
    if (next !== null && next !== this.store.active) this.select(next)
  }

  newSession(focus?: boolean): void {
    if (this.state.sessions.length >= this.state.maxSessions) {
      this.toast('warn', `会话数已达上限 ${this.state.maxSessions}`)
      return
    }
    if (this.state.conn !== 'online') {
      this.toast('warn', '未连接，稍后再新建会话')
      return
    }
    const reqID = `new-${++this.reqSeq}`
    this.pendingCreate.set(reqID, focus ?? this.refocus(this.typing()))
    const sid = this.store.active
    const cur = sid === null ? undefined : this.store.info(sid)
    const t = this.activeTerm()?.term
    this.conn.send({
      t: T.sessionCreate,
      req_id: reqID,
      name: null,
      // cwd 默认继承当前会话 —— 通常是想在同一个项目里再开一个
      cwd: cur?.cwd || null,
      cols: t?.cols ?? 80,
      rows: t?.rows ?? 24,
    })
  }

  /** 关闭会话：`running` 的先弹确认浮层（AC-4.11，ADR-0038），`exited` 的直接关。 */
  requestClose(sid: number): void {
    const info = this.store.info(sid)
    if (!info || this.state.closing !== null) return
    if (info.status !== 'running') {
      this.sendClose(sid)
      return
    }
    // 从抽屉里打开的不还焦点（留在抽屉里）
    this.closeRefocus = !this.state.sessionsOpen && this.refocus(this.typing())
    this.set({ closing: sid })
  }

  /**
   * 确认关闭。【先还焦点、再发 session.close】：agent 回 session.closed 后切到相邻会话，
   * 那一步看焦点在不在终端里决定给不给新会话焦点（AC-4.8）；先发再还就被判成「没在打字」。
   */
  confirmClose(): void {
    const sid = this.state.closing
    if (sid === null) return
    this.endClosing()
    if (this.store.has(sid)) this.sendClose(sid)
  }

  cancelClose(): void {
    if (this.state.closing === null) return
    this.endClosing()
  }

  private endClosing(): void {
    this.set({ closing: null })
    if (this.closeRefocus) this.focusInput()
  }

  private sendClose(sid: number): void {
    if (this.closeSent.has(sid)) return
    // 离线时 send 会静默丢掉：别标成关闭中（否则重连后它活着却再也收不到输入）
    if (this.state.conn !== 'online') {
      this.toast('warn', '未连接，稍后再关闭会话')
      return
    }
    this.closeSent.add(sid)
    this.conn.send({ t: T.sessionClose, req_id: `close-${++this.reqSeq}`, sid })
  }

  /** 改名；空字符串恢复跟随 CWD 自动命名。没改动（自动名原样确认）不发，免得它停止跟随 CWD。 */
  rename(sid: number, name: string): void {
    const trimmed = name.trim()
    const info = this.store.info(sid)
    if (!info || trimmed === info.name) return
    this.conn.send({ t: T.sessionRename, req_id: `rename-${++this.reqSeq}`, sid, name: trimmed === '' ? null : trimmed })
  }

  togglePin(sid: number): void {
    this.store.togglePinned(sid)
  }

  /** 拖动排序松手（ADR-0040）：本地先挪，再告诉 agent；收到 session.order 以它为准。 */
  moveSession(sid: number, before: number | null): void {
    if (!this.store.has(sid)) return
    this.store.move(sid, before)
    this.conn.send({ t: T.sessionMove, req_id: `move-${++this.reqSeq}`, sid, before })
  }

  // ---------- 浮层 ----------

  openSessions(): void {
    this.drawerTyping = this.typing()
    this.set({ sessionsOpen: true, settingsOpen: false })
  }

  closeSessions(): void {
    this.set({ sessionsOpen: false })
  }

  /** 在抽屉里选中一个会话：关抽屉，焦点按「打开抽屉之前」恢复（在这次点击里，iOS 才弹键盘）。 */
  selectFromDrawer(sid: number): void {
    this.set({ sessionsOpen: false })
    this.select(sid, this.refocus(this.drawerTyping))
  }

  newFromDrawer(): void {
    this.set({ sessionsOpen: false })
    this.newSession(this.refocus(this.drawerTyping))
  }

  /**
   * 打开设置（ADR-0037 §2）。从会话抽屉里打开的，焦点此刻在抽屉里，「之前在哪」看打开抽屉之前。
   */
  openSettings(): void {
    this.settingsRefocus = this.refocus(this.state.sessionsOpen ? this.drawerTyping : this.typing())
    this.set({ settingsOpen: true, sessionsOpen: false })
  }

  /** 关掉设置：打开前在打字的、或非触摸设备，焦点还回去（ADR-0037 §4）。 */
  closeSettings(): void {
    if (!this.state.settingsOpen) return
    this.set({ settingsOpen: false })
    if (this.settingsRefocus) this.focusInput()
  }

  // ---------- 偏好（AC-5.3，ADR-0037） ----------

  setTheme(theme: Theme): void {
    if (theme === this.state.theme) return
    applyTheme(theme)
    writeTheme(theme)
    this.set({ theme })
    this.store.setTheme(cssTheme())
  }

  /** 改字号：所有实例一起换 → fit → 补一条 resize（容器没变，ResizeObserver 不会响）。 */
  setFontSize(px: number): void {
    if (!validFontSize(px) || px === this.state.fontSize) return
    writeFontSize(px)
    this.set({ fontSize: px })
    this.store.setFontSize(px)
    this.measure(true)
  }

  // ---------- 输入 ----------

  /** 附加键（在 pointer 事件的派发里调用）：按当前粘滞修饰与 DECCKM 算好字节，走 onData 出口。 */
  pressKey(id: ExtraKeyId): void {
    const t = this.activeTerm()
    if (!t) return
    const bytes = extraKeyBytes(id, this.sticky.take(), t.term.modes.applicationCursorKeysMode)
    if (!bytes) return
    this.keyBypass = true
    try {
      t.term.input(bytes, true)
    } finally {
      this.keyBypass = false
    }
  }

  /**
   * 文本输入页的回车（在 keydown 的派发里调用，ADR-0027）。内容走 paste、回车单独键入：
   * 「长内容 + \r」一次写进去，claude 会当成整块粘贴把 \r 吞掉。粘滞修饰不碰这两样 ——
   * ALT 激活时回车会变成 ESC \r，claude 把它当换行。
   */
  sendText(send: TextSend): void {
    const t = this.activeTerm()
    if (!t || send.kind !== 'submit') return
    this.keyBypass = true
    try {
      if (send.text !== '') t.term.paste(send.text)
      t.term.input('\r', true)
    } finally {
      this.keyBypass = false
    }
  }

  focusTerm(): void {
    this.activeTerm()?.term.focus()
  }

  /**
   * ✎ 或键区横滑：翻当前会话的页（ADR-0036）。DOM 上的页【同步】翻：下一行的 focus() 要求
   * 文本框此刻已经可见，而且必须在这次点击 / 抬起的处理函数里聚焦，iOS 才会弹键盘。
   */
  togglePage(): void {
    const sid = this.store.active
    const next: KeyPage = this.pages.page(sid) === 'keys' ? 'text' : 'keys'
    this.pages.setPage(sid, next)
    const el = this.textPage
    if (el) el.slot.dataset.page = next
    this.set({ page: next })
    if (next === 'text') el?.text.focus({ preventScroll: true })
    else if (el && document.activeElement === el.text) this.focusTerm()
  }

  /** 焦点给当前会话的输入处：停在文本页（且文本页在界面上）就是文本框，否则是终端。 */
  private focusInput(): void {
    const el = this.textPage
    if (el && this.pages.page(this.store.active) === 'text') el.text.focus({ preventScroll: true })
    else this.focusTerm()
  }

  /**
   * 当前会话变了（切换、关掉、agent 重启）就把文本框换成它的草稿、附加键槽翻到它的页
   * （AC-3.22）。旧会话还在就先把框里的内容存成它的草稿。组字中先失焦，让输入法把组到一半的字
   * 提交进框里再存 —— 直接改 `value` 会让输入法丢字，或把字补进新会话的草稿（ADR-0036 §3）。
   */
  private syncTextPage(): void {
    this.pages.retain((s) => this.store.has(s))
    const sid = this.store.active
    if (sid === this.textOwner) return
    const el = this.textPage
    const owner = this.textOwner
    this.textOwner = sid
    if (!el) return
    if (this.composing && document.activeElement === el.text) el.text.blur()
    if (owner === null || this.store.has(owner)) this.pages.setDraft(owner, el.text.value)
    el.text.value = this.pages.draft(sid)
    el.slot.dataset.page = this.pages.page(sid)
  }

  private onTermData(sid: number, data: string): void {
    // 关闭中：键入、焦点上报（tmux / claude 开了 1004）都不再发（ADR-0038 §5）
    if (this.closeSent.has(sid)) return
    // 组字期间【一个字节都不能发】—— 只在 compositionend 时一次性提交（AC-3.3）
    if (sid === this.store.active && this.ime?.isComposing) return
    // 粘滞 CTRL / ALT 对软键盘打出来的下一个字符也生效；附加键自己已经算过了
    const out = inUserInputEvent() && !this.keyBypass ? this.sticky.apply(data) : data
    const info = this.store.info(sid)
    if (!info) return
    switch (routeInput(info.status, out)) {
      case 'send':
        this.conn.sendInput(sid, this.enc.encode(out))
        break
      case 'close':
        this.requestClose(sid)
        break
      case 'drop':
        break
    }
  }

  private onTermBinary(sid: number, data: string): void {
    if (this.closeSent.has(sid) || this.store.info(sid)?.status !== 'running') return
    this.conn.sendInput(sid, Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff))
  }

  private onShortcut(e: KeyboardEvent): void {
    const act = appAction(e)
    if (act === null) return
    e.preventDefault()
    const sid = this.store.active
    switch (act) {
      case 'newSession':
        this.newSession()
        break
      case 'closeSession':
        if (sid !== null) this.requestClose(sid)
        break
      case 'prevSession':
        this.step(-1)
        break
      case 'nextSession':
        this.step(1)
        break
      case 'toggleSessions':
        // wide 上不做任何事：会话在标签栏里
        if (this.state.form === 'compact') {
          if (this.state.sessionsOpen) this.closeSessions()
          else this.openSessions()
        }
        break
    }
  }

  /**
   * IME 挂在当前会话的 helper textarea 上。【每个会话有自己的 xterm，也就有自己的
   * textarea】，切会话必须重新挂，否则组字期间的字节会直通 PTY（AC-3.3）。
   */
  private attachIme(): void {
    const helper = this.area?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea') ?? null
    if (!helper || helper === this.imeEl) return
    this.ime?.dispose()
    this.imeEl = helper
    this.ime = new RawIme(helper, {
      // 同一个 onData 出口：回放门、粘滞修饰、inputStats 一视同仁
      onCommit: (text) => this.activeTerm()?.term.input(text, true),
      onPreview: (text) => this.set({ preview: text ? this.previewAt(text) : null }),
    })
  }

  private previewAt(text: string): ImePreviewState | null {
    const t = this.activeTerm()
    const screen = this.area?.querySelector<HTMLElement>('.xterm-screen')
    const stage = this.area?.parentElement
    if (!t || !screen || !stage) return null
    const s = screen.getBoundingClientRect()
    const g = stage.getBoundingClientRect()
    const cell = { width: s.width / Math.max(t.term.cols, 1), height: s.height / Math.max(t.term.rows, 1) }
    const buf = t.term.buffer.active
    const pos = cursorPosition(buf.cursorX, buf.cursorY, cell)
    return { text, left: s.left - g.left + pos.left, top: s.top - g.top + pos.top }
  }

  // ---------- 尺寸 ----------

  /**
   * 容器尺寸变了 → fit → 防抖发 resize。`force`：容器没变但字符格变了（改字号），
   * 尺寸去重会把整次量算吞掉，客户端与 PTY 的 cols/rows 就分了家。
   */
  private measure(force = false): void {
    const area = this.area
    if (!area) return
    const w = area.clientWidth
    const h = area.clientHeight
    if (!force && w === this.lastW && h === this.lastH) return
    this.lastW = w
    this.lastH = h
    const t = this.activeTerm()
    if (!t) return
    t.fit()
    this.sendResize()
  }

  private sendResizeNow(): void {
    const sid = this.store.active
    const t = this.activeTerm()?.term
    if (sid === null || !t || this.closeSent.has(sid)) return
    this.conn.send({ t: T.resize, sid, cols: t.cols, rows: t.rows })
    this.resizeCount++
  }

  // ---------- 消息 ----------

  private onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case T.welcome:
        this.onWelcome(msg)
        break
      case T.sessionCreated: {
        this.store.upsert(msg.session)
        const focus = msg.req_id === undefined ? undefined : this.pendingCreate.get(msg.req_id)
        if (focus !== undefined) {
          this.pendingCreate.delete(msg.req_id!)
          this.select(msg.session.sid, focus)
        } else if (this.store.active === null) {
          this.select(msg.session.sid)
        }
        break
      }
      case T.sessionClosed:
        this.closeLocal(msg.sid)
        break
      case T.sessionOrder:
        this.store.setOrder(msg.sids)
        break
      case T.sessionUpdated: {
        const { t: _t, sid, head_seq: _head, ...patch } = msg
        this.store.patch(sid, patch)
        break
      }
      case T.error:
        // 关闭中、或者本来就没有了的会话：agent 说「会话不存在」是意料之中，不弹（ADR-0038 §5）
        if (msg.code === Code.unknownSession && msg.sid !== undefined && (this.closeSent.has(msg.sid) || !this.store.has(msg.sid))) break
        if (msg.code === Code.sessionLimit) this.toast('warn', `会话数已达上限 ${this.state.maxSessions}`)
        else if (msg.code !== Code.unauthorized && msg.code !== Code.protocolUnsupported && msg.code !== Code.sessionExited) {
          this.toast('error', msg.message || msg.code)
        }
        break
      case T.notice:
        this.toast(msg.level, msg.message)
        break
    }
    this.refresh()
  }

  private onWelcome(w: Welcome): void {
    const first = !this.state.welcomed
    this.lastWelcome = w
    let gone = false
    for (const r of w.resumed) {
      if (r.status !== 'gone') continue
      if (this.store.has(r.sid)) gone = true
      this.store.remove(r.sid)
    }
    // 离线期间被关掉的会话
    const live = new Set(w.sessions.map((s) => s.sid))
    for (const s of this.store.list()) if (!live.has(s.sid)) this.store.remove(s.sid)
    for (const s of w.sessions) this.store.upsert(s)
    // welcome 里还在的会话，它的 session.close 没落地（断线、agent 重启后 sid 复用）：不再算关闭中
    this.closeSent.clear()
    // welcome.sessions[] 的顺序就是显示顺序（ADR-0040）
    this.store.setOrder(w.sessions.map((s) => s.sid))
    if (gone) this.toast('warn', '会话已结束（agent 可能已重启）')
    this.set({ welcomed: true, maxSessions: w.limits.max_sessions, fatal: null, home: w.home || null })

    const active = this.store.active
    if (active === null) {
      const firstSid = this.store.first()
      if (firstSid !== null) this.select(firstSid)
      else if (first) this.newSession()
      return
    }
    // 重连：离线期间终端尺寸可能变过（键盘、旋转），那几条 resize 没发出去
    const t = this.activeTerm()?.term
    const info = this.store.info(active)
    if (t && info && (t.cols !== info.cols || t.rows !== info.rows)) this.sendResizeNow()
  }

  private closeLocal(sid: number): void {
    const wasActive = this.store.active === sid
    const typing = this.typing()
    const next = wasActive ? this.store.neighbourOf(sid) : null
    // 【先标成关闭中再拆】：dispose 时 xterm 失焦，开了焦点上报的程序会再吐一个 ESC [O
    this.closeSent.add(sid)
    this.store.remove(sid)
    this.closeSent.delete(sid)
    if (next !== null) this.select(next, this.refocus(typing))
  }

  private activeTerm() {
    const sid = this.store.active
    return sid === null ? undefined : this.store.termOf(sid)
  }

  /** 焦点在不在输入处（终端或文本输入页）里。 */
  private typing(): boolean {
    const el = document.activeElement
    return (!!this.textPage && el === this.textPage.text) || !!this.area?.contains(el)
  }

  /** 要不要把焦点给输入处：原来在打字的，或者非触摸设备（无条件给，AC-4.8）。 */
  private refocus(typing: boolean): boolean {
    return typing || !this.state.coarse
  }

  // ---------- 调试 / E2E 钩子 ----------

  /** `window.__webterm`（e2e-scenarios.md；inputStats 生产构建里也在，AC-3.17）。 */
  private hooks() {
    const term = () => this.activeTerm()?.term
    return {
      /** 当前会话的整个缓冲区文本（含 scrollback）。 */
      text: () => {
        const t = term()
        if (!t) return ''
        const buf = t.buffer.active
        const out: string[] = []
        for (let i = 0; i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) ?? '')
        return out.join('\n')
      },
      /** SerializeAddon 的结果（字节级比较用）。 */
      serialize: () => this.activeTerm()?.serialize.serialize() ?? '',
      outSeq: () => (this.store.active === null ? 0 : this.conn.outSeqOf(this.store.active)),
      size: () => ({ cols: term()?.cols ?? 0, rows: term()?.rows ?? 0 }),
      welcome: () => this.lastWelcome,
      resizes: () => this.resizeCount,
      sid: () => this.store.active,
      form: () => this.state.form,
      fontSize: () => term()?.options.fontSize ?? 0,
      altScreen: () => this.activeTerm()?.altScreen() ?? false,
      unread: (sid: number) => this.conn.isUnread(sid),
      /** 最近收到的二进制帧 `{type, kind, sid, seq, flags, bytes, replay}`。 */
      frames: () => this.conn.frames(),
      scrollLines: (n: number) => term()?.scrollLines(n),
      viewport: () => {
        const t = term()
        if (!t) return { y: -1, top: '' }
        const buf = t.buffer.active
        return { y: buf.viewportY, top: buf.getLine(buf.viewportY)?.translateToString(true) ?? '' }
      },
      // 打字没反应时按段看断在哪一层（AC-3.17）
      inputStats: () =>
        viewOf(
          inputTrace.snapshot({
            unackedBytes: this.store.active === null ? 0 : this.conn.unackedOf(this.store.active),
            focus: focusName(document.activeElement),
            sid: this.store.active,
          }),
          Date.now(),
        ),
    }
  }
}

/**
 * client_id：输入记账的 key（§4.1 / §5.4）。【每次页面加载一个，只在内存里】——
 * 跨重连稳定靠的是 Connection 对象活着，不需要存。
 *
 * 不能存 sessionStorage：刷新之后标签页还是那个、id 也还是那个，agent 那边这个
 * (client_id, sid) 的 in_ack 还停在刷新前的累计值，而新页面的 in_seq 从 0 重新数 ——
 * 刷新后敲的前 N 个字节全被当成「已处理过的重发」静默丢掉（E2E-36 ⑤ 实测：
 * 27 字节发出去、永远不 ack，命令没执行），违反 ADR-0020。
 */
function clientID(): string {
  return crypto.randomUUID()
}

function cssTheme() {
  const style = getComputedStyle(document.documentElement)
  return themeFromCss((n) => style.getPropertyValue(n))
}

function focusName(el: Element | null): string {
  if (!el || el === document.body) return ''
  return el.className || (el as HTMLElement).dataset?.testid || el.tagName.toLowerCase()
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
