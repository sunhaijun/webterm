/**
 * 文本输入页的语义（AC-3.19，input.md §文本输入页）—— 纯函数，组件只做装配。
 */

/** 回车之后要做什么。 */
export type TextSend =
  /** 不处理：交给输入法选词。 */
  | { kind: 'none' }
  /**
   * 发出去并回车（ADR-0027）：`text` 非空就先 `term.paste(text)`（对端开了括号粘贴就包裹，
   * 换行转 CR），再单独 `term.input('\r', true)`。空的就只有回车。
   */
  | { kind: 'submit'; text: string }

export interface EnterEventLike {
  isComposing: boolean
  keyCode: number
}

/**
 * 回车：
 *   正在组字 → 不处理；
 *   其余     → 把内容（可能是空的）发出去并回车。
 * 回车永远不在文本框里插入换行（调用方在非 none 时 preventDefault）。
 */
export function textEnter(value: string, ev: EnterEventLike): TextSend {
  if (ev.isComposing || ev.keyCode === 229) return { kind: 'none' }
  return { kind: 'submit', text: value }
}

/** 键区上的横向滑动切页：横向位移 > 40px 且横向占优（加速路径，✎ 才是可见入口）。 */
export const PAGE_SWIPE_PX = 40

export function isPageSwipe(dx: number, dy: number): boolean {
  return Math.abs(dx) > PAGE_SWIPE_PX && Math.abs(dx) > Math.abs(dy)
}
