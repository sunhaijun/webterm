/**
 * 「前台有程序在占屏」的检测 —— ADR-0011 分片 ② 的推广。
 *
 * 占屏有两类信号：
 *  1. xterm 能自己跟踪的【模式】——【实时读】，程序退出复位后立即反映（不粘）：
 *     - 备用屏幕缓冲（`buffer.active.type === 'alternate'`）：vim / top? / less / htop
 *     - 应用光标键 DECCKM（`\e[?1h`）：top（不切备用缓冲，靠它想接管方向键）
 *     - 鼠标跟踪（`\e[?1000/1002/1003/1006h`）
 *  2. xterm 不跟踪的信号 ——【粘】到命令边界（reset()），因为没有"复位"可读：
 *     - 富键盘协议：Kitty 键盘入栈 `\e[>…u`、modifyOtherKeys `\e[>…m`：claude / codex
 *     - 同步输出 DECSET 2026（整帧重绘）：codex
 *
 * 【注】claude 2.x 现在【也进备用缓冲】（实测 2.1.270：启动头 20 字节就发
 * `\e[?1049h`，全程只发这一次）。所以它会同时命中第 1 类与第 2 类信号 ——
 * 判定不受影响，但别再照着"claude 不切备用缓冲"来推理。agent 侧靠同一个开关
 * 决定切回时回放还是重画，见 ADR-0019。
 *
 * 【关键】：DECCKM / 备用缓冲要【实时读】而不是粘 —— 否则 less/vim 这种既切备用缓冲
 * 又设 DECCKM 的程序，按 q 退出后备用缓冲已关、DECCKM 已复位，却因为"粘"还占着，
 * 迟迟不回读（实测：回读超时）。而进度条（npm/cargo/docker）不进入任何这些模式。
 */
import type { IDisposable, Terminal } from '@xterm/xterm'

export interface InteractiveDetector {
  get(): boolean
  onChange(cb: (on: boolean) => void): () => void
  /** 命令边界：清掉"粘"的信号（键盘协议 / 2026）。模式类由 xterm 自己维护。 */
  reset(): void
  /** 从当前 xterm 模式重新判定（重连 / 切会话后补判已在跑的全屏程序）。 */
  sync(): void
  dispose(): void
}

export function installInteractive(term: Terminal): InteractiveDetector {
  let sticky = false // 键盘协议 / 2026，reset 清
  let last = false
  const cbs = new Set<(on: boolean) => void>()
  const disposers: IDisposable[] = []

  const alt = () => term.buffer.active.type === 'alternate'
  const modeOn = () => {
    try {
      const m = term.modes
      return m.applicationCursorKeysMode || m.mouseTrackingMode !== 'none'
    } catch {
      return false
    }
  }
  const state = () => alt() || modeOn() || sticky
  const fire = () => {
    const v = state()
    if (v === last) return
    last = v
    for (const cb of cbs) cb(v)
  }
  // 模式在 xterm 的默认处理器里更新（在我们的处理器之后），所以延到微任务再读
  const fireSoon = () => queueMicrotask(fire)
  const mark = () => {
    if (sticky) return
    sticky = true
    fire()
  }

  disposers.push(term.buffer.onBufferChange(() => fire()))
  // 粘信号：富键盘协议、同步输出
  disposers.push(term.parser.registerCsiHandler({ prefix: '>', final: 'u' }, () => (mark(), false)))
  disposers.push(term.parser.registerCsiHandler({ prefix: '>', final: 'm' }, () => (mark(), false)))
  // DECSET/DECRST：2026 是粘信号；其余（DECCKM ?1、鼠标 ?1000… 的开关）走实时模式，只需触发一次重判
  disposers.push(
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      if (params.includes(2026)) mark()
      else fireSoon()
      return false
    }),
  )
  disposers.push(term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, () => (fireSoon(), false)))

  return {
    get: state,
    onChange(cb) {
      cbs.add(cb)
      return () => cbs.delete(cb)
    },
    reset() {
      sticky = false
      fire()
    },
    sync() {
      fire() // state() 会实时读备用缓冲 + 模式
    },
    dispose() {
      for (const d of disposers) d.dispose()
      cbs.clear()
    },
  }
}
