/**
 * m3 的前端骨架：连接层 + 终端 + 状态指示 + 一个最小输入框。
 *
 * 输入框在 m4 会长成真正的 Composer（IME、历史、模式自动切换）。这里先按
 * AC-3.2 的提交格式实现，m4 是在它上面加东西而不是推翻重来。
 */
import { useEffect, useRef, useState } from 'preact/hooks'

import { Connection, type ConnState, type StateInfo } from '../conn/connection'
import { Composer, type ComposerHandle } from '../input/composer'
import { KeyBar } from '../input/keybar'
import { appAction } from '../input/keymap'
import { ModeMachine, type ModeState } from '../input/modes'
import { RawIme, cursorPosition } from '../input/raw'
import { T, type SessionInfo } from '../protocol/messages'
import { createTerminal, type TermHandle } from '../term/terminal'
import { RecoveredToast, StatusBar } from './status'
import { debounce, isCoarsePointer, readViewport, watchViewport } from './viewport'

/** client_id 每个标签页一个，存 sessionStorage —— localStorage 是同源共享的，区分不了标签页。 */
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
  const hostRef = useRef<HTMLDivElement>(null)
  const connRef = useRef<Connection | null>(null)
  const termRef = useRef<TermHandle | null>(null)
  const sidRef = useRef<number | null>(null)

  const [state, setState] = useState<ConnState>('connecting')
  const [info, setInfo] = useState<StateInfo>({})
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [recovered, setRecovered] = useState<number | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [fatal, setFatal] = useState<string | null>(null)
  const [mode, setMode] = useState<ModeState>({ mode: 'composer', locked: false })
  const [degraded, setDegraded] = useState(false)
  const [preview, setPreview] = useState<{ text: string; left: number; top: number } | null>(null)
  const [coarse] = useState(isCoarsePointer)
  const modeRef = useRef<ModeMachine | null>(null)
  const composerRef = useRef<ComposerHandle | null>(null)
  const sendRawRef = useRef<(bytes: string) => void>(() => {})

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    // 最近一次 welcome，E2E 用它直接断言续传结果（reset / ok / gone）
    let lastWelcome: unknown = null

    const modes = new ModeMachine({ onChange: setMode })
    modeRef.current = modes

    // 集成状态有三个来路：welcome.sessions[]、session.created、session.updated。
    // 漏掉任何一条，降级提示就会在某条路径上不出现。
    const applyIntegration = (v: SessionInfo['integration']) => {
      modes.onIntegration(v)
      setDegraded(v === 'inactive')
    }

    const handle = createTerminal(14)
    termRef.current = handle
    handle.term.open(host)
    handle.attachWebgl()
    handle.fit.fit()

    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
    const conn = new Connection({
      url,
      clientID: clientID(),
      handlers: {
        onOutput(_sid, data, _attrPrefix) {
          // 清屏在收到 welcome.resumed[].status === "reset" 时就做了（见下），
          // 这里只管把字节写进去。attrPrefix 那 4 个字节是渲染修正，本来就
          // 该原样写入。
          handle.term.write(data)
        },
        onMessage(msg) {
          if (msg.t === T.welcome) {
            lastWelcome = msg
            // 缓冲被覆盖 → 先清屏再接后续帧，并明确告诉用户历史被截断了，
            // 而不是让他拿着一屏东西猜发生了什么（AC-2.6）
            if (msg.resumed.some((r) => r.status === 'reset')) {
              handle.term.reset()
              setTruncated(true)
            }
            const first = msg.sessions[0]
            if (first) {
              sidRef.current = first.sid
              setSession(first)
              applyIntegration(first.integration)
              conn.subscribe(first.sid)
            } else {
              conn.send({
                t: T.sessionCreate,
                req_id: 'boot',
                name: null,
                cwd: null,
                cols: handle.term.cols,
                rows: handle.term.rows,
              })
            }
          } else if (msg.t === T.sessionCreated) {
            sidRef.current = msg.session.sid
            setSession(msg.session)
            applyIntegration(msg.session.integration)
            conn.subscribe(msg.session.sid)
          } else if (msg.t === T.sessionUpdated && msg.sid === sidRef.current) {
            setSession((s) => (s ? { ...s, ...msg } : s))
            if (msg.integration !== undefined) applyIntegration(msg.integration)
          } else if (msg.t === T.prompt && msg.sid === sidRef.current) {
            // 这条消息驱动输入模式自动切换（ADR-0007）
            modes.onPrompt(msg.state)
          }
        },
        onState(s, i) {
          setState(s)
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
    conn.connect()

    // 网络恢复 / 页面重新可见 → 立即重试一次并重置退避（AC-2.9）
    const kick = () => conn.retryNow()
    addEventListener('online', kick)
    const onVisible = () => {
      if (document.visibilityState === 'visible') kick()
    }
    document.addEventListener('visibilitychange', onVisible)

    const sendRaw = (bytes: string) => {
      const sid = sidRef.current
      if (sid === null || bytes === '') return
      conn.sendInput(sid, new TextEncoder().encode(bytes))
    }
    sendRawRef.current = sendRaw

    // Raw 模式：按键直通 PTY。xterm 的 onData 已经把控制键映射好了。
    const dataSub = handle.term.onData((data) => {
      if (modes.current.mode !== 'raw') return
      // 组字期间【一个字节都不能发】—— 只在 compositionend 时一次性提交
      if (ime?.isComposing) return
      sendRaw(data)
    })

    // 应用级快捷键要拦下来，不能让它们进 PTY
    handle.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      const act = appAction(e)
      if (act === null) return true
      if (act === 'toggleMode') modes.toggleManual()
      return false
    })

    // Raw 模式的 IME：组字发生在 xterm 的隐藏 textarea 里，
    // 组字内容用内联浮层显示在光标位置，让用户知道自己在打什么。
    const helper = host.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
    const ime = helper
      ? new RawIme(helper, {
          onCommit: (text) => sendRaw(text),
          onPreview: (text) => {
            if (!text) {
              setPreview(null)
              return
            }
            const buf = handle.term.buffer.active
            const el = host.querySelector<HTMLElement>('.xterm-screen')
            const cell = {
              width: (el?.clientWidth ?? 0) / Math.max(handle.term.cols, 1),
              height: (el?.clientHeight ?? 0) / Math.max(handle.term.rows, 1),
            }
            const pos = cursorPosition(buf.cursorX, buf.cursorY, cell)
            setPreview({ text, ...pos })
          },
        })
      : null

    // AC-2.1（字节级连续性）是这个项目最重要的一个测试，它必须能拿到
    // xterm 缓冲的序列化结果。这里把把手挂到 window 上。
    //
    // 不做安全兜底是刻意的：它只暴露【屏幕上已经有的东西】，而页面同源、
    // CSP 又禁止外部脚本，所以没有多出来的攻击面。
    ;(window as unknown as Record<string, unknown>).__webterm = {
      text: () => {
        const buf = handle.term.buffer.active
        const out: string[] = []
        for (let i = 0; i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) ?? '')
        return out.join('\n')
      },
      serialize: () => handle.serialize.serialize(),
      outSeq: () => (sidRef.current === null ? 0 : conn.outSeqOf(sidRef.current)),
      sid: () => sidRef.current,
      size: () => ({ cols: handle.term.cols, rows: handle.term.rows }),
      welcome: () => lastWelcome,
      mode: () => modes.current,
    }

    // resize 控制消息做 100ms 防抖（AC-3.11）
    const sendResize = debounce(() => {
      const sid = sidRef.current
      if (sid !== null) {
        conn.send({ t: T.resize, sid, cols: handle.term.cols, rows: handle.term.rows })
      }
    }, 100)

    const ro = new ResizeObserver(() => {
      handle.fit.fit()
      sendResize()
    })
    ro.observe(host)

    // 软键盘：高度的唯一真相来源是 visualViewport（iOS 上 100vh 不随键盘变化）。
    // 【不在这个回调里直接 fit()】—— 布局还没稳定，交给上面的 ResizeObserver。
    const applyViewport = () => {
      const vp = readViewport()
      const root = host.closest('.app') as HTMLElement | null
      if (!root) return
      root.style.height = `${vp.height}px`
      // iOS 键盘弹出时会把整个页面向上推，用 transform 抵消
      root.style.transform = vp.offsetTop ? `translateY(${vp.offsetTop}px)` : ''
    }
    applyViewport()
    const unwatchViewport = watchViewport(applyViewport)

    return () => {
      removeEventListener('online', kick)
      document.removeEventListener('visibilitychange', onVisible)
      ro.disconnect()
      unwatchViewport()
      sendResize.cancel()
      dataSub.dispose()
      ime?.dispose()
      modes.dispose()
      conn.close()
      handle.dispose()
    }
  }, [])

  return (
    <div class="app">
      <StatusBar
        state={state}
        info={info}
        sessionName={session?.name ?? 'webterm'}
        cwd={session?.cwd ?? ''}
      />
      {fatal && (
        <div class="banner error" data-testid="fatal">
          {fatal}
        </div>
      )}
      {degraded && (
        <div class="banner warn" data-testid="degraded">
          shell 集成未生效 · 命令历史、CWD 与自动切换不可用
          <button
            onClick={() =>
              alert(
                'agent 没有收到 shell 集成的握手。常见原因：\n' +
                  '· 会话里执行过 exec / su / 进了容器\n' +
                  '· agent 以 --no-shell-integration 启动\n\n' +
                  '在新 shell 里手动接入：eval "$(webterm shell-init bash)"',
              )
            }
          >
            了解原因
          </button>
        </div>
      )}
      {truncated && (
        <div class="banner warn" data-testid="truncated">
          ── 历史输出已截断 ──
          <button onClick={() => setTruncated(false)}>知道了</button>
        </div>
      )}
      <div class="term" ref={hostRef} data-testid="terminal" />
      <div class="modebar" data-testid="modebar" data-mode={mode.mode} data-locked={mode.locked}>
        <span>{mode.mode === 'composer' ? 'Composer' : 'Raw（按键直通）'}</span>
        <button
          data-testid="mode-toggle"
          onClick={() => {
            modeRef.current?.toggleManual()
            if (modeRef.current?.current.mode === 'raw') hostRef.current?.querySelector('textarea')?.focus()
          }}
        >
          {mode.locked ? '已锁定 · 切换' : '切换'}
        </button>
        {mode.locked && (
          <button data-testid="mode-unlock" onClick={() => modeRef.current?.unlock()}>
            解锁自动
          </button>
        )}
      </div>
      <Composer
        hidden={mode.mode === 'raw'}
        onSubmit={(text) => {
          const sid = sidRef.current
          if (sid !== null) connRef.current?.sendInput(sid, encodeSubmission(text))
        }}
        onRaw={(bytes) => sendRawRef.current(bytes)}
        onHandle={(h) => {
          composerRef.current = h
        }}
      />
      {coarse && (
        <KeyBar
          mode={mode.mode}
          onRaw={(bytes) => sendRawRef.current(bytes)}
          onComposerKey={(key) => {
            // Composer 模式下这些键是语义动作，不是直通字节
            if (key === 'Escape') composerRef.current?.focus()
          }}
        />
      )}
      {preview && (
        <div
          class="ime-preview"
          data-testid="ime-preview"
          style={{ left: `${preview.left}px`, top: `${preview.top}px` }}
        >
          {preview.text}
        </div>
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
 *
 * 单行【不包】bracketed paste：ESC[200~ 只有在对端开着它时才会被吞掉，
 * 集成失效时对端可能是 cat / python REPL / bash < 4.4，那两串会变成字面量。
 */
export function encodeSubmission(text: string): Uint8Array {
  const enc = new TextEncoder()
  if (text.trim() === '') return enc.encode('\r')
  if (!text.includes('\n')) return enc.encode(text + '\r')
  return enc.encode(`\x1b[200~${text}\x1b[201~\r`)
}
