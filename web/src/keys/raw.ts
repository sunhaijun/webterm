/**
 * Text typed straight into the terminal, as an IME fallback (docs/40-frontend/input.md,
 * IME handling and directly inserted text).
 *
 * Two paths:
 *  1. During IME composition not a single byte is sent; the final text goes out once on
 *     compositionend. Meanwhile an inline preview at the cursor shows what is being typed.
 *  2. Directly inserted characters (inserted by the on-screen keyboard without
 *     composition, e.g. full-width punctuation on the iOS Chinese keyboard) are handled
 *     here because xterm drops them; see the beforeinput comment below (AC-3.14).
 */

export interface RawImeHandlers {
  /** Commits final text (compositionend, or a direct insertion outside composition). */
  onCommit(text: string): void
  /** The composition text changed; update the preview. Empty string hides it. */
  onPreview(text: string): void
}

/**
 * How long an armed dedup marker stays valid.
 *
 * This is not what decides duplicates. Dedup relies on who armed it and on one-shot use:
 * only text that another path already sent gets armed (the compositionend re-send,
 * characters xterm's _keyPress already sent), and the marker is disarmed after suppressing
 * once. The window only stops a stale marker from eating a real keystroke much later.
 *
 * Deduping by content + time window would be wrong: directly inserted characters arrive
 * only through beforeinput, so typing the same punctuation twice would silently drop the
 * second one, and nothing else would send it (ADR-0020).
 */
const DEDUP_MS = 120

/**
 * RawIme attaches to xterm's hidden textarea.
 *
 * That textarea must not be display:none, or composition events never fire. onCommit runs
 * inside the compositionend / beforeinput dispatch; callers should pass the text to
 * `term.input(text, true)` so it leaves through the same onData exit (replay gate, sticky
 * modifiers and inputStats all apply).
 */
export class RawIme {
  private composing = false
  /** Armed text and when it was armed: another path already sent it, so an identical re-send right after must be dropped. */
  private sent = ''
  private sentAt = 0
  private readonly el: HTMLTextAreaElement
  private readonly h: RawImeHandlers
  private readonly listeners: [string, EventListener, boolean][] = []

  constructor(el: HTMLTextAreaElement, h: RawImeHandlers) {
    this.el = el
    this.h = h

    this.on('compositionstart', () => {
      this.composing = true
      this.h.onPreview('')
    })
    this.on('compositionupdate', (e) => {
      // Send nothing; only update the preview
      this.h.onPreview((e as CompositionEvent).data ?? '')
    })
    this.on('compositionend', (e) => {
      this.composing = false
      this.h.onPreview('')
      const data = (e as CompositionEvent).data ?? ''
      if (data) this.commit(data)
      // Clear the textarea so xterm doesn't send the same text again as input
      this.el.value = ''
    })

    // Fallback reset (AC-3.3 / ADR-0020). Above, the only way out of composing is
    // compositionend, and it isn't guaranteed: switching IMEs or windows, or the OS
    // swallowing the candidate window, can leave composition half done. A composing flag
    // stuck at true kills terminal input for this session for good (every keydown handler
    // returns early), with no hint to the user except to reload.
    //
    // blur: the element lost focus, so composition can't still be in progress.
    this.on('blur', () => this.stopComposing())
    // keydown: the browser says this key is not part of a composition (isComposing=false
    // and not the IME's 229). Must be capture phase: RawIme is constructed after
    // term.open(), so in the bubble phase it would run after xterm's keydown, which would
    // already have dropped the key as "composing". The reset has to happen before xterm
    // handles the key.
    this.on(
      'keydown',
      (e) => {
        const ke = e as KeyboardEvent
        if (ke.isComposing || ke.keyCode === 229) return
        this.stopComposing()
      },
      true,
    )

    // When xterm's _keyPress handles a printable character it does not preventDefault
    // (cancelEvents defaults to false), so the character still lands in the textarea and
    // fires beforeinput again. Arm it for the dedup below.
    this.on('keypress', (e) => {
      const key = (e as KeyboardEvent).key
      if (key && key.length === 1) this.arm(key)
    })

    // Directly inserted text is sent by us (AC-3.14).
    //
    // None of xterm 5.5's three input paths catch full-width punctuation from the iOS
    // on-screen keyboard:
    //  · keydown reads the character only if keyCode >= 48; iOS reports keyCode 0 for
    //    these insertions;
    //  · the input event fallback runs only if no keydown was seen (_keyDownSeen), but one
    //    just happened;
    //  · the textarea diff runs only for keyCode === 229.
    // So on the same keyboard a key reporting 229 (period) gets through while one reporting
    // 0 (comma) falls between the paths and is lost.
    //
    // We take over in beforeinput: preventDefault keeps the character out of the textarea,
    // so neither xterm's input path nor the 229 diff sends it again. Composition is left
    // alone (compositionend handles it), and keys xterm handles in keydown are
    // preventDefault'ed and never produce beforeinput, so ordinary keys are unaffected.
    this.on('beforeinput', (e) => {
      const ie = e as InputEvent
      if (this.composing || ie.isComposing) return
      if (ie.inputType !== 'insertText') return
      const data = ie.data
      if (!data) return
      // Sent or not, keep it out of the textarea, or xterm's diff path sends it again
      e.preventDefault()
      const duplicate = data === this.sent && Date.now() - this.sentAt < DEDUP_MS
      // One-shot: disarm after suppressing once. The re-send happens once; the same text again is a new keystroke
      this.disarm()
      if (duplicate) return
      // Don't arm what we send here. It is what the user just typed, not something another
      // path already sent; arming it would swallow the second of two identical keystrokes (AC-3.14)
      this.h.onCommit(data)
    })
  }

  /** Ends composition (the normal compositionend has its own path; this is the fallback). */
  private stopComposing(): void {
    if (!this.composing) return
    this.composing = false
    this.h.onPreview('') // Hide the preview too, or an orphaned one stays on screen
  }

  /** Sends and arms. Only compositionend uses this: WebKit re-sends the same text once. */
  private commit(text: string): void {
    this.arm(text)
    this.h.onCommit(text)
  }

  /** Arms: records text that another path already sent. */
  private arm(text: string): void {
    this.sent = text
    this.sentAt = Date.now()
  }

  /** Disarms. */
  private disarm(): void {
    this.sent = ''
    this.sentAt = 0
  }

  /** Whether composition is in progress. Every keydown handler must return early while it is true (AC-3.3). */
  get isComposing(): boolean {
    return this.composing
  }

  dispose(): void {
    for (const [type, fn, capture] of this.listeners) this.el.removeEventListener(type, fn, capture)
    this.listeners.length = 0
  }

  private on(type: string, fn: (e: Event) => void, capture = false): void {
    this.el.addEventListener(type, fn, capture)
    this.listeners.push([type, fn, capture])
  }
}

/** Where the inline preview goes: it follows the terminal cursor. */
export interface CursorRect {
  left: number
  top: number
}

export function cursorPosition(
  cursorX: number,
  cursorY: number,
  cell: { width: number; height: number },
): CursorRect {
  return { left: cursorX * cell.width, top: (cursorY + 1) * cell.height }
}
