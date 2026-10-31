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

/** 附加键槽停在哪一页。 */
export type KeyPage = 'keys' | 'text'

/** 附加键组件交给装配层的两块 DOM：切会话时要同步翻页、换草稿、给焦点。 */
export interface TextPageEls {
  /** `.extrakeys`：它的 `data-page` 决定哪一页可见。 */
  slot: HTMLElement
  text: HTMLTextAreaElement
}

/**
 * 文本页跟着会话走（AC-3.22，ADR-0036）：每个会话各记自己停在哪一页、文本框里没发出去的草稿。
 * 没记过的会话是键位页、空草稿。`null` 是「没有会话」时的那一份。只在内存里。
 */
export class TextPages {
  private readonly bySid = new Map<number | null, { page: KeyPage; draft: string }>()

  page(sid: number | null): KeyPage {
    return this.bySid.get(sid)?.page ?? 'keys'
  }

  draft(sid: number | null): string {
    return this.bySid.get(sid)?.draft ?? ''
  }

  setPage(sid: number | null, page: KeyPage): void {
    this.bySid.set(sid, { page, draft: this.draft(sid) })
  }

  setDraft(sid: number | null, draft: string): void {
    this.bySid.set(sid, { page: this.page(sid), draft })
  }

  /** 只留下 `keep` 认得的会话：关掉的、agent 重启后作废的都忘掉（`sid` 会复用）。`null` 那份一直留着。 */
  retain(keep: (sid: number) => boolean): void {
    for (const sid of this.bySid.keys()) if (sid !== null && !keep(sid)) this.bySid.delete(sid)
  }
}
