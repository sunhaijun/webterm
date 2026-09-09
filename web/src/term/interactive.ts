/**
 * 「前台有程序在占屏」的检测 —— ADR-0011 分片 ② 的推广。
 *
 * 老信号只有备用屏幕缓冲（vim / top / less 的 `\e[?1049h`）。claude、codex 这类
 * 现代 CLI 在【主屏缓冲】上就地重绘，不切备用缓冲，得靠别的机械信号识别。
 *
 * 【关键：用"程序建立了富键盘输入"当信号，而不是"藏光标 + 光标上移"】。
 * 后者会误伤 npm / pnpm / cargo / docker 这类多行进度条 —— 它们也藏光标、也
 * 上移重绘，一旦被判成占屏就会把用户莫名甩进终端视图、打断输入（实测复现）。
 * 而全屏交互程序会主动【设置键盘协议】来接管按键：
 *   - Kitty 键盘协议入栈：`\e[>…u`
 *   - modifyOtherKeys（XTMODKEYS）：`\e[>…m`
 *   - 同步输出（DECSET 2026）：整帧重绘
 * 进度条工具从不发这些。claude / codex / vim / top / less 都发（或切备用缓冲）。
 *
 * 判定在一条命令内【粘】—— 程序在输入框显示光标不代表退出了 —— 只在命令边界
 * （reset()）清掉。
 */
import type { IDisposable, Terminal } from '@xterm/xterm'

export interface InteractiveDetector {
  /** 当前是否有程序占屏（备用缓冲 或 主屏全屏程序）。 */
  get(): boolean
  onChange(cb: (on: boolean) => void): () => void
  /** 命令边界：清掉主屏占屏判定（备用缓冲由 xterm 自己维护）。 */
  reset(): void
  dispose(): void
}

export function installInteractive(term: Terminal): InteractiveDetector {
  let occupied = false // 主屏全屏程序，sticky，reset 清
  let last = false
  const cbs = new Set<(on: boolean) => void>()
  const disposers: IDisposable[] = []

  const alt = () => term.buffer.active.type === 'alternate'
  const state = () => alt() || occupied
  const fire = () => {
    const v = state()
    if (v === last) return
    last = v
    for (const cb of cbs) cb(v)
  }
  const mark = () => {
    if (occupied) return
    occupied = true
    fire()
  }

  disposers.push(term.buffer.onBufferChange(() => fire()))
  // 富键盘输入的建立 = 交互式全屏程序（进度条不发这些），返回 false 不消费
  disposers.push(term.parser.registerCsiHandler({ prefix: '>', final: 'u' }, () => (mark(), false))) // Kitty 键盘入栈
  disposers.push(term.parser.registerCsiHandler({ prefix: '>', final: 'm' }, () => (mark(), false))) // modifyOtherKeys
  disposers.push(
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      if (params.includes(2026)) mark() // 同步输出：整帧重绘
      return false
    }),
  )

  return {
    get: state,
    onChange(cb) {
      cbs.add(cb)
      return () => cbs.delete(cb)
    },
    reset() {
      occupied = false
      fire()
    },
    dispose() {
      for (const d of disposers) d.dispose()
      cbs.clear()
    },
  }
}
