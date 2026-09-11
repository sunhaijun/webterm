/**
 * webterm 主界面：多会话 + 三档响应式布局。
 *
 * 见 docs/40-frontend/session-ux.md 与 layout-responsive.md。
 */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import { listCommands, type CommandRecord } from '../commands/api'
import { HistoryPanel, QuickBar } from '../commands/history'
import { CommandPalette } from '../commands/palette'
import { Connection, type ConnState, type StateInfo } from '../conn/connection'
import { useChips } from '../input/chips'
import { type Chip, tokenAt } from '../input/complete'
import { Composer, type ComposerHandle } from '../input/composer'
import { KeyBar } from '../input/keybar'
import { EDIT_INSERT, appAction, programOf } from '../input/keymap'
import type { ModeState } from '../input/modes'
import { RawIme, cursorPosition } from '../input/raw'
import { installSwipeDismiss } from './swipe'
import { installPinch } from '../term/pinch'
import { SLOT_HEIGHT, WriteSheet, type SheetSize } from '../input/sheet'
import { T } from '../protocol/messages'
import { SessionStore, type SessionView } from '../sessions/store'
import { ExitedBar, SessionList } from './sessionlist'
import { applyTheme, readFontSize, readTheme, writeFontSize, type Theme } from './settings'
import { RecoveredToast, StatusBar } from './status'
import { breakpoint, debounce, isCoarsePointer, isKeyboardUp, isShort, layoutViewportHeight, readViewport, type Breakpoint, watchViewport } from './viewport'


/** 视图选择：手机/平板默认读，桌面默认终端（ADR-0011）；用户切过就记住。 */
/** client_id 每个标签页一个，存 sessionStorage —— localStorage 是同源共享的。 */
function clientID(): string {
  const key = 'webterm.client_id'
  let v = sessionStorage.getItem(key)
  if (!v) {
    v = crypto.randomUUID()
    sessionStorage.setItem(key, v)
  }
  return v
}

export function App() {
  const termAreaRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  const connRef = useRef<Connection | null>(null)
  const storeRef = useRef<SessionStore | null>(null)
  const composerRef = useRef<ComposerHandle | null>(null)
  const sendRawRef = useRef<(bytes: string) => void>(() => {})

  const [connState, setConnState] = useState<ConnState>('connecting')
  const [info, setInfo] = useState<StateInfo>({})
  const [sessions, setSessions] = useState<SessionView[]>([])
  const [activeSid, setActiveSid] = useState<number | null>(null)
  const [mode, setMode] = useState<ModeState>({ mode: 'composer' })
  const [maxSessions, setMaxSessions] = useState(20)
  const [recovered, setRecovered] = useState<number | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [fatal, setFatal] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ text: string; left: number; top: number } | null>(null)
  const [bp, setBp] = useState<Breakpoint>(() => breakpoint(window.innerWidth))
  const [short, setShort] = useState(() => isShort(window.innerHeight))
  const [sidebarOpen, setSidebarOpen] = useState(() => breakpoint(window.innerWidth) === 'desktop')
  const classicRef = useRef(breakpoint(window.innerWidth) === 'desktop')
  const [coarse] = useState(isCoarsePointer)
  const [theme, setTheme] = useState<Theme>(readTheme)
  const [fontSize, setFontSize] = useState(readFontSize)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  // 块存储活在 ref 里（它不参与渲染），用一个计数器把它的变化推给 UI。
  // 读视图 / 终端视图（ADR-0011）。手机、平板默认读；桌面默认终端。选择持久化。
  // 【同步写入，不放 useEffect】。effect 在 paint 之后才跑，用户切完视图立刻
  // 刷新或关页，写入就丢了（CI 上稳定复现：toggle 后马上 reload，选择没记住）。
  // 备用屏幕（有程序占屏）驱动的自动切换（ADR-0011 分片 ②）：
  // 读视图里 vim / top 一进备用缓冲就切到终端，退出后自动回读。
  // 【自动切换不持久化】—— 它是临时的，用户的偏好还是读。
  const [interactive, setInteractive] = useState(false)
  const [altScreen, setAltScreen] = useState(false) // 全屏 TUI（备用缓冲）：底部只留键条
  // 前台正在跑的命令原文（按会话）—— 只用来给键条上下文 / Composer 占位符取程序名。
  const runningCmdRef = useRef(new Map<number, string>())
  const [program, setProgram] = useState<string | null>(null)
  const [quick, setQuick] = useState<CommandRecord[]>([])
  // 写态 sheet（ADR-0011 ③）：读视图里输入框升起的那块。三档：收起 / 半屏 / 全屏。
  const [sheet, setSheet] = useState<SheetSize>('closed')
  const sheetRef = useRef<SheetSize>('closed')
  sheetRef.current = sheet
  // 上次打开时的档位 —— 下次碰输入框还回到那一档
  const lastOpenRef = useRef<Exclude<SheetSize, 'closed'>>('half')
  // .bottom 实际多高：超出收起态的部分是盖在块流上的，块流据此让位
  const [, setBottomH] = useState(SLOT_HEIGHT)
  const [draft, setDraft] = useState({ value: '', cursor: 0 })
  const [moreOpen, setMoreOpen] = useState(false)
  // 最近一次「在终端里看」是怎么定位的（marker / search / bottom），测试与诊断用
  const changeSheet = useCallback((next: SheetSize) => {
    setSheet(next)
    // 收起就收键盘 —— sheet 收了键盘还占着半屏，等于没收
    if (next === 'closed') composerRef.current?.blur()
    else lastOpenRef.current = next
  }, [])
  const openSheet = useCallback(() => {
    // 只有读视图有 sheet：终端视图里输入框就是一行，不能盖住终端的最后几行
    if (sheetRef.current === 'closed') changeSheet(lastOpenRef.current)
  }, [changeSheet])
  // 命令一跑起来（raw）sheet 就收：这时候该看的是输出
  useEffect(() => {
    if (mode.mode === 'raw') setSheet('closed')
  }, [mode.mode])

  const reloadQuick = useCallback(() => {
    listCommands({ pinned: true, limit: 50 })
      .then((r) => setQuick(r.items))
      .catch(() => setQuick([]))
  }, [])
  useEffect(reloadQuick, [reloadQuick])

  useEffect(() => applyTheme(theme), [theme])
  useEffect(() => {
    if (classicRef.current || !sidebarOpen || !sidebarRef.current) return
    return installSwipeDismiss(sidebarRef.current, () => setSidebarOpen(false))
  }, [sidebarOpen])

  const refresh = useCallback(() => {
    const store = storeRef.current
    if (!store) return
    setSessions(store.list())
    setActiveSid(store.active)
    if (store.active !== null) setMode(store.modesOf(store.active)?.current ?? mode)
  }, [mode])

  useEffect(() => {
    const area = termAreaRef.current
    if (!area) return

    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
    let store: SessionStore
    let lastWelcome: unknown = null
    const pinch = installPinch(area)
    const runningCmd = runningCmdRef.current
    // 前台程序名同步给 render（键条上下文 / Composer 占位符）
    const syncProgram = () => {
      const sid = store.active
      setProgram(sid === null ? null : (programOfMaybe(runningCmd.get(sid)) ))
    }

    const conn = new Connection({
      url,
      clientID: clientID(),
      handlers: {
        onOutput(sid, data) {
          // 带上 out_seq：写入时在 command.start/end 的位置登记行锚点（ADR-0011 ④）
          store.write(sid, data)
        },
        onMessage(msg) {
          switch (msg.t) {
            case T.welcome: {
              lastWelcome = msg
              setMaxSessions(msg.limits.max_sessions)
              // 缓冲被覆盖 → 先清屏再接后续帧，并明确告诉用户历史被截断了
              for (const r of msg.resumed) {
                if (r.status === 'reset') {
                  store.resetTerm(r.sid)
                  setTruncated(true)
                }
                if (r.status === 'gone') store.remove(r.sid)
              }
              for (const s of msg.sessions) store.upsert(s)
              if (msg.sessions.length === 0) newSession()
              else if (store.active === null) select(msg.sessions[0]!.sid)
              break
            }
            case T.sessionCreated:
              store.upsert(msg.session)
              select(msg.session.sid)
              break
            case T.sessionClosed: {
              const wasActive = store.active === msg.sid
              store.remove(msg.sid)
              runningCmd.delete(msg.sid)
              // 关掉的是当前会话且还有别的 → 自动切过去，别留一块空白终端
              if (wasActive) {
                const next = store.firstSid()
                if (next !== null) select(next)
              }
              break
            }
            case T.sessionUpdated: {
              const { t: _t, sid, ...patch } = msg
              store.patch(sid, patch)
              break
            }
            case T.commandStart:
              runningCmd.set(msg.sid, msg.text)
              if (msg.sid === store.active) {
                syncProgram()
                pinch.reset()
              }
              // 新命令：清掉上一条的"主屏就地重绘"判定，从头认
              store.resetInteractive(msg.sid)
              break
            case T.commandEnd:
              runningCmd.delete(msg.sid)
              if (msg.sid === store.active) syncProgram()
              store.resetInteractive(msg.sid)
              break
            case T.prompt:
              // 这条消息驱动输入模式自动切换（ADR-0007）
              store.modesOf(msg.sid)?.onPrompt(msg.state)
              break
            case T.reset:
              store.resetTerm(msg.sid)
              setTruncated(true)
              break
          }
          refresh()
        },
        onState(s, i) {
          setConnState(s)
          setInfo(i)
          if (s === 'online' && i.replayedBytes) {
            setRecovered(i.replayedBytes)
            setTimeout(() => setRecovered(null), 3000)
          }
        },
        onFatal: (reason) => setFatal(reason),
      },
    })
    connRef.current = conn

    store = new SessionStore(conn, () => fontSize, {
      onChange: refresh,
      onModeChange: (sid, s) => {
        if (store.active === sid) setMode(s)
      },
      onInteractive: (sid, on) => {
        if (store.active !== sid) return
        applyInteractive(on)
      },
      onTermData: (sid, data) => {
        // 点终端区打字 = 逐键直送（ADR-0013+：按触摸位置自动判定，不再有输入模式）。
        // 键只在 xterm 聚焦时才来这儿；底部输入条是另一条「编辑后发送」的路。
        if (store.active !== sid) return
        // 组字期间【一个字节都不能发】—— 只在 compositionend 时一次性提交
        if (ime?.isComposing) return
        sendRaw(data)
      },
      allowKey: (e) => appAction(e) === null,
    })
    storeRef.current = store

    // 占屏（备用缓冲 vim/top，或主屏就地重绘 claude/codex）：只用来把视口钉到底、
    // 换键条上下文。【不再切视图】—— 终端始终是唯一的显示面（ADR-0013）。
    const applyInteractive = (on: boolean) => {
      setInteractive(on)
      setAltScreen(store.active !== null && store.altScreenOf(store.active))
      if (on) {
        const sid = store.active
        if (sid !== null) store.termOf(sid)?.term.scrollToBottom()
      }
    }
    const select = (sid: number) => {
      store.activate(sid, area)
      // activate 里的 term.open() 是同步的，此刻 textarea 已经在 DOM 里
      attachIme()
      pinch.reset()
      setTruncated(false)
      sendResize()
      syncProgram()
      // 切到的会话如果正有程序占屏，键条要跟着它。回放（top 的 DECCKM 等）会稍后到达，
      // 到达时检测器的 CSI 处理器会补判；这里再延迟补一次 sync 兜底。
      applyInteractive(store.interactiveOf(sid))
      setTimeout(() => {
        if (store.active !== sid) return
        store.syncInteractive(sid)
        applyInteractive(store.interactiveOf(sid))
      }, 600)
    }
    const newSession = () => {
      const cur = store.active !== null ? store.get(store.active) : undefined
      conn.send({
        t: T.sessionCreate,
        req_id: `new-${Date.now()}`,
        name: null,
        // cwd 默认继承当前会话 —— 通常是想在同一个项目里再开一个
        cwd: cur?.cwd ?? null,
        cols: 80,
        rows: 24,
      })
    }
    selectRef.current = select
    newSessionRef.current = newSession

    conn.connect()

    const sendRaw = (bytes: string) => {
      const sid = store.active
      if (sid === null || bytes === '') return
      conn.sendInput(sid, new TextEncoder().encode(bytes))
    }
    sendRawRef.current = sendRaw

    // 应用级快捷键要拦下来，不能让它们进 PTY
    const onKey = (e: KeyboardEvent) => {
      const act = appAction(e)
      if (act === null) return
      const sid = store.active
      switch (act) {
        case 'newSession':
          newSession()
          break
        case 'closeSession':
          if (sid !== null) closeRef.current(sid)
          break
        case 'prevSession': {
          const n = store.step(-1)
          if (n !== null) select(n)
          break
        }
        case 'nextSession': {
          const n = store.step(1)
          if (n !== null) select(n)
          break
        }
        case 'toggleSidebar':
          setSidebarOpen((v) => !v)
          break
        case 'palette':
          setPaletteOpen((v) => !v)
          break
        case 'settings':
          setSettingsOpen((v) => !v)
          break
        default:
          return
      }
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)

    // resize 控制消息做 100ms 防抖（AC-3.11）
    const sendResize = debounce(() => {
      const sid = store.active
      const term = sid === null ? undefined : store.termOf(sid)
      if (sid !== null && term) {
        conn.send({ t: T.resize, sid, cols: term.term.cols, rows: term.term.rows })
      }
    }, 100)

    // 【只在容器尺寸真的变了才 fit】。ResizeObserver 会因为内容变化、亚像素
    // 抖动等被反复触发；每次都 fit() 会在全屏程序狂写时反复重算行列、给 PTY
    // 发 resize，程序被迫整屏重绘 —— 这就是终端视图里的"拖动抖动"。
    let lastW = 0
    let lastH = 0
    const ro = new ResizeObserver(() => {
      const w = area.clientWidth
      const h = area.clientHeight
      if (w === lastW && h === lastH) return
      lastW = w
      lastH = h
      const sid = store.active
      store.termOf(sid ?? -1)?.fit.fit()
      sendResize()
    })
    ro.observe(area)

    // 软键盘：高度的唯一真相来源是 visualViewport（iOS 上 100vh 不随键盘变化）。
    // 【不在这个回调里直接 fit()】—— 布局还没稳定，交给上面的 ResizeObserver。
    // 【viewport 补偿不能跟着滚动跑】。它本是给软键盘用的（iOS 弹键盘会把页面
    // 上推、100vh 不变），可 visualViewport 的 resize/scroll 在手机上【拖动时也
    // 连续触发】（地址栏滑入滑出改 height、边缘回弹改 offsetTop）。原来每个事件
    // 都同步重写 .app 的 height 和 translateY —— 容器一动、里面滚动的内容跟着移位、
    // 又触发下一个事件，被甩动惯性驱动成反馈环：拖一下抖一会儿才停。
    //
    // 两道闸：① rAF 合帧，一帧最多写一次；② 只有可视高度明显小于窗口（键盘真的
    // 占了地方）才写 translateY 补偿，普通滚动 / 回弹一律不写 —— 从根上断开那个环。
    let vpRaf = 0
    let lastVH = -1
    let lastVTop = -1
    const applyViewport = () => {
      if (vpRaf) return
      vpRaf = requestAnimationFrame(() => {
        vpRaf = 0
        const vp = readViewport()
        const root = area.closest('.app') as HTMLElement | null
        if (root) {
          const h = Math.round(vp.height)
          if (h !== lastVH) {
            root.style.height = `${h}px`
            lastVH = h
          }
          // 键盘弹起 = 可视高度比【布局视口】矮一大截；普通滚动 / 回弹的 offsetTop 不追。
          // 参照必须是 documentElement.clientHeight 而不是 window.innerHeight ——
          // Safari 的 innerHeight 是可视视口高度，键盘一弹它也变矮，闸门就永远关着，
          // 整个 .app 会被 Safari 推出可视区（viewport.ts::layoutViewportHeight）。
          const keyboardUp = isKeyboardUp(vp.height, layoutViewportHeight())
          const top = keyboardUp ? Math.round(vp.offsetTop) : 0
          if (top !== lastVTop) {
            root.style.transform = top ? `translateY(${top}px)` : ''
            lastVTop = top
          }
        }
        setBp(breakpoint(window.innerWidth))
        setShort(isShort(vp.height))
      })
    }
    applyViewport()
    const unwatchViewport = watchViewport(applyViewport)
    window.addEventListener('resize', applyViewport)

    // 网络恢复 / 页面重新可见 → 立即重试一次并重置退避（AC-2.9）
    const kick = () => conn.retryNow()
    addEventListener('online', kick)
    const onVisible = () => {
      if (document.visibilityState === 'visible') kick()
    }
    document.addEventListener('visibilitychange', onVisible)

    // Raw 模式的 IME：组字发生在 xterm 的隐藏 textarea 里。
    //
    // 【每个会话有自己的 xterm 实例，也就有自己的 helper textarea】，
    // 而 store.activate() 会把上一个会话的 host 从 DOM 摘掉。所以切会话
    // 必须重新挂 —— 否则 ime 绑在一个不再接事件的 textarea 上，
    // onTermData 里的 isComposing 恒为 false，组字期间的字节会直通 PTY
    // （违反 AC-3.3「组字期间一个字节都不能发」）。
    let ime: RawIme | null = null
    let imeEl: HTMLTextAreaElement | null = null
    const attachIme = () => {
      const helper = area.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
      if (!helper || helper === imeEl) return
      ime?.dispose()
      imeEl = helper
      ime = new RawIme(helper, {
        onCommit: (text) => sendRaw(text),
        onPreview: (text) => {
          const sid = store.active
          const term = sid === null ? undefined : store.termOf(sid)
          if (!text || !term) {
            setPreview(null)
            return
          }
          const el = area.querySelector<HTMLElement>('.xterm-screen')
          const cell = {
            width: (el?.clientWidth ?? 0) / Math.max(term.term.cols, 1),
            height: (el?.clientHeight ?? 0) / Math.max(term.term.rows, 1),
          }
          const buf = term.term.buffer.active
          setPreview({ text, ...cursorPosition(buf.cursorX, buf.cursorY, cell) })
        },
      })
    }


    ;(window as unknown as Record<string, unknown>).__webterm = {
      text: () => {
        const sid = store.active
        const term = sid === null ? undefined : store.termOf(sid)
        if (!term) return ''
        const buf = term.term.buffer.active
        const out: string[] = []
        for (let i = 0; i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) ?? '')
        return out.join('\n')
      },
      serialize: () => {
        const sid = store.active
        return sid === null ? '' : (store.termOf(sid)?.serialize.serialize() ?? '')
      },
      outSeq: () => (store.active === null ? 0 : conn.outSeqOf(store.active)),
      sid: () => store.active,
      size: () => {
        const sid = store.active
        const term = sid === null ? undefined : store.termOf(sid)
        return { cols: term?.term.cols ?? 0, rows: term?.term.rows ?? 0 }
      },
      welcome: () => lastWelcome,
      mode: () => (store.active === null ? { mode: 'composer' } : store.modesOf(store.active)!.current),
      unread: (sid: number) => store.isUnread(sid),
      program: () => (store.active === null ? null : programOfMaybe(runningCmd.get(store.active))),
      altScreen: () => (store.active === null ? false : store.altScreenOf(store.active)),
      interactive: () => (store.active === null ? false : store.interactiveOf(store.active)),
      sheet: () => sheetRef.current,
      zoom: () => pinch.scale(),
      viewport: () => {
        const sid = store.active
        const term = sid === null ? undefined : store.termOf(sid)
        if (!term) return { y: -1, top: '' }
        const buf = term.term.buffer.active
        return { y: buf.viewportY, top: buf.getLine(buf.viewportY)?.translateToString(true) ?? '' }
      },
    }

    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', applyViewport)
      removeEventListener('online', kick)
      document.removeEventListener('visibilitychange', onVisible)
      unwatchViewport()
      if (vpRaf) cancelAnimationFrame(vpRaf)
      sendResize.cancel()
      ro.disconnect()
      pinch.dispose()
      ime?.dispose()
      conn.close()
      store.dispose()
    }
    // 只在挂载时建一次连接
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectRef = useRef<(sid: number) => void>(() => {})
  const newSessionRef = useRef<() => void>(() => {})
  const closeRef = useRef<(sid: number) => void>(() => {})

  closeRef.current = (sid: number) => {
    const s = storeRef.current?.get(sid)
    // running 的会话需要二次确认 —— 里面可能有正在跑的程序
    if (s?.status === 'running' && !confirm(`关闭会话「${s.name}」？会话内可能有正在跑的程序。`)) {
      return
    }
    connRef.current?.send({ t: T.sessionClose, req_id: `close-${sid}`, sid })
  }

  const active = activeSid === null ? undefined : sessions.find((s) => s.sid === activeSid)
  const atLimit = sessions.length >= maxSessions
  const runText = (text: string) => {
    if (activeSid !== null) connRef.current?.sendInput(activeSid, encodeSubmission(text))
  }
  const activeTerm = () => (activeSid === null ? undefined : storeRef.current?.termOf(activeSid)?.term)
  /**
   * 长按发送 = 只粘贴不回车（ADR-0012）：整段交给 xterm.paste —— 它按前台程序的括号粘贴
   * 模式自动包裹（claude / codex 都开了 ?2004h，多行不会被换行提前提交）、把换行转成回车。
   * 不补回车 —— 留给 codex 的数字选项、y/n 这类想自己按回车的场合。
   */
  const sendToProgram = (text: string) => {
    const t = activeTerm()
    if (!text) return
    if (t) t.paste(text)
    else sendRawRef.current(text.replace(/\r?\n/g, '\r'))
  }
  /** Composer 提交：整段 + 回车送进终端 —— 提示符处即跑命令，程序里即提交一行。统一一条路。 */
  const submitText = (text: string) => {
    runText(text)
  }
  // 终端始终是唯一显示面（ADR-0013）：桌面经典底栏，手机是 Composer + 键条槽。
  const classic = bp === 'desktop'
  classicRef.current = classic
  const running = mode.mode === 'raw' // 有命令在跑
  const degraded = active?.integration === 'inactive' // 没有集成：不知道在跑什么，键条常给（含 ^C）
  const showKeys = running || interactive || degraded // 底栏要不要挂功能键条
  // 写态 chips：sheet 开着才拉数据（ADR-0011 ③）
  const chips = useChips({
    open: !classic && sheet !== 'closed' && mode.mode === 'composer',
    cwd: active?.cwd ?? '',
    pinned: quick,
    value: draft.value,
    cursor: draft.cursor,
    tick: 0,
  })
  const applyChip = (c: Chip) => {
    const h = composerRef.current
    if (!h) return
    if (c.kind === 'path') {
      // 只替换光标所在的 token —— 用点击那一刻的内容算，不用渲染时的快照
      const t = tokenAt(h.value(), h.cursor())
      h.replace(t.start, t.end, c.text)
    } else {
      h.fill(c.text)
    }
  }
  const editKey = (key: string) => {
    const h = composerRef.current
    if (!h) return
    switch (key) {
      case 'Tab': {
        // 有路径 chip 就补第一个 —— 这就是触屏上的 Tab 补全
        const first = chips.find((c) => c.kind === 'path')
        if (first) applyChip(first)
        else h.insert('  ')
        break
      }
      case 'ArrowUp':
        h.history('older')
        break
      case 'ArrowDown':
        h.history('newer')
        break
      case 'ArrowLeft':
        h.move('left')
        break
      case 'ArrowRight':
        h.move('right')
        break
      case 'Home':
        h.move('home')
        break
      case 'End':
        h.move('end')
        break
      case 'DeleteWord':
        h.deleteWord()
        break
      default: {
        const lit = EDIT_INSERT[key]
        if (lit !== undefined) h.insert(lit)
      }
    }
  }
  const sheetInset = 0 // 终端不被推：sheet 盖在它上面（ADR-0013）
  return (
    <div class="app" data-bp={bp} data-short={short} data-sidebar={sidebarOpen ? 'open' : 'closed'}>
      {bp !== 'desktop' && sidebarOpen && (
        <div class="scrim" data-testid="scrim" onClick={() => setSidebarOpen(false)} />
      )}
      <aside class="sidebar" data-testid="sidebar" ref={sidebarRef}>
        <SessionList
          sessions={sessions}
          active={activeSid}
          unread={(sid) => storeRef.current?.isUnread(sid) ?? false}
          onSelect={(sid) => {
            selectRef.current(sid)
            if (bp !== 'desktop') setSidebarOpen(false)
          }}
          onClose={(sid) => closeRef.current(sid)}
          onRename={(sid, current) => {
            const name = prompt('会话名（留空 = 跟随目录）', current)
            if (name === null) return
            const trimmed = name.trim()
            connRef.current?.send({ t: T.sessionRename, req_id: `rename-${sid}-${Date.now()}`, sid, name: trimmed === '' ? null : trimmed })
          }}
          onTogglePinned={(sid) => storeRef.current?.togglePinnedSubscription(sid)}
          onNew={() => {
            newSessionRef.current()
            if (bp !== 'desktop') setSidebarOpen(false)
          }}
          atLimit={atLimit}
          maxSessions={maxSessions}
        />
      </aside>

      <div class="main" data-occupied={altScreen ? 'true' : 'false'} style={{ '--sheet-inset': `${sheetInset}px` }}>
        <StatusBar
          state={connState}
          info={info}
          sessionName={active?.name ?? 'webterm'}
          cwd={active?.cwd ?? ''}
          onOpenSessions={() => setSidebarOpen((v) => !v)}
        />
        {fatal && (
          <div class="banner error" data-testid="fatal">
            {fatal}
          </div>
        )}
        {active?.integration === 'inactive' && (
          <div class="banner warn" data-testid="degraded">
            shell 集成未生效 · 命令历史、CWD 与自动切换不可用
          </div>
        )}
        {active?.unmarked_input && active.integration !== 'inactive' && !interactive && (
          // 占屏程序（claude / codex / vim / top）里按 Enter 当然没有标记 —— 那是用户在用它，
          // 不是 shell 坏了；这条横幅只给 ssh / su / 容器 / 没钩子的子 shell 看。
          // 输入去了一个没有集成的地方：ssh / su / 容器 / exec bash / 摘了钩子 ——
          // 这些在字节流里【完全同形】，所以措辞不能承诺"退出后恢复"（exec bash
          // 没有可退出的东西），只说事实和恢复的条件。
          <div class="banner warn" data-testid="unmarked">
            当前 shell 里没有 webterm 集成（ssh / su / 容器 / exec bash 都会这样）· 命令块暂停切分，回到有集成的 shell 后自动恢复
          </div>
        )}
        {truncated && (
          <div class="banner warn" data-testid="truncated">
            ── 历史输出已截断 ──
            <button onClick={() => setTruncated(false)}>知道了</button>
          </div>
        )}
        {active?.status === 'exited' && (
          <ExitedBar
            session={active}
            onReopen={() => {
              connRef.current?.send({
                t: T.sessionCreate,
                req_id: `reopen-${Date.now()}`,
                name: null,
                cwd: active.cwd || null,
                cols: 80,
                rows: 24,
              })
            }}
            onClose={() => closeRef.current(active.sid)}
          />
        )}

        {/* 终端是唯一的显示面（ADR-0013）。铺满 .canvas；底部的 Composer / 键条槽
            绝对定位盖在它上面，不改 xterm 尺寸（切不触发 PTY resize / SIGWINCH）。 */}
        <div class="canvas" data-testid="canvas">
          <div class="term" ref={termAreaRef} data-testid="terminal" data-hidden="false" />
        </div>

        {classic && (
        <div class="modebar" data-testid="modebar" data-mode={mode.mode}>
          <button data-testid="open-palette" onClick={() => setPaletteOpen(true)}>
            命令面板
          </button>
          <button data-testid="open-history" onClick={() => setHistoryOpen(true)}>
            历史
          </button>
          <button data-testid="open-settings" onClick={() => setSettingsOpen((v) => !v)}>
            设置
          </button>
        </div>
        )}

        {settingsOpen && (
          <div class="banner" data-testid="settings">
            <label>
              主题
              <select
                data-testid="theme-select"
                value={theme}
                onChange={(e) => setTheme(e.currentTarget.value as Theme)}
              >
                <option value="system">跟随系统</option>
                <option value="light">浅色</option>
                <option value="dark">深色</option>
              </select>
            </label>
            <label>
              字号
              <input
                data-testid="font-size"
                type="number"
                min={8}
                max={32}
                value={fontSize}
                onInput={(e) => {
                  const n = Number(e.currentTarget.value)
                  if (!Number.isFinite(n) || n < 8 || n > 32) return
                  setFontSize(n)
                  writeFontSize(n)
                  storeRef.current?.setFontSize(n)
                }}
              />
            </label>
            {/* 用户不知道这条规则的话，它等于不存在（privacy-history.md） */}
            <p class="privacy-note" data-testid="privacy-note">
              以空格开头的命令不会被记录。贴 token / 密码时在前面加个空格。
            </p>
          </div>
        )}

        {!classic && active?.status !== 'exited' && altScreen && coarse && (
          // 全屏 TUI（vim / top / less）：底部只有键条；打字点终端直送（ADR-0013+）
          <div class="bottom-slot" data-testid="tui-bar">
            <div class="bottom">
              <KeyBar
                mode="raw"
                context={{ altScreen: true, program }}
                onRaw={(bytes) => sendRawRef.current(bytes)}
                onComposerKey={() => {}}
                leading={
                  <button class="keybar-key keybar-lead" data-testid="open-more" aria-label="更多" aria-expanded={moreOpen} onClick={() => setMoreOpen((v) => !v)}>
                    ⋯
                  </button>
                }
              />
            </div>
          </div>
        )}
        {!classic && active?.status !== 'exited' && !(altScreen && coarse) && (
          // 有输入框：编辑后发送。命令在跑时下面挂功能键条（Esc ^C 方向键 / AI 键）。
          <WriteSheet
            size={sheet}
            onSize={changeSheet}
            onHeight={setBottomH}
            chips={chips}
            onChip={applyChip}
            editKeys={coarse}
            onEditKey={editKey}
            onSend={() => composerRef.current?.submit()}
            onSendHold={() => {
              // 长按发送 = 只粘贴不回车：给 codex 的数字选项、y/n 这类想自己按回车的场合
              sendToProgram(composerRef.current?.take() ?? '')
              changeSheet('closed')
            }}
            bar={
              <button
                class="bar-btn bar-more"
                data-testid="open-more"
                aria-label="更多"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen((v) => !v)}
              >
                ⋯
              </button>
            }
            below={
              showKeys && coarse ? (
                <KeyBar
                  mode="raw"
                  context={{ altScreen: interactive, program }}
                  onRaw={(bytes) => sendRawRef.current(bytes)}
                  onComposerKey={() => {}}
                />
              ) : null
            }
          >
            <Composer
              hidden={false}
              placeholder={program ? `输入给 ${program}…` : '输入命令…'}
              onSubmit={(text) => {
                submitText(text)
                changeSheet('closed')
              }}
              onRaw={(bytes) => sendRawRef.current(bytes)}
              onHandle={(h) => {
                composerRef.current = h
              }}
              onChange={(value, cursor) => setDraft({ value, cursor })}
              onFocus={openSheet}
              onEscapeEmpty={() => changeSheet('closed')}
            />
          </WriteSheet>
        )}
        {!classic && moreOpen && (
          // 读视图里模式条那些次要入口收进 ⋯ 菜单 —— 底栏只留输入、「终端」、⋯ 三样
          <>
            <div class="more-backdrop" data-testid="more-backdrop" onClick={() => setMoreOpen(false)} />
            <div class="action-sheet" data-testid="more-menu" role="menu">
              <div class="sheet-grabber" />
              <button role="menuitem" data-testid="open-sessions" onClick={() => { setMoreOpen(false); setSidebarOpen(true) }}>
                <span class="sheet-ico">⧉</span><span class="sheet-label">会话</span><span class="sheet-chevron">›</span>
              </button>
              <button role="menuitem" data-testid="open-history" onClick={() => { setMoreOpen(false); setHistoryOpen(true) }}>
                <span class="sheet-ico">↺</span><span class="sheet-label">历史</span><span class="sheet-chevron">›</span>
              </button>
              <button role="menuitem" data-testid="open-palette" onClick={() => { setMoreOpen(false); setPaletteOpen(true) }}>
                <span class="sheet-ico">⌘</span><span class="sheet-label">命令面板</span><span class="sheet-chevron">›</span>
              </button>
              <button role="menuitem" data-testid="open-settings" onClick={() => { setMoreOpen(false); setSettingsOpen((v) => !v) }}>
                <span class="sheet-ico">⚙</span><span class="sheet-label">设置</span><span class="sheet-chevron">›</span>
              </button>
            </div>
          </>
        )}
        {classic && active?.status !== 'exited' && (
          <Composer
            hidden={false}
            onSubmit={submitText}
            onRaw={(bytes) => sendRawRef.current(bytes)}
            onHandle={(h) => {
              composerRef.current = h
            }}
          />
        )}
        {/* 快捷命令条：Composer 上方，横滑；为空时整条不渲染。
            short 布局（手机横屏）下挤不下，从面板访问。读视图里它以 chips 的形式在 sheet 里 */}
        {classic && !short && active?.status !== 'exited' && (
          <QuickBar items={quick} onFill={(text) => composerRef.current?.fill(text)} onRun={runText} />
        )}
        {classic && coarse && (
          <KeyBar
            mode={mode.mode}
            context={{ altScreen: interactive, program }}
            onRaw={(bytes) => sendRawRef.current(bytes)}
            onComposerKey={(key) => {
              if (key === 'Escape') composerRef.current?.focus()
            }}
          />
        )}
      </div>

      {preview && (
        <div
          class="ime-preview"
          data-testid="ime-preview"
          style={{ left: `${preview.left}px`, top: `${preview.top}px` }}
        >
          {preview.text}
        </div>
      )}
      {paletteOpen && (
        <CommandPalette
          sessions={sessions.map((s) => ({ sid: s.sid, name: s.name, cwd: s.cwd }))}
          actions={[
            { id: 'new', label: '新建会话', run: () => newSessionRef.current() },
            { id: 'history', label: '打开历史面板', run: () => setHistoryOpen(true) },
            { id: 'settings', label: '设置', run: () => setSettingsOpen(true) },
            {
              id: 'theme',
              label: '切换主题',
              run: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
            },
          ]}
          onClose={() => setPaletteOpen(false)}
          onFill={(text) => composerRef.current?.fill(text)}
          onRun={runText}
          onSelectSession={(sid) => selectRef.current(sid)}
        />
      )}
      {historyOpen && (
        <HistoryPanel
          cwd={active?.cwd ?? ''}
          onClose={() => setHistoryOpen(false)}
          onFill={(text) => {
            composerRef.current?.fill(text)
            setHistoryOpen(false)
          }}
          onRun={(text) => {
            if (activeSid !== null) connRef.current?.sendInput(activeSid, encodeSubmission(text))
            setHistoryOpen(false)
          }}
          onPinnedChanged={reloadQuick}
        />
      )}
      {recovered !== null && <RecoveredToast bytes={recovered} />}
    </div>
  )
}

/**
 * 提交格式（AC-3.2）：
 *   含换行 → bracketed paste 包裹 + CR
 *   单行   → 内容 + CR
 *   空     → CR
 */
/** 命令原文 → 前台程序名；空 / undefined → null。 */
function programOfMaybe(cmd: string | undefined): string | null {
  return cmd ? programOf(cmd) : null
}

export function encodeSubmission(text: string): Uint8Array {
  const enc = new TextEncoder()
  if (text.trim() === '') return enc.encode('\r')
  if (!text.includes('\n')) return enc.encode(text + '\r')
  return enc.encode(`\x1b[200~${text}\x1b[201~\r`)
}
