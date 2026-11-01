/**
 * The top tab bar on wide (desktop / tablet; session-ux.md §wide, modeled on Termius).
 *
 * Left to right: the tab strip (tabs only), `+`, spacer, connection status dot, settings
 * (ADR-0037). Tab names are prefixed with `[n]`, like the drawer (ADR-0041). Tabs share
 * the width equally (120–240px, pure CSS, ADR-0031); when they don't fit, the strip
 * scrolls horizontally and the active tab is scrolled into view when it changes (no-op if
 * fully visible, no smooth scrolling). `+` is outside the strip so it stays visible, with
 * a non-clickable gap before it (ADR-0035). Switching tabs never changes terminal geometry.
 *
 * Drag to reorder (ADR-0040): with a mouse, press a tab and move > 5px; on touch,
 * long-press then move without lifting. Long-press and release in place opens the session
 * menu. The click that ends a drag is swallowed; `Esc` cancels.
 */
import { useLayoutEffect, useRef, useState } from 'preact/hooks'

import type { ConnState, StateInfo } from '../conn/connection'
import type { SessionView } from '../sessions/store'
import { CloseIcon, GearIcon, PinIcon, PlusIcon } from '../ui/icons'
import { PressTracker } from '../ui/longpress'
import { capturePointer } from '../ui/pointer'
import { DragReorder } from '../ui/reorder'
import { needsReveal } from '../ui/viewport'
import { connLabel } from './notices'
import { RenameInput } from './sessions'

export interface TopBarProps {
  sessions: SessionView[]
  conn: ConnState
  connInfo: StateInfo
  atLimit: boolean
  maxSessions: number
  renaming: number | null
  onSelect(sid: number): void
  onClose(sid: number): void
  onNew(): void
  onMenu(sid: number, x: number, y: number): void
  onRenameStart(sid: number): void
  onRename(sid: number, name: string): void
  onCancelRename(): void
  onSettings(): void
  /** Drag-to-reorder drop: move sid in front of `before` (null = to the end). */
  onMove(sid: number, before: number | null): void
}

/** A mouse press must move this far to become a drag; anything less is a click. */
const DRAG_START_PX = 5

interface TabPress {
  sid: number
  index: number
  x: number
  y: number
  touch: boolean
  /** Touch: the long-press fired; moving now starts a drag, releasing in place opens the menu. */
  armed: boolean
  drag: DragReorder | null
}

/**
 * Pressing anywhere on the top bar (tabs, `+`, the gap before it, ⚙) never steals focus:
 * focus stays in the terminal (or text page) so you can keep typing after switching. The
 * rename input is the exception. Installed on `.topbar`, so it covers bubbled events too.
 */
const keepFocus = (e: PointerEvent) => {
  if ((e.target as Element).closest('input')) return
  e.preventDefault()
}

export function TopBar(p: TopBarProps) {
  const stripRef = useRef<HTMLDivElement>(null)
  const press = useRef(new PressTracker()).current
  const active = p.sessions.find((s) => s.active)?.sid ?? null
  const tp = useRef<TabPress | null>(null)
  /** Swallow the click that follows a drag or a long-press menu. */
  const swallow = useRef(false)
  const [armed, setArmed] = useState<number | null>(null)
  const latest = useRef(p)
  latest.current = p

  const endPress = (cancel: boolean) => {
    const t = tp.current
    tp.current = null
    setArmed(null)
    if (!t) return
    if (t.drag) {
      const r = t.drag.finish(cancel)
      swallow.current = true
      if (r) latest.current.onMove(r.sid, r.before)
    } else if (t.armed && !cancel) {
      swallow.current = true
      latest.current.onMenu(t.sid, t.x, t.y)
    }
  }

  const startDrag = (t: TabPress, pointerId: number, el: HTMLElement) => {
    const strip = stripRef.current
    if (!strip) return
    capturePointer(el, pointerId)
    t.drag = new DragReorder({
      axis: 'x',
      scroller: strip,
      items: [...strip.querySelectorAll<HTMLElement>('.tab')],
      order: latest.current.sessions.map((s) => s.sid),
      from: t.index,
      start: t.x,
    })
  }

  useLayoutEffect(() => {
    // Esc during a drag cancels it and snaps back
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !tp.current?.drag) return
      e.preventDefault()
      e.stopPropagation()
      endPress(true)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  useLayoutEffect(() => {
    const strip = stripRef.current
    const el = strip?.querySelector<HTMLElement>(`[data-sid="${active}"]`)
    if (!strip || !el) return
    if (needsReveal(el.getBoundingClientRect(), strip.getBoundingClientRect())) {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [active, p.sessions.length])

  useLayoutEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    // The scrollbar is hidden, so a vertical mouse wheel scrolls the strip sideways (ADR-0031 §3).
    // Leave it alone when everything fits or the gesture is already horizontal (trackpad).
    const onWheel = (e: WheelEvent) => {
      if (strip.scrollWidth <= strip.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
      e.preventDefault()
      const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 40 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? strip.clientWidth : 1
      strip.scrollLeft += e.deltaY * unit
    }
    strip.addEventListener('wheel', onWheel, { passive: false })
    // After a touch long-press this touch belongs to the drag; keep the browser from scrolling the strip (or it cancels the pointer events)
    const onTouchMove = (e: TouchEvent) => {
      if (tp.current?.armed) e.preventDefault()
    }
    strip.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => {
      strip.removeEventListener('wheel', onWheel)
      strip.removeEventListener('touchmove', onTouchMove)
    }
  }, [])

  const rtt = p.connInfo.rttMs
  const dotTitle = p.conn === 'online' && rtt !== undefined && rtt > 300 ? `Online · ${rtt}ms` : connLabel(p.conn, p.connInfo)

  return (
    <div class="topbar" onPointerDown={keepFocus}>
      <div class="tabbar" data-testid="tabbar" role="tablist" aria-label="Sessions" ref={stripRef}>
        {p.sessions.map((s, index) => (
          <div
            key={s.sid}
            class="tab"
            data-armed={armed === s.sid ? 'true' : undefined}
            role="tab"
            tabIndex={0}
            data-testid={`tab-${s.sid}`}
            data-sid={s.sid}
            data-exited={s.status === 'exited' ? 'true' : 'false'}
            data-unread={s.unread ? 'true' : 'false'}
            aria-selected={s.active ? 'true' : 'false'}
            aria-current={s.active ? 'true' : undefined}
            title={s.cwd ? `${s.name}\n${s.cwd}` : s.name}
            onPointerDown={(e) => {
              if ((e.target as Element).closest('.tab-close, input')) return
              if (e.pointerType !== 'touch' && e.button !== 0) return
              if (tp.current) endPress(true) // The previous press never got a pointerup (released elsewhere)
              const { clientX: x, clientY: y } = e
              const t: TabPress = { sid: s.sid, index, x, y, touch: e.pointerType === 'touch', armed: false, drag: null }
              tp.current = t
              swallow.current = false
              if (t.touch) {
                // Long-press picks the tab up; on release we learn whether it was a menu (no move) or a drag
                press.down(x, y, () => {
                  if (tp.current !== t) return
                  t.armed = true
                  setArmed(s.sid)
                })
              }
            }}
            onPointerMove={(e) => {
              const t = tp.current
              if (!t || t.sid !== s.sid) return
              if (!t.touch && (e.buttons & 1) === 0) return endPress(true) // The mouse was already released elsewhere
              if (t.touch && !t.armed) {
                press.move(e.clientX, e.clientY)
                return
              }
              if (!t.drag) {
                if (Math.abs(e.clientX - t.x) <= DRAG_START_PX && Math.abs(e.clientY - t.y) <= DRAG_START_PX) return
                startDrag(t, e.pointerId, e.currentTarget as HTMLElement)
              }
              t.drag?.move(e.clientX)
            }}
            onPointerUp={() => {
              press.up()
              if (tp.current?.sid === s.sid) endPress(false)
            }}
            onPointerCancel={() => {
              press.cancel()
              if (tp.current?.sid === s.sid) endPress(true)
            }}
            onClick={() => {
              if (swallow.current) {
                swallow.current = false
                return
              }
              p.onSelect(s.sid)
            }}
            onAuxClick={(e) => {
              // Middle-click closes the tab
              if (e.button !== 1) return
              e.preventDefault()
              p.onClose(s.sid)
            }}
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault() // Keep middle-click from starting autoscroll
            }}
            onDblClick={() => p.onRenameStart(s.sid)}
            onContextMenu={(e) => {
              e.preventDefault()
              // Android fires contextmenu on touch long-press; the release decides instead (in place = menu, moved = drag)
              if (tp.current?.touch) return
              p.onMenu(s.sid, e.clientX, e.clientY)
            }}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                p.onSelect(s.sid)
              }
            }}
          >
            {/* The index tells same-named tabs apart, as in the drawer (ADR-0041) */}
            <span class="tab-idx" data-testid={`tab-${s.sid}-idx`}>
              [{s.index}]
            </span>
            {s.pinned && (
              <span class="pin-mark" role="img" aria-label="Pinned">
                <PinIcon size={12} />
              </span>
            )}
            {p.renaming === s.sid ? (
              <RenameInput initial={s.name} onCommit={(n) => p.onRename(s.sid, n)} onCancel={p.onCancelRename} />
            ) : (
              <span class="tab-name">{s.name}</span>
            )}
            {s.unread && <span class="unread-dot" data-testid={`tab-${s.sid}-unread`} aria-label="New output" />}
            <button
              class="tab-close"
              data-testid={`tab-${s.sid}-close`}
              tabIndex={-1}
              aria-label={`Close ${s.name}`}
              onPointerDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
              }}
              onClick={(e) => {
                e.stopPropagation()
                p.onClose(s.sid)
              }}
            >
              <CloseIcon size={12} />
            </button>
          </div>
        ))}
      </div>
      <button
        class="tab-new"
        data-testid="new-session"
        disabled={p.atLimit}
        aria-label="New session"
        title={p.atLimit ? `Session limit reached (${p.maxSessions})` : 'New session (Ctrl+Shift+Enter)'}
        onClick={p.onNew}
      >
        {/* An icon, not a `+` glyph: glyph position depends on font metrics and won't line up with the status dot (ADR-0035 §3) */}
        <PlusIcon />
      </button>
      <span class="conn-dot" data-testid="conn-dot" data-state={p.conn} title={dotTitle} aria-hidden="true" />
      <button class="topbar-btn" data-testid="open-settings" aria-label="Settings" title="Settings" onClick={p.onSettings}>
        <GearIcon />
      </button>
    </div>
  )
}
