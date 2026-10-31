/**
 * 文本输入页的语义（AC-3.19，input.md §文本输入页）—— 纯函数，组件只做装配。
 */

/** 回车之后要做什么。 */
export type TextSend =
  /** 不处理：交给输入法选词。 */
  | { kind: 'none' }
  /** 等同逐字键入：`term.input(data, true)`，走 onData。 */
  | { kind: 'input'; data: string }
  /** 含换行（只可能来自粘贴）：`term.paste(data)`，括号粘贴由 xterm 按对端模式包裹。 */
  | { kind: 'paste'; data: string }

export interface EnterEventLike {
  isComposing: boolean
  keyCode: number
}

/**
 * 回车（照 Termux）：
 *   正在组字 → 不处理；
 *   有内容   → 把内容发出去，**不追加回车**；
 *   没内容   → 发一个 `\r`。
 * 回车永远不在文本框里插入换行（调用方在非 none 时 preventDefault）。
 */
export function textEnter(value: string, ev: EnterEventLike): TextSend {
  if (ev.isComposing || ev.keyCode === 229) return { kind: 'none' }
  if (value === '') return { kind: 'input', data: '\r' }
  if (value.includes('\n')) return { kind: 'paste', data: value }
  return { kind: 'input', data: value }
}

/** 键区上的横向滑动切页：横向位移 > 40px 且横向占优（加速路径，✎ 才是可见入口）。 */
export const PAGE_SWIPE_PX = 40

export function isPageSwipe(dx: number, dy: number): boolean {
  return Math.abs(dx) > PAGE_SWIPE_PX && Math.abs(dx) > Math.abs(dy)
}
