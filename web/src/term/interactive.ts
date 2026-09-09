/**
 * 「前台有程序在占屏」的检测 —— ADR-0011 分片 ② 的推广。
 *
 * 老的信号只有备用屏幕缓冲（vim / top / less 的 `\e[?1049h`）。可是 claude、
 * codex 这类现代 CLI【在主屏缓冲上就地重绘】，根本不切备用缓冲 —— 于是它们
 * 停在读视图，被 plainText 拍扁成一坨（单词粘连、整屏塌成一行横向溢出）。
 *
 * 就地重绘的机械签名（区别于只会向前追加的流式日志）：
 *   - 备用缓冲激活，或
 *   - 用了同步输出（DECSET 2026）—— 正在画一帧，或
 *   - 隐藏了光标（DECRST 25）之后，把光标【上移 / 定位到某一行】重写已经吐过的行。
 * 流式日志只会 `\r` 回到行首、换行往下走，不会上移，通常也不藏光标。
 *
 * 命中即视为"占屏"，交给上层切到终端视图（真 xterm 渲染得好好的）。主屏就地
 * 重绘的判定在一条命令内是【粘的】—— 程序在输入框显示光标不代表它退出了 ——
 * 只在命令边界（reset()）清掉。
 */
import type { IDisposable, Terminal } from '@xterm/xterm'

export interface InteractiveDetector {
  /** 当前是否有程序占屏（备用缓冲 或 主屏就地重绘）。 */
  get(): boolean
  onChange(cb: (on: boolean) => void): () => void
  /** 命令边界：清掉主屏就地重绘的判定（备用缓冲由 xterm 自己维护）。 */
  reset(): void
  dispose(): void
}

export function installInteractive(term: Terminal): InteractiveDetector {
  let mainRepaint = false // 主屏就地重绘，sticky，reset 清
  let cursorHidden = false
  let last = false
  const cbs = new Set<(on: boolean) => void>()
  const disposers: IDisposable[] = []

  const alt = () => term.buffer.active.type === 'alternate'
  const state = () => alt() || mainRepaint
  const fire = () => {
    const v = state()
    if (v === last) return
    last = v
    for (const cb of cbs) cb(v)
  }
  const markRepaint = () => {
    if (mainRepaint) return
    mainRepaint = true
    fire()
  }
  // 光标上移 / 绝对定位到已写过的行 → 就地重绘（但只在藏了光标、且不在备用缓冲时算，
  // 好把带小进度条的流式日志排除掉 —— 它们不藏光标）
  const upward = () => {
    if (cursorHidden && !alt()) markRepaint()
  }

  disposers.push(term.buffer.onBufferChange(() => fire()))
  disposers.push(
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      if (params.includes(2026)) markRepaint() // 同步输出 = 正在画一帧
      if (params.includes(25)) cursorHidden = false // 显示光标
      return false // 【不消费】，xterm 照常处理
    }),
  )
  disposers.push(
    term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
      if (params.includes(25)) cursorHidden = true // 隐藏光标
      return false
    }),
  )
  // CUU（上移）/ CPL（上移到行首）
  disposers.push(term.parser.registerCsiHandler({ final: 'A' }, () => (upward(), false)))
  disposers.push(term.parser.registerCsiHandler({ final: 'F' }, () => (upward(), false)))
  // CUP / HVP：定位到第 2 行及以下（第 1 行或缺省是 clear 常见前奏，不算）
  const absRow = (p: (number | number[])[]) => {
    const r = p[0]
    if (cursorHidden && !alt() && typeof r === 'number' && r > 1) markRepaint()
    return false
  }
  disposers.push(term.parser.registerCsiHandler({ final: 'H' }, absRow))
  disposers.push(term.parser.registerCsiHandler({ final: 'f' }, absRow))

  return {
    get: state,
    onChange(cb) {
      cbs.add(cb)
      return () => cbs.delete(cb)
    },
    reset() {
      mainRepaint = false
      cursorHidden = false
      fire()
    },
    dispose() {
      for (const d of disposers) d.dispose()
      cbs.clear()
    },
  }
}
