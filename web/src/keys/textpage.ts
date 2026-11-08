/**
 * Text page semantics (AC-3.19, input.md). Pure functions; the component only wires them up.
 */

/** What Enter does. */
export type TextSend =
  /** Nothing: let the IME pick the candidate. */
  | { kind: 'none' }
  /**
   * Send and press Enter (ADR-0027): if `text` is non-empty, `term.paste(text)` first
   * (wrapped if the program enabled bracketed paste, newlines turned into CR), then a
   * separate `term.input('\r', true)`. Empty text sends just Enter.
   */
  | { kind: 'submit'; text: string }

export interface EnterEventLike {
  isComposing: boolean
  keyCode: number
}

/**
 * Enter:
 *   during IME composition → nothing;
 *   otherwise              → send the contents (possibly empty) and press Enter.
 * Enter never inserts a newline in the text box (callers preventDefault unless the result is none).
 */
export function textEnter(value: string, ev: EnterEventLike): TextSend {
  if (ev.isComposing || ev.keyCode === 229) return { kind: 'none' }
  return { kind: 'submit', text: value }
}

/** Which page the extra-keys slot shows. */
export type KeyPage = 'keys' | 'text'

/** The two DOM nodes the extra-keys component hands to the controller, which flips pages, swaps drafts and moves focus on session switch. */
export interface TextPageEls {
  /** `.extrakeys`; its `data-page` decides which page is visible. */
  slot: HTMLElement
  text: HTMLTextAreaElement
}

/**
 * The text page follows the session (AC-3.22, ADR-0036): each session remembers its page
 * and the unsent draft in the text box. Unknown sessions get the key page and an empty
 * draft. `null` is the entry for "no session". In memory only.
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

  /** Keeps only sessions `keep` accepts, forgetting closed ones and those voided by an agent restart (`sid`s are reused). The `null` entry always stays. */
  retain(keep: (sid: number) => boolean): void {
    for (const sid of this.bySid.keys()) if (sid !== null && !keep(sid)) this.bySid.delete(sid)
  }
}
