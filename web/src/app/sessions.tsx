/**
 * Session list, row actions and menu (session-ux.md §Switching sessions).
 *
 * - `SessionList`: the compact drawer contents, one row per session
 *   (`[n] name  CWD / exit N  ≡`). Swipe a row left or long-press it to reveal
 *   Pin / Rename / Close (ADR-0039); the ≡ on the right drags to reorder (ADR-0040).
 * - `RenameSheet`: rename on compact, a small sheet over the drawer (ADR-0039 §2).
 * - `SessionMenu`: Rename · Pin · Close, from right-click / long-press on a wide tab.
 * - `RenameInput`: on wide the tab name turns into this input; `Enter` commits, `Esc` cancels.
 */
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks'

import type { SessionView } from '../sessions/store'
import { shortCwd } from '../sessions/store'
import { Drawer } from '../ui/drawer'
import { CheckIcon, GripIcon, PinIcon } from '../ui/icons'
import { capturePointer } from '../ui/pointer'
import { DragReorder } from '../ui/reorder'
import { useRowGestures } from '../ui/rowgestures'
import { ROW_ACTIONS_PX } from '../ui/rowswipe'
import { menuPosition } from '../ui/viewport'

export interface SessionListProps {
  sessions: SessionView[]
  /** The agent user's home directory (welcome.home), shown as `~` in CWDs. */
  home: string | null
  onSelect(sid: number): void
  onTogglePin(sid: number): void
  onRename(sid: number): void
  onClose(sid: number): void
  /** Drag-to-reorder drop: move sid in front of `before` (null = to the end). */
  onMove(sid: number, before: number | null): void
}

export function SessionList({ sessions, home, onSelect, onTogglePin, onRename, onClose, onMove }: SessionListProps) {
  /** Swipe / long-press opens a row; at most one at a time (ADR-0039 §1). */
  const rows = useRowGestures<number>(ROW_ACTIONS_PX)
  const openSid = rows.open
  const setOpenSid = rows.setOpen
  const grip = useRef<DragReorder | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const active = sessions.find((s) => s.active)?.sid ?? null

  useLayoutEffect(() => {
    // Keep the active row in view (AC-4.9); no-op if it is fully visible
    const el = listRef.current?.querySelector<HTMLElement>(`[data-sid="${active}"]`)
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])

  // The open row's session was closed elsewhere: forget it
  useEffect(() => {
    if (openSid !== null && !sessions.some((s) => s.sid === openSid)) setOpenSid(null)
  }, [sessions, openSid])

  // The list went away mid-drag (drawer closed): reset the offsets
  useEffect(() => () => void grip.current?.finish(true), [])

  const act = (fn: (sid: number) => void, sid: number) => rows.act(() => fn(sid))

  const onRowClick = (s: SessionView) => {
    if (rows.click()) onSelect(s.sid)
  }

  const onGripDown = (e: PointerEvent, index: number) => {
    e.preventDefault()
    e.stopPropagation()
    const list = listRef.current
    if (!list) return
    grip.current?.finish(true) // The previous drag never finished (its row disappeared mid-drag)
    setOpenSid(null)
    capturePointer(e.currentTarget as Element, e.pointerId)
    grip.current = new DragReorder({
      axis: 'y',
      scroller: list.closest<HTMLElement>('.drawer-body') ?? list,
      items: [...list.children] as HTMLElement[],
      order: sessions.map((s) => s.sid),
      from: index,
      start: e.clientY,
    })
  }

  const onGripUp = (cancel: boolean) => {
    const r = grip.current?.finish(cancel)
    grip.current = null
    if (r) onMove(r.sid, r.before)
  }

  return (
    <ul
      class="session-list"
      data-testid="session-list"
      ref={listRef}
      onPointerDownCapture={rows.onListPointerDown}
    >
      {sessions.map((s, i) => {
        const open = openSid === s.sid
        return (
          <li key={s.sid} class="sl-item" data-open={open ? 'true' : 'false'}>
            <div class="row-actions" aria-hidden={open ? undefined : 'true'}>
              <button
                type="button"
                class="row-act"
                data-act="pin"
                data-testid="row-pin"
                tabIndex={open ? 0 : -1}
                aria-pressed={s.pinned ? 'true' : 'false'}
                onClick={act(onTogglePin, s.sid)}
              >
                {s.pinned ? 'Unpin' : 'Pin'}
              </button>
              <button type="button" class="row-act" data-act="rename" data-testid="row-rename" tabIndex={open ? 0 : -1} onClick={act(onRename, s.sid)}>
                Rename
              </button>
              <button type="button" class="row-act" data-act="close" data-testid="row-close" tabIndex={open ? 0 : -1} onClick={act(onClose, s.sid)}>
                Close
              </button>
            </div>
            <div
              class="session-row"
              role="button"
              tabIndex={0}
              data-testid={`session-${s.sid}`}
              data-sid={s.sid}
              data-exited={s.status === 'exited' ? 'true' : 'false'}
              data-attention={s.attention ? 'true' : 'false'}
              aria-current={s.active ? 'true' : undefined}
              title={s.cwd}
              {...rows.row(s.sid)}
              onClick={() => onRowClick(s)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelect(s.sid)
                }
              }}
            >
              <span class="sl-idx">[{s.index}]</span>
              <span class="sl-name">
                {s.pinned && (
                  <span class="pin-mark" role="img" aria-label="Pinned">
                    <PinIcon size={12} />
                  </span>
                )}
                <span class="sl-text">{s.name}</span>
              </span>
              {s.attention && <span class="attention-dot" aria-label="Waiting for you" />}
              <span class="sl-meta" data-failed={s.status === 'exited' && s.exitCode !== 0 ? 'true' : 'false'}>
                {/* The outer rtl only truncates from the left; the path itself stays ltr so `~` and `/` don't jump to the right (ADR-0042 §3) */}
                <bdi dir="ltr">{s.status === 'exited' ? `exit ${s.exitCode ?? '?'}` : shortCwd(s.cwd, home)}</bdi>
              </span>
              <span
                class="row-grip"
                data-testid={`session-${s.sid}-grip`}
                aria-label="Drag to reorder"
                onPointerDown={(e) => onGripDown(e, i)}
                onPointerMove={(e) => grip.current?.move(e.clientY)}
                onPointerUp={() => onGripUp(false)}
                onPointerCancel={() => onGripUp(true)}
                onClick={(e) => e.stopPropagation()}
              >
                <GripIcon />
              </span>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export interface RenameSheetProps {
  name: string
  onCommit(name: string): void
  onCancel(): void
}

/**
 * Rename on compact (ADR-0039 §2): a small sheet over the drawer with a full-width input.
 * The sheet sits on top of the keyboard (.app is the sheets' containing block) with the
 * input at its top, so it is never covered. Blur does not cancel.
 */
export function RenameSheet({ name, onCommit, onCancel }: RenameSheetProps) {
  const ref = useRef<HTMLInputElement>(null)
  // Drawer's own layout effect runs first (children before parents) and pulls focus into the sheet; then move it to the input
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // Must use setAttribute: in Chrome autocorrect is a boolean IDL attribute (same as AC-3.10)
    el.setAttribute('autocorrect', 'off')
    el.setAttribute('autocapitalize', 'off')
    el.setAttribute('spellcheck', 'false')
    el.setAttribute('enterkeyhint', 'done')
    el.value = name
    el.focus({ preventScroll: true })
    el.select()
  }, [])
  const commit = () => onCommit(ref.current?.value ?? '')
  return (
    <Drawer
      title="Rename"
      testid="rename-sheet"
      backdropTestid="rename-backdrop"
      variant="rename"
      onClose={onCancel}
      foot={
        <div class="drawer-actions">
          <button type="button" class="drawer-btn" data-testid="rename-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" class="drawer-btn primary" data-testid="rename-ok" onClick={commit}>
            Save
          </button>
        </div>
      }
    >
      <div class="rename-field">
        <input
          ref={ref}
          class="rename-sheet-input"
          data-testid="rename-input"
          type="text"
          autocomplete="off"
          placeholder="Blank = directory name"
          aria-label="Session name (blank = directory name)"
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return
            e.preventDefault()
            commit()
          }}
        />
      </div>
    </Drawer>
  )
}

export interface RenameInputProps {
  initial: string
  onCommit(name: string): void
  onCancel(): void
}

/** Rename input. Empty restores the automatic CWD-based name; blur cancels. */
export function RenameInput({ initial, onCommit, onCancel }: RenameInputProps) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.value = initial
    el.focus({ preventScroll: true })
    el.select()
  }, [])
  const finish = (commit: boolean) => {
    if (done.current) return
    done.current = true
    if (commit) onCommit(ref.current?.value ?? '')
    else onCancel()
  }
  return (
    <input
      ref={ref}
      class="rename-input"
      data-testid="rename-input"
      data-esc-local
      type="text"
      placeholder="Blank = directory name"
      aria-label="Session name (blank = directory name)"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDblClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(false)
        }
      }}
      onBlur={() => finish(false)}
    />
  )
}

export interface SessionMenuProps {
  session: SessionView
  x: number
  y: number
  onRename(): void
  onTogglePin(): void
  onClose(): void
  onDismiss(): void
}

const MENU_SIZE = { width: 184, height: 152 }

/** Session menu: anchored next to where it was triggered; click outside or Esc closes it (not a sheet). */
export function SessionMenu({ session, x, y, onRename, onTogglePin, onClose, onDismiss }: SessionMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    const el = ref.current
    el?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
    return () => {
      // If focus is still in the menu, give it back (for a menu opened in the drawer, back to the drawer)
      if (prev && prev.isConnected && el?.contains(document.activeElement)) prev.focus({ preventScroll: true })
    }
  }, [])
  // Only honor pointers pressed after the menu appeared. Releasing the long-press that opened
  // the menu may synthesize a click: on the scrim it closes the menu instantly (seen with iPad
  // touch emulation), on the menu it hits the first item. Same for the contextmenu fired at
  // long-press time. Keyboard clicks (detail 0) are unaffected.
  const pressed = useRef(false)
  const onPress = () => {
    pressed.current = true
  }
  const fresh = (e: MouseEvent) => e.detail === 0 || pressed.current
  const pos = menuPosition(x, y, MENU_SIZE, window.innerWidth, window.innerHeight)
  return (
    <>
      <div
        class="menu-scrim"
        data-testid="session-menu-scrim"
        onPointerDown={onPress}
        onClick={(e) => fresh(e) && onDismiss()}
        onContextMenu={(e) => {
          e.preventDefault()
          if (pressed.current) onDismiss()
        }}
      />
      <div
        class="session-menu"
        data-testid="session-menu"
        data-sid={session.sid}
        data-esc-local
        role="menu"
        aria-label={`Session ${session.name}`}
        ref={ref}
        style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
        onPointerDown={onPress}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onDismiss()
          }
        }}
      >
        <button role="menuitem" data-testid="session-rename" onClick={(e) => fresh(e) && onRename()}>
          Rename
        </button>
        <button
          role="menuitemcheckbox"
          aria-checked={session.pinned ? 'true' : 'false'}
          data-testid="session-pin"
          onClick={(e) => fresh(e) && onTogglePin()}
        >
          <span>Pin</span>
          <span class="menu-check">{session.pinned && <CheckIcon size={12} />}</span>
        </button>
        <button role="menuitem" class="danger" data-testid="session-close" onClick={(e) => fresh(e) && onClose()}>
          Close
        </button>
      </div>
    </>
  )
}
