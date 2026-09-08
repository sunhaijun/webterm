/**
 * webterm 主界面：多会话 + 三档响应式布局。
 *
 * 见 docs/40-frontend/session-ux.md 与 layout-responsive.md。
 */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import { listCommands, type CommandRecord } from '../commands/api'
import { BlockStore } from '../commands/blocks'
import { BlocksPanel } from '../commands/blockspanel'
import { HistoryPanel, QuickBar } from '../commands/history'
import { CommandPalette } from '../commands/palette'
import { Connection, type ConnState, type StateInfo } from '../conn/connection'
import { Composer, type ComposerHandle } from '../input/composer'
import { KeyBar } from '../input/keybar'
import { appAction } from '../input/keymap'
import type { ModeState } from '../input/modes'
import { RawIme, cursorPosition } from '../input/raw'
import { T } from '../protocol/messages'
import { SessionStore, type SessionView } from '../sessions/store'
import { ExitedBar, SessionList } from './sessionlist'
import { applyTheme, readFontSize, readTheme, writeFontSize, type Theme } from './settings'
import { RecoveredToast, StatusBar } from './status'
import {
  breakpoint,
  debounce,
  isCoarsePointer,
  isShort,
  readViewport,
  watchViewport,
  type Breakpoint,
} from './viewport'

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
  const connRef = useRef<Connection | null>(null)
  const storeRef = useRef<SessionStore | null>(null)
  const composerRef = useRef<ComposerHandle | null>(null)
  const sendRawRef = useRef<(bytes: string) => void>(() => {})

  const [connState, setConnState] = useState<ConnState>('connecting')
  const [info, setInfo] = useState<StateInfo>({})
  const [sessions, setSessions] = useState<SessionView[]>([])
  const [activeSid, setActiveSid] = useState<number | null>(null)
  const [mode, setMode] = useState<ModeState>({ mode: 'composer', locked: false })
  const [maxSessions, setMaxSessions] = useState(20)
  const [recovered, setRecovered] = useState<number | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [fatal, setFatal] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ text: string; left: number; top: number } | null>(null)
  const [bp, setBp] = useState<Breakpoint>(() => breakpoint(window.innerWidth))
  const [short, setShort] = useState(() => isShort(window.innerHeight))
  const [sidebarOpen, setSidebarOpen] = useState(() => breakpoint(window.innerWidth) === 'desktop')
  const [coarse] = useState(isCoarsePointer)
  const [theme, setTheme] = useState<Theme>(readTheme)
  const [fontSize, setFontSize] = useState(readFontSize)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [blocksOpen, setBlocksOpen] = useState(false)
  // 块存储活在 ref 里（它不参与渲染），用一个计数器把它的变化推给 UI。
  const blocksRef = useRef<BlockStore>()
  const [blocksTick, setBlocksTick] = useState(0)
  const [quick, setQuick] = useState<CommandRecord[]>([])

  const reloadQuick = useCallback(() => {
    listCommands({ pinned: true, limit: 50 })
      .then((r) => setQuick(r.items))
      .catch(() => setQuick([]))
  }, [])
  useEffect(reloadQuick, [reloadQuick])

  useEffect(() => applyTheme(theme), [theme])

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
    const blocks = new BlockStore()
    blocksRef.current = blocks
    // 命令事件是低频的（一条命令一两次），直接 bump 不会有性能问题。
    const bumpBlocks = () => setBlocksTick((n) => n + 1)

    const conn = new Connection({
      url,
      clientID: clientID(),
      handlers: {
        onOutput(sid, data, attrPrefix, startSeq) {
          store.write(sid, data)
          blocks.write(sid, data, attrPrefix, startSeq)
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
            case T.sessionClosed:
              store.remove(msg.sid)
              blocks.forget(msg.sid) // 别攒着已关会话的输出
              break
            case T.sessionUpdated: {
              const { t: _t, sid, ...patch } = msg
              store.patch(sid, patch)
              break
            }
            case T.commandStart:
              blocks.cmdStart(msg.sid, msg)
              bumpBlocks()
              break
            case T.commandEnd:
              blocks.cmdEnd(msg.sid, msg)
              bumpBlocks()
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
      onTermData: (sid, data) => {
        if (store.active !== sid) return
        if (store.modesOf(sid)?.current.mode !== 'raw') return
        // 组字期间【一个字节都不能发】—— 只在 compositionend 时一次性提交
        if (ime?.isComposing) return
        sendRaw(data)
      },
      allowKey: (e) => appAction(e) === null,
    })
    storeRef.current = store

    const select = (sid: number) => {
      store.activate(sid, area)
      // activate 里的 term.open() 是同步的，此刻 textarea 已经在 DOM 里
      attachIme()
      setTruncated(false)
      sendResize()
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
        case 'toggleMode':
          if (sid !== null) store.modesOf(sid)?.toggleManual()
          break
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

    const ro = new ResizeObserver(() => {
      const sid = store.active
      store.termOf(sid ?? -1)?.fit.fit()
      sendResize()
    })
    ro.observe(area)

    // 软键盘：高度的唯一真相来源是 visualViewport（iOS 上 100vh 不随键盘变化）。
    // 【不在这个回调里直接 fit()】—— 布局还没稳定，交给上面的 ResizeObserver。
    const applyViewport = () => {
      const vp = readViewport()
      const root = area.closest('.app') as HTMLElement | null
      if (root) {
        root.style.height = `${vp.height}px`
        root.style.transform = vp.offsetTop ? `translateY(${vp.offsetTop}px)` : ''
      }
      setBp(breakpoint(window.innerWidth))
      setShort(isShort(vp.height))
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
      mode: () => (store.active === null ? { mode: 'composer', locked: false } : store.modesOf(store.active)!.current),
      unread: (sid: number) => store.isUnread(sid),
    }

    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', applyViewport)
      removeEventListener('online', kick)
      document.removeEventListener('visibilitychange', onVisible)
      unwatchViewport()
      sendResize.cancel()
      ro.disconnect()
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

  return (
    <div class="app" data-bp={bp} data-short={short} data-sidebar={sidebarOpen ? 'open' : 'closed'}>
      {bp !== 'desktop' && sidebarOpen && (
        <div class="scrim" data-testid="scrim" onClick={() => setSidebarOpen(false)} />
      )}
      <aside class="sidebar" data-testid="sidebar">
        <SessionList
          sessions={sessions}
          active={activeSid}
          unread={(sid) => storeRef.current?.isUnread(sid) ?? false}
          onSelect={(sid) => {
            selectRef.current(sid)
            if (bp !== 'desktop') setSidebarOpen(false)
          }}
          onClose={(sid) => closeRef.current(sid)}
          onTogglePinned={(sid) => storeRef.current?.togglePinnedSubscription(sid)}
          onNew={() => newSessionRef.current()}
          atLimit={atLimit}
          maxSessions={maxSessions}
        />
      </aside>

      <div class="main">
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

        <div class="term" ref={termAreaRef} data-testid="terminal" />

        <div class="modebar" data-testid="modebar" data-mode={mode.mode} data-locked={mode.locked}>
          <span>{mode.mode === 'composer' ? 'Composer' : 'Raw（按键直通）'}</span>
          <button
            data-testid="mode-toggle"
            onClick={() => activeSid !== null && storeRef.current?.modesOf(activeSid)?.toggleManual()}
          >
            {mode.locked ? '已锁定 · 切换' : '切换'}
          </button>
          {mode.locked && (
            <button
              data-testid="mode-unlock"
              onClick={() => activeSid !== null && storeRef.current?.modesOf(activeSid)?.unlock()}
            >
              解锁自动
            </button>
          )}
          <button data-testid="open-blocks" onClick={() => setBlocksOpen(true)}>
            块
          </button>
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

        {active?.status !== 'exited' && (
          <Composer
            hidden={mode.mode === 'raw'}
            onSubmit={(text) => {
              if (activeSid !== null) connRef.current?.sendInput(activeSid, encodeSubmission(text))
            }}
            onRaw={(bytes) => sendRawRef.current(bytes)}
            onHandle={(h) => {
              composerRef.current = h
            }}
          />
        )}
        {/* 快捷命令条：Composer 上方，横滑；为空时整条不渲染。
            short 布局（手机横屏）下挤不下，从面板访问 */}
        {!short && active?.status !== 'exited' && (
          <QuickBar
            items={quick}
            onFill={(text) => composerRef.current?.fill(text)}
            onRun={(text) => {
              if (activeSid !== null) connRef.current?.sendInput(activeSid, encodeSubmission(text))
            }}
          />
        )}
        {coarse && (
          <KeyBar
            mode={mode.mode}
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
          onRun={(text) => {
            if (activeSid !== null) connRef.current?.sendInput(activeSid, encodeSubmission(text))
          }}
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
      {blocksOpen && activeSid !== null && (
        <BlocksPanel
          /* blocksTick 只是为了让块变化能触发重渲染 —— 存储本身在 ref 里 */
          key={`blocks-${activeSid}-${blocksTick}`}
          blocks={blocksRef.current?.blocks(activeSid) ?? []}
          bytesOf={(b) => blocksRef.current?.bytesOf(activeSid, b) ?? null}
          cols={active?.cols ?? 80}
          onClose={() => setBlocksOpen(false)}
          onFill={(text) => {
            composerRef.current?.fill(text)
            setBlocksOpen(false)
          }}
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
export function encodeSubmission(text: string): Uint8Array {
  const enc = new TextEncoder()
  if (text.trim() === '') return enc.encode('\r')
  if (!text.includes('\n')) return enc.encode(text + '\r')
  return enc.encode(`\x1b[200~${text}\x1b[201~\r`)
}
