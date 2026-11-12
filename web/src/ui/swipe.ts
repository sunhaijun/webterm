/**
 * Dragging a bottom sheet (native-style): down to close, and for the file browser's sheets
 * also up to full height and back (ADR-0066 §1).
 *
 * Attach to the sheet container. The grab handle and the header always drag the sheet; the
 * body drags it down only once it is scrolled to the top (otherwise it fights list scrolling),
 * and never up (that is scrolling). The sheet follows the finger; on release `settle` decides
 * where it goes. Touch only. `enabled`: whether to take the gesture right now (centered
 * dialogs don't, ADR-0037 §4).
 */

/** Released this many px below its resting height, the sheet closes. */
export const CLOSE_PX = 90
/** Released this many px toward its other height, a two-height sheet goes there. */
export const SNAP_PX = 48
/** A two-height sheet's lower height, as a fraction of the visible area (style.css: the file sheets' 80%). */
export const REST = 0.8

export type Landing = 'close' | 'rest' | 'full'

/**
 * Where a released sheet goes. `h`: the height the finger left it at (below `rest` it has slid
 * down by the difference); `rest` and `full`: its two heights (equal for a one-height sheet);
 * `wasFull`: whether the drag started at full height.
 */
export function settle(h: number, rest: number, full: number, wasFull: boolean): Landing {
  if (rest - h > CLOSE_PX) return 'close'
  if (full <= rest) return 'rest'
  if (wasFull) return full - h > SNAP_PX ? 'rest' : 'full'
  return h - rest > SNAP_PX ? 'full' : 'rest'
}

export interface SheetDrag {
  enabled(): boolean
  onDismiss(): void
  /** The second height, if the sheet has one (the file browser's maximize state, ADR-0060 §1). */
  max?(): { on: boolean; toggle(): void } | undefined
}

export function installSheetDrag(host: HTMLElement, opts: SheetDrag): () => void {
  let startX = 0
  let startY = 0
  let dy = 0
  /** A touch that may become ours. */
  let tracking = false
  /** The direction is decided and the sheet follows the finger. */
  let moving = false
  /** The touch started on the grab handle or the header (or the sheet's own padding around them). */
  let chrome = false
  let two = false
  let wasFull = false
  let h0 = 0
  let rest = 0
  let full = 0
  let timer = 0

  const atTop = () => (host.querySelector<HTMLElement>('.drawer-body')?.scrollTop ?? 0) <= 0
  const reset = () => {
    host.style.transition = ''
    host.style.transform = ''
    host.style.height = ''
    host.style.maxHeight = ''
  }
  /** Shows the sheet at height `h`: a two-height sheet grows up to `full`; below `rest` any sheet slides down. */
  const show = (h: number) => {
    if (two) host.style.height = `${Math.round(Math.min(Math.max(h, rest), full))}px`
    host.style.transform = h < rest ? `translateY(${rest - h}px)` : ''
  }

  const onStart = (e: TouchEvent) => {
    // A second finger while the sheet follows the first changes nothing; lifting one settles it
    if (moving) return
    tracking = false
    if (e.touches.length !== 1) return
    const t = e.target as Element
    // A press on a row's drag handle reorders; it doesn't move the sheet (ADR-0040)
    if (!opts.enabled() || t.closest?.('.row-grip')) return
    tracking = true
    chrome = t === host || !!t.closest?.('.drawer-grab, .drawer-head')
    startX = e.touches[0]!.clientX
    startY = e.touches[0]!.clientY
    dy = 0
  }
  const onMove = (e: TouchEvent) => {
    if (!tracking || e.touches.length !== 1) return
    dy = e.touches[0]!.clientY - startY
    if (!moving) {
      const dx = e.touches[0]!.clientX - startX
      if (Math.abs(dx) + Math.abs(dy) < 6) return
      const max = opts.max?.()
      two = max !== undefined
      wasFull = max?.on ?? false
      const up = dy < 0
      // Sideways is a row swipe (ADR-0039) or the path scrolling; up is scrolling unless the
      // handle or header pulls a two-height sheet that isn't full yet; down on the body only from the top
      if (Math.abs(dx) > Math.abs(dy) || (up && !(chrome && two && !wasFull)) || (!up && !chrome && !atTop())) {
        tracking = false
        return
      }
      moving = true
      clearTimeout(timer)
      h0 = host.getBoundingClientRect().height
      full = two ? (host.parentElement?.clientHeight ?? h0) : h0
      rest = two ? Math.round(full * REST) : h0
      host.style.transition = 'none'
      if (two) host.style.maxHeight = 'none'
    }
    show(h0 - dy)
    e.preventDefault()
  }
  const onEnd = () => {
    if (!tracking) return
    tracking = false
    if (!moving) return
    moving = false
    const to = settle(h0 - dy, rest, full, wasFull)
    host.style.transition = 'height 160ms ease, transform 160ms ease'
    if (to === 'close') {
      host.style.transform = 'translateY(100%)'
      setTimeout(opts.onDismiss, 140)
      return
    }
    show(to === 'full' ? full : rest)
    const max = opts.max?.()
    if (max && max.on !== (to === 'full')) max.toggle()
    // Once it is there, CSS holds the height again (80% or 100%, the same value)
    timer = window.setTimeout(reset, 180)
  }

  host.addEventListener('touchstart', onStart, { passive: true })
  host.addEventListener('touchmove', onMove, { passive: false })
  host.addEventListener('touchend', onEnd)
  host.addEventListener('touchcancel', onEnd)
  return () => {
    clearTimeout(timer)
    host.removeEventListener('touchstart', onStart)
    host.removeEventListener('touchmove', onMove)
    host.removeEventListener('touchend', onEnd)
    host.removeEventListener('touchcancel', onEnd)
  }
}
