/**
 * xterm 封装 + 浏览器的输出路径（ADR-0026 §7，layout.md §渲染）。
 *
 * 浏览器只做三件事：
 *
 *   每个会话: 一个 TextDecoder('utf-8')，stream 模式
 *   OUTPUT 帧   → term.write(decoder.decode(payload, {stream: true}))
 *   SNAPSHOT 帧 → reset; decoder = new TextDecoder(); term.write(decode(快照))
 *
 * 【先解码成字符串再写】。xterm.js 5.5 的 `write(Uint8Array)` 在一个三字节字符被切进
 * 两次写入、且第 2 字节是 0x80、切在第 2 字节之后时会丢掉整个字符（`。` `…` `—`）。
 *
 * 渲染器用 xterm 默认的 DOM 渲染器；触屏滚动用 xterm 自带的（程序开了鼠标跟踪时
 * 纵向拖转成滚轮，标定步长在这里做，ADR-0029）。不做回看暂停、
 * 按帧合并、写入预算 —— 都等量过 E2E-37 的基线再说。
 */
import { Terminal, type IDisposable, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'

import { detectShift } from './gestures'

/** 终端字号：固定，不提供设置（AC-5.3，ADR-0030）。 */
export const FONT_SIZE = 14

/**
 * 终端字体：系统等宽栈，和 CSS 里的 `--font-mono` 是同一串。尾巴是 CJK 等宽回退 ——
 * 编程字体基本不带汉字，少了它汉字会掉进比例字体，中英混排的列宽当场歪掉。
 */
export const FONT_FAMILY =
  'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", "Noto Sans Mono CJK SC", "Sarasa Mono SC", monospace'

/** scrollback 至少 5000 行（AC-5.1）。 */
export const SCROLLBACK = 5000

/**
 * 硬复位（RIS）。收到快照时用它【在流内】清空终端，而不是直接调 `term.reset()`：
 * 后者是同步的，不清 xterm 的写缓冲 —— 列数一变 agent 就重发快照，那一刻写缓冲里
 * 可能还排着没解析完的旧输出，它们会被解析到 reset 之后、快照之前，画面就错了。
 * RIS 走的是同一条写入队列，顺序天然正确，效果与 `term.reset()` 相同。
 */
export const RIS = '\x1bc'

/** 标定最多等多久（ADR-0029）：程序这么久没重画出可认的位移，就沿用旧步长。 */
export const CALIBRATE_MS = 300

export interface TermHandle {
  term: Terminal
  fit: FitAddon
  serialize: SerializeAddon
  /** 写一段 OUTPUT。replay=true：补课，写入期间 xterm 的自动应答要被回放门拦下。 */
  output(bytes: Uint8Array, replay: boolean): void
  /** 写一份快照：复位 → 换新解码器 → 当作回放写入。 */
  snapshot(bytes: Uint8Array): void
  /**
   * 本地写一行（进程结束提示行）。排在已经写进去的输出之后；若这之前又来了快照
   * （快照会清屏），这一次作废 —— 调用方会在快照之后再写一次。
   */
  local(line: string): void
  /** 回放门：有回放的字节还没被 xterm 解析完。 */
  replaying(): boolean
  /** 备用屏幕缓冲是否激活。 */
  altScreen(): boolean
  /** 前台程序开了鼠标跟踪。 */
  mouseTracking(): boolean
  /** 一行的高度（px）。 */
  rowHeight(): number
  /** 前台程序一次滚轮滚几行（ADR-0029 标定出来的；没量过按 3）。 */
  wheelStep(): number
  /** 正在等标定结果。 */
  calibrating(): boolean
  /** 最近一次标定认出了位移。 */
  calibrated(): boolean
  /** 在视口坐标 (x, y) 处发一次滚轮（ADR-0029）；up = 向上滚；calibrate = 顺便量程序滚了几行。 */
  wheel(up: boolean, x: number, y: number, calibrate: boolean): void
  dispose(): void
}

export function createTerminal(theme?: ITheme): TermHandle {
  const term = new Terminal({
    fontSize: FONT_SIZE,
    fontFamily: FONT_FAMILY,
    scrollback: SCROLLBACK,
    allowProposedApi: true,
    convertEol: false,
    cursorBlink: true,
    theme,
  })

  const fit = new FitAddon()
  const serialize = new SerializeAddon()
  term.loadAddon(fit)
  term.loadAddon(serialize)

  // 正确计算 CJK 与 emoji 的宽度，否则中英混排会错位
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'

  let decoder = new TextDecoder('utf-8')
  let replayDepth = 0
  /** 每来一份快照加一：快照之前排下的本地行作废。 */
  let generation = 0
  /** 前台程序一次滚轮滚几行（ADR-0029）；没量过时按多数程序的默认值 3。 */
  let wheelStep = 3
  /** 正在进行的标定：等程序重画回来看屏幕挪了几行。 */
  let probe: { sub: IDisposable; timer: ReturnType<typeof setTimeout> } | null = null
  /** 最近一次标定认出了位移。 */
  let probeOk = false
  const endProbe = () => {
    if (!probe) return
    probe.sub.dispose()
    clearTimeout(probe.timer)
    probe = null
  }
  const visibleRows = () => {
    const b = term.buffer.active
    return Array.from({ length: term.rows }, (_, i) => b.getLine(b.viewportY + i)?.translateToString(true) ?? '')
  }

  const writeReplay = (s: string) => {
    // 【窗口在入队时就开，解析完才关】：xterm 是分片异步解析的，同步关门会漏掉之后
    // 才触发的自动应答
    replayDepth++
    term.write(s, () => {
      replayDepth--
    })
  }

  return {
    term,
    fit,
    serialize,
    output(bytes, replay) {
      const s = decoder.decode(bytes, { stream: true })
      if (s === '') return // 整帧都是半个字符，留在解码器里等下一帧
      if (replay) writeReplay(s)
      else term.write(s)
    },
    snapshot(bytes) {
      generation++
      // 新的解码器：旧的里面可能还压着半个字符，那是快照之前的流
      decoder = new TextDecoder('utf-8')
      // 快照末尾可能是解析到一半的序列（含半个 UTF-8 字符），stream 模式把它留给下一帧
      writeReplay(RIS + decoder.decode(bytes, { stream: true }))
    },
    local(line) {
      // 进程已经结束：解码器里若还压着半个字符，冲出来（会是 U+FFFD），别让它排到提示行后面
      const tail = decoder.decode()
      const gen = generation
      term.write(tail, () => {
        if (gen !== generation) return
        // 光标不在行首就先换行，免得接在提示符后面
        term.write((term.buffer.active.cursorX > 0 ? '\r\n' : '') + line)
      })
    },
    replaying: () => replayDepth > 0,
    altScreen: () => term.buffer.active.type === 'alternate',
    mouseTracking: () => term.modes.mouseTrackingMode !== 'none',
    rowHeight() {
      const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
      return Math.max((screen?.getBoundingClientRect().height ?? 0) / Math.max(term.rows, 1), 1)
    },
    wheelStep: () => wheelStep,
    calibrating: () => probe !== null,
    calibrated: () => probeOk,
    wheel(up, x, y, calibrate) {
      if (calibrate && !probe) {
        probeOk = false
        // 发之前记下屏幕；之后每次写入解析完比一次，认出位移就是步长。量不到就沿用旧值
        const before = visibleRows()
        const sub = term.onWriteParsed(() => {
          const k = detectShift(before, visibleRows(), up)
          if (k > 0) {
            wheelStep = k
            probeOk = true
            endProbe()
          }
        })
        probe = { sub, timer: setTimeout(endProbe, CALIBRATE_MS) }
      }
      // 交给 xterm 自己的鼠标跟踪路径：一个 DOM_DELTA_LINE 的滚轮就是一次上报，
      // 编码（X10 / SGR / URXVT）与行列都按程序要的协议算
      term.element?.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: up ? -1 : 1,
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      )
    },
    dispose() {
      endProbe()
      term.dispose()
    },
  }
}

/**
 * xterm 的主题从 CSS 自定义属性读（layout.md §主题）：`--term-bg` `--term-fg`
 * `--term-cursor` `--term-sel` 与 16 色 `--ansi-0` … `--ansi-15`。没定义的项留给 xterm 默认。
 */
export function themeFromCss(get: (name: string) => string): ITheme {
  const v = (name: string) => get(name).trim() || undefined
  const ansi = [
    'black',
    'red',
    'green',
    'yellow',
    'blue',
    'magenta',
    'cyan',
    'white',
    'brightBlack',
    'brightRed',
    'brightGreen',
    'brightYellow',
    'brightBlue',
    'brightMagenta',
    'brightCyan',
    'brightWhite',
  ] as const
  const theme: Record<string, string | undefined> = {
    background: v('--term-bg'),
    foreground: v('--term-fg'),
    cursor: v('--term-cursor'),
    cursorAccent: v('--term-bg'),
    selectionBackground: v('--term-sel'),
  }
  ansi.forEach((name, i) => {
    theme[name] = v(`--ansi-${i}`)
  })
  for (const k of Object.keys(theme)) if (theme[k] === undefined) delete theme[k]
  return theme as ITheme
}

/** 进程结束的本地提示行（AC-4.5）。暗色显示，与输出区分开。 */
export function exitLine(code: number | null): string {
  const text = code === null ? '[进程已结束 · 按 Enter 关闭]' : `[进程已结束（退出码 ${code}）· 按 Enter 关闭]`
  return `\x1b[0;2m${text}\x1b[0m`
}
