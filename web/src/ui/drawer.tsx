/**
 * Sheet primitive: the session drawer on phones plus rename, settings and close
 * confirmation (ADR-0018, layout.md).
 *
 * The shape follows `.app[data-form]` (decided in CSS, ADR-0037 §4): a full-width bottom
 * sheet on `compact` (grab handle, swipe down to close), a centered dialog on `wide`.
 * Closes via backdrop click · `Esc` · ✕ · swipe down (sheet), plus the system back button
 * with `backButton`.
 *
 * Sheets can stack (close confirmation over the session drawer, ADR-0038 §2); `Esc` only
 * goes to the top one.
 *
 * `position: fixed`, outside the `.app` grid, so opening or closing never changes terminal
 * geometry or sends a resize.
 */
import type { ComponentChildren } from 'preact'
import { useLayoutEffect, useRef } from 'preact/hooks'

import { backStack } from './backstack'
import { CloseIcon } from './icons'
import { installSwipeDismiss } from './swipe'

export interface DrawerProps {
  title: string
  onClose(): void
  /** testid of the sheet itself. */
  testid?: string
  /** testid of the backdrop. */
  backdropTestid?: string
  /**
   * Close with the system back button (session-ux.md): push a history entry on open, and
   * Back closes the top such sheet. Closed any other way, the entry is removed again so
   * entries don't pile up; otherwise Back in an Android PWA would exit the app (backstack.ts).
   */
  backButton?: boolean
  /** Replaces the title in the header row (the file browser's up button and path); `title` still names the dialog. */
  head?: ComponentChildren
  /** A fixed row of buttons at the bottom ("+ New session · ⚙" in the session drawer, "Cancel · OK" in confirm and rename). */
  foot?: ComponentChildren
  /** Which kind of sheet; CSS sizes each one by it (the session drawer has a minimum height, ADR-0037 §5). */
  variant?: 'sessions' | 'settings' | 'confirm' | 'rename' | 'files' | 'file'
  children: ComponentChildren
}

export function Drawer({
  title,
  onClose,
  testid,
  backdropTestid = 'drawer-backdrop',
  backButton = false,
  foot,
  variant,
  head,
  children,
}: DrawerProps) {
  const sheetRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  // useLayoutEffect, not useEffect: Preact runs useEffect after paint, when the sheet is
  // already clickable but gestures and Esc aren't wired up yet.
  useLayoutEffect(() => {
    const el = sheetRef.current
    if (!el) return
    // Only the compact sheet closes on swipe down; this checks the same attribute the CSS does
    return installSwipeDismiss(el, () => closeRef.current(), () => el.closest('.app[data-form="compact"]') !== null)
  }, [])
  useLayoutEffect(() => {
    // Pull focus into the sheet: it is modal, and with focus outside Esc has no clear target.
    // For the session drawer this also hides the on-screen keyboard so the drawer gets full height.
    const el = sheetRef.current
    if (!el) return
    const prev = document.activeElement as HTMLElement | null
    if (!el.contains(prev)) el.focus({ preventScroll: true })
    // Stacked on another sheet (close confirmation or rename over the drawer): on close, return
    // focus to the sheet below instead of dropping it on body. Otherwise do nothing; the
    // controller decides whether focus goes back to the terminal.
    return () => {
      if (prev?.isConnected && prev.closest('.drawer') && el.contains(document.activeElement)) prev.focus({ preventScroll: true })
    }
  }, [])
  useLayoutEffect(() => {
    // Capture-phase fallback: even if focus isn't in the sheet, Esc belongs to the sheet and
    // never reaches the terminal. Controls that handle Esc themselves (rename input, session
    // menu; marked data-esc-local) are exempt: there Esc cancels them, not the sheet.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if ((e.target as Element | null)?.closest?.('[data-esc-local]')) return
      // With stacked sheets, close only the top one (the last .drawer in the DOM)
      const sheets = document.querySelectorAll('.drawer')
      if (sheets[sheets.length - 1] !== sheetRef.current) return
      e.preventDefault()
      e.stopPropagation()
      closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  useLayoutEffect(() => {
    if (!backButton) return
    return backStack().push(() => closeRef.current())
  }, [backButton])

  return (
    <div class="drawer-backdrop" data-testid={backdropTestid} onClick={() => closeRef.current()}>
      <div
        class="drawer"
        data-testid={testid}
        data-variant={variant}
        data-foot={foot ? 'true' : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={sheetRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Enter on a button: the browser clicks on keydown, and the following keypress would land
          // in the terminal that just got focus back, adding a stray Enter (after close confirm or
          // New session). Click it ourselves and suppress the default.
          const btn = (e.target as Element).closest?.('button')
          if (e.key !== 'Enter' || !btn || e.isComposing) return
          e.preventDefault()
          btn.click()
        }}
      >
        <div class="drawer-grab" />
        <div class="drawer-head">
          {head ?? <h2 class="drawer-title">{title}</h2>}
          <button class="drawer-close" data-testid="drawer-close" aria-label="Close" onClick={() => closeRef.current()}>
            <CloseIcon size={16} />
          </button>
        </div>
        <div class="drawer-body">
          {children}
        </div>
        {foot && <div class="drawer-foot">{foot}</div>}
      </div>
    </div>
  )
}
