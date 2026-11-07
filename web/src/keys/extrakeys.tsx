/**
 * Extra keys (AC-3.18 / AC-3.19, input.md): a fixed 80px slot with two pages, the key
 * page (Termux's default 14 keys) and the text page (a two-row textarea, with the paperclip
 * that sends files floating over its bottom-right corner, ADR-0051). A fixed 44px column on the
 * left holds the sessions button (top, session count in a box) and ✎ (bottom) on compact,
 * only ✎ on wide. Both pages have the same height, so flipping never changes terminal
 * geometry.
 *
 * The current page and the text draft are per session (AC-3.22, ADR-0036) and tracked by
 * the controller. This component shows the active session's page, delegates flipping to
 * `onTogglePage` and hands the text box DOM over via `register`.
 *
 * Every key calls preventDefault on pointerdown, so pressing one never shows or hides the
 * on-screen keyboard or moves focus. Bytes go out from the pointerup dispatch
 * (`term.input()`, through onData), so a horizontal swipe across the keys flips pages
 * without pressing anything, and a CTRL / ALT press only becomes a tap or a lock on release.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'

import type { Form } from '../app/form'
import { EditIcon, PaperclipLargeIcon } from '../ui/icons'
import { PressTracker } from '../ui/longpress'
import { capturePointer } from '../ui/pointer'
import { EXTRA_KEYS, appAction, isModifierKey, type ExtraKeyId, type Sticky } from './keymap'
import { isPageSwipe, textEnter, type KeyPage, type TextPageEls, type TextSend } from './textpage'

export interface ExtraKeysProps {
  form: Form
  /** Session count, shown in the sessions button's box. */
  count: number
  /** Some non-active session has unread output: a dot on the sessions button. */
  unread: boolean
  sticky: Sticky
  /** The active session's page. */
  page: KeyPage
  onOpenSessions(): void
  /** ✎ or a swipe across the keys: flip the active session's page (the controller flips the DOM and handles focus). */
  onTogglePage(): void
  /** A non-modifier key was pressed (called from the pointerup dispatch). */
  onKey(id: ExtraKeyId): void
  /** Enter on the text page (called from the keydown dispatch). */
  /** Returns false when the text wasn't sent (too large); the box keeps it. */
  onSend(send: TextSend): boolean
  register(els: TextPageEls | null): void
  /** The paperclip in the text box's corner: open the file picker (called inside the click, ADR-0051). */
  onUpload(): void
  /** Files are uploading: the paperclip pulses. */
  uploading: boolean
}

const noFocus = (e: Event) => e.preventDefault()

export function ExtraKeys(p: ExtraKeysProps) {
  const page = p.page
  const slotRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const press = useRef(new PressTracker()).current
  const gesture = useRef<{ x: number; y: number; key: ExtraKeyId | null } | null>(null)
  const [, setTick] = useState(0)
  const rerender = () => setTick((n) => n + 1)

  useEffect(() => p.sticky.subscribe(rerender), [p.sticky])

  useLayoutEffect(() => {
    const ta = taRef.current
    const slot = slotRef.current
    if (!ta || !slot) return
    // Must use setAttribute (AC-3.10): Chrome implements autocorrect as a boolean IDL
    // property. In JSX the framework sets the property, "off" is truthy, and the reflected
    // attribute becomes autocorrect="on"
    ta.setAttribute('autocorrect', 'off')
    ta.setAttribute('autocapitalize', 'off')
    ta.setAttribute('spellcheck', 'false')
    ta.setAttribute('autocomplete', 'off')
    ta.setAttribute('enterkeyhint', 'send')
    p.register({ slot, text: ta })
    return () => p.register(null)
  }, [])

  const onDown = (e: PointerEvent) => {
    const keyEl = (e.target as Element).closest<HTMLElement>('[data-key]')
    const key = (keyEl?.dataset.key as ExtraKeyId | undefined) ?? null
    if (page === 'keys') {
      e.preventDefault() // Don't take focus
      capturePointer(e.currentTarget as Element, e.pointerId)
    }
    gesture.current = { x: e.clientX, y: e.clientY, key: page === 'keys' ? key : null }
    if (key && isModifierKey(key) && page === 'keys') {
      const mod = key === 'Ctrl' ? 'ctrl' : 'alt'
      press.down(e.clientX, e.clientY, () => p.sticky.hold(mod))
    }
  }

  const onUp = (e: PointerEvent) => {
    const g = gesture.current
    gesture.current = null
    if (!g) return
    if (isPageSwipe(e.clientX - g.x, e.clientY - g.y)) {
      press.cancel()
      p.onTogglePage()
      return
    }
    if (!g.key) {
      press.cancel()
      return
    }
    if (isModifierKey(g.key)) {
      if (press.up() === 'tap') p.sticky.tap(g.key === 'Ctrl' ? 'ctrl' : 'alt')
      return
    }
    p.onKey(g.key)
  }

  const onTextKey = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return
    if (appAction(e) !== null) return // Ctrl+Shift+Enter is New session; leave it to the global shortcut
    const ta = e.currentTarget as HTMLTextAreaElement
    const send = textEnter(ta.value, e)
    if (send.kind === 'none') return // Mid-composition: let the IME pick the candidate
    e.preventDefault() // Enter never inserts a newline in the text box
    if (p.onSend(send)) ta.value = '' // Stay on the text page with focus unchanged
  }

  return (
    <div class="extrakeys" data-testid="extrakeys" data-page={page} ref={slotRef}>
      <div class="ek-side">
        {p.form === 'compact' && (
          <button
            type="button"
            class="ek-side-btn"
            data-testid="open-sessions"
            data-unread={p.unread ? 'true' : 'false'}
            aria-label={p.unread ? `Sessions: ${p.count} (new output)` : `Sessions: ${p.count}`}
            onPointerDown={noFocus}
            onClick={p.onOpenSessions}
          >
            {/* Styled like a mobile browser's tabs button: the count in a rounded box (ADR-0030 §3) */}
            <span class="ek-count" aria-hidden="true">
              {p.count}
            </span>
          </button>
        )}
        <button
          type="button"
          class="ek-side-btn"
          data-testid="toggle-text"
          aria-pressed={page === 'text' ? 'true' : 'false'}
          aria-label={page === 'text' ? 'Back to extra keys' : 'Text input'}
          onPointerDown={noFocus}
          onClick={p.onTogglePage}
        >
          <EditIcon />
        </button>
      </div>
      <div
        class="ek-main"
        onPointerDown={onDown}
        onPointerMove={(e) => press.move(e.clientX, e.clientY)}
        onPointerUp={onUp}
        onPointerCancel={() => {
          gesture.current = null
          press.cancel()
        }}
      >
        <div class="ek-keys" role="group" aria-label="Extra keys">
          {EXTRA_KEYS.flat().map((k) => {
            const mod = k.id === 'Ctrl' ? 'ctrl' : k.id === 'Alt' ? 'alt' : null
            const sticky = mod ? p.sticky.state(mod) : undefined
            return (
              <button
                type="button"
                key={k.id}
                tabIndex={-1}
                class="ek-key"
                data-key={k.id}
                data-testid={`key-${k.id}`}
                data-sticky={sticky}
                aria-pressed={sticky === undefined ? undefined : sticky === 'off' ? 'false' : 'true'}
              >
                {k.label}
              </button>
            )
          })}
        </div>
        <div class="ek-textrow">
          <textarea ref={taRef} class="ek-text" data-testid="textinput" rows={2} aria-label="Text input" onKeyDown={onTextKey} />
          <button
            type="button"
            class="ek-upload"
            data-testid="text-upload-file"
            data-busy={p.uploading ? 'true' : 'false'}
            aria-label="Send file"
            onPointerDown={noFocus}
            onClick={p.onUpload}
          >
            <PaperclipLargeIcon />
          </button>
        </div>
      </div>
    </div>
  )
}
