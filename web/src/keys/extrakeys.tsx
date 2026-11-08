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
 * on-screen keyboard or moves focus. A control acts only when released within 10px of where
 * it was pressed (ADR-0056 §1): the pressed look is `data-pressed`, dropped as soon as the
 * finger moves on, so a swipe never highlights or sends a key. Swipes are read from touch
 * events, which keep coming while the text box scrolls natively: right collapses the bar
 * (it follows the finger until release), up goes to the text page, down comes back from
 * it while the box is at its top.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'

import type { Form } from '../app/form'
import { CombosIcon, EditIcon, HistoryIcon, PaperclipLargeIcon } from '../ui/icons'
import { PressTracker } from '../ui/longpress'
import { capturePointer } from '../ui/pointer'
import { TAP_PX, keyGesture, previewBar } from './collapse'
import { EXTRA_KEYS, appAction, isModifierKey, type ExtraKeyId, type Sticky } from './keymap'
import { textEnter, type KeyPage, type TextPageEls, type TextSend } from './textpage'

export interface ExtraKeysProps {
  form: Form
  /** Session count, shown in the sessions button's box. */
  count: number
  /** Some non-active session is waiting for you (ADR-0052): a dot on the sessions button. */
  attention: boolean
  sticky: Sticky
  /** The active session's page. */
  page: KeyPage
  onOpenSessions(): void
  /** ✎, or a swipe up / down: flip the active session's page (the controller flips the DOM and handles focus). */
  onTogglePage(): void
  /** Collapsed into the corner button (ADR-0056): out of the grid, off to the right. */
  collapsed: boolean
  /** A swipe right: collapse. */
  onCollapse(): void
  /** A non-modifier key was pressed (called from the pointerup dispatch). */
  onKey(id: ExtraKeyId): void
  /** The last column: open the frequent-input or the combo-key menu (ADR-0054). */
  onMenu(menu: KeyMenu): void
  /** Which of the two menus is open, if any. */
  menu: KeyMenu | null
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

/** The two keys at the end of the rows (ADR-0054 §1). */
export type KeyMenu = 'frequent' | 'combos'
const MENU_KEYS: { menu: KeyMenu; label: string; icon: () => preact.JSX.Element }[] = [
  { menu: 'frequent', label: 'Frequent input', icon: HistoryIcon },
  { menu: 'combos', label: 'Combo keys', icon: CombosIcon },
]

export function ExtraKeys(p: ExtraKeysProps) {
  const page = p.page
  const slotRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const press = useRef(new PressTracker()).current
  const gesture = useRef<{
    x: number
    y: number
    key: ExtraKeyId | null
    menu: KeyMenu | null
    el: HTMLElement | null
    maxMove: number
  } | null>(null)
  // The touch behind the current swipe, if any (touch events, see the header comment)
  const swipe = useRef<{ x: number; y: number; maxMove: number; textTop: boolean } | null>(null)
  // The last press moved past TAP_PX: the side buttons' click (which the browser may still
  // fire after a short drag) is ignored then
  const moved = useRef(false)
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
    const target = e.target as Element
    const el = target.closest<HTMLElement>('[data-tap]')
    const keyEl = target.closest<HTMLElement>('[data-key]')
    const key = (keyEl?.dataset.key as ExtraKeyId | undefined) ?? null
    const menuEl = target.closest<HTMLElement>('[data-menu]')
    const menu = page === 'keys' ? ((menuEl?.dataset.menu as KeyMenu | undefined) ?? null) : null
    const inKeys = page === 'keys' && target.closest('.ek-main') !== null
    if (inKeys) {
      e.preventDefault() // Don't take focus
      capturePointer(e.currentTarget as Element, e.pointerId)
    }
    moved.current = false
    el?.setAttribute('data-pressed', 'true')
    gesture.current = { x: e.clientX, y: e.clientY, key: inKeys ? key : null, menu: inKeys ? menu : null, el, maxMove: 0 }
    if (key && isModifierKey(key) && inKeys) {
      const mod = key === 'Ctrl' ? 'ctrl' : 'alt'
      press.down(e.clientX, e.clientY, () => p.sticky.hold(mod))
    }
  }

  const onMove = (e: PointerEvent) => {
    press.move(e.clientX, e.clientY)
    const g = gesture.current
    if (!g) return
    g.maxMove = Math.max(g.maxMove, Math.hypot(e.clientX - g.x, e.clientY - g.y))
    if (g.maxMove > TAP_PX) {
      g.el?.removeAttribute('data-pressed')
      moved.current = true
    }
  }

  const onUp = (e: PointerEvent) => {
    const g = gesture.current
    gesture.current = null
    if (!g) return
    g.el?.removeAttribute('data-pressed')
    if (Math.max(g.maxMove, Math.hypot(e.clientX - g.x, e.clientY - g.y)) > TAP_PX) {
      // A swipe: the touch handlers decide what it was; it presses nothing
      moved.current = true
      press.cancel()
      return
    }
    if (g.menu) {
      p.onMenu(g.menu)
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

  const onCancel = () => {
    gesture.current?.el?.removeAttribute('data-pressed')
    gesture.current = null
    press.cancel()
  }

  // ---------- swipes (touch events) ----------

  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches[0]
    swipe.current = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY, maxMove: 0, textTop: (taRef.current?.scrollTop ?? 0) <= 0 } : null
  }

  const onTouchMove = (e: TouchEvent) => {
    const s = swipe.current
    const t = e.touches[0]
    if (!s || !t) return
    const dx = t.clientX - s.x
    const dy = t.clientY - s.y
    s.maxMove = Math.max(s.maxMove, Math.hypot(dx, dy))
    // Rightward and mostly horizontal: the bar follows the finger (no relayout until release)
    previewBar(slotRef.current, false, dx > TAP_PX && Math.abs(dx) > Math.abs(dy) ? dx : null)
  }

  const onTouchEnd = (e: TouchEvent) => {
    const s = swipe.current
    swipe.current = null
    previewBar(slotRef.current, false, null)
    const t = e.changedTouches[0]
    if (!s || !t) return
    const dx = t.clientX - s.x
    const dy = t.clientY - s.y
    switch (keyGesture(dx, dy, Math.max(s.maxMove, Math.hypot(dx, dy)), page, s.textTop)) {
      case 'collapse':
        p.onCollapse()
        break
      case 'toText':
      case 'toKeys':
        p.onTogglePage()
        break
    }
  }

  const onTouchCancel = () => {
    swipe.current = null
    previewBar(slotRef.current, false, null)
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
    <div
      class="extrakeys"
      data-testid="extrakeys"
      data-page={page}
      data-collapsed={p.collapsed ? 'true' : undefined}
      ref={slotRef}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onCancel}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    >
      <div class="ek-side">
        {p.form === 'compact' && (
          <button
            type="button"
            class="ek-side-btn"
            data-tap
            data-testid="open-sessions"
            data-attention={p.attention ? 'true' : 'false'}
            aria-label={p.attention ? `Sessions: ${p.count} (waiting for you)` : `Sessions: ${p.count}`}
            onPointerDown={noFocus}
            onClick={() => moved.current || p.onOpenSessions()}
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
          data-tap
          data-testid="toggle-text"
          aria-pressed={page === 'text' ? 'true' : 'false'}
          aria-label={page === 'text' ? 'Back to extra keys' : 'Text input'}
          onPointerDown={noFocus}
          onClick={() => moved.current || p.onTogglePage()}
        >
          <EditIcon />
        </button>
      </div>
      <div class="ek-main">
        <div class="ek-keys" role="group" aria-label="Extra keys">
          {EXTRA_KEYS.map((row, r) => [
            ...row.map((k) => {
              const mod = k.id === 'Ctrl' ? 'ctrl' : k.id === 'Alt' ? 'alt' : null
              const sticky = mod ? p.sticky.state(mod) : undefined
              return (
                <button
                  type="button"
                  key={k.id}
                  tabIndex={-1}
                  class="ek-key"
                  data-tap
                  data-key={k.id}
                  data-testid={`key-${k.id}`}
                  data-sticky={sticky}
                  aria-pressed={sticky === undefined ? undefined : sticky === 'off' ? 'false' : 'true'}
                >
                  {k.label}
                </button>
              )
            }),
            // The last column (ADR-0054 §1): fixed in place; only their menus follow the program
            ...MENU_KEYS.slice(r, r + 1).map(({ menu, label, icon: MenuIcon }) => (
              <button
                type="button"
                key={menu}
                tabIndex={-1}
                class="ek-key ek-menu-key"
                data-tap
                data-menu={menu}
                data-testid={`key-${menu}`}
                aria-label={label}
                aria-expanded={p.menu === menu ? 'true' : 'false'}
              >
                <MenuIcon />
              </button>
            )),
          ])}
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
