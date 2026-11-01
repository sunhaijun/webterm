/**
 * Drag to reorder (AC-4.13, ADR-0040): pure functions plus a small controller that only
 * moves DOM elements. The tab bar drags along x, the phone drawer along y.
 */

/**
 * Moves `sid` in front of `before` (protocol §4.1 session.move). `before` null or not in
 * the list → move to the end; equal to `sid` → no-op (matching the agent).
 */
export function moveBefore(order: readonly number[], sid: number, before: number | null): number[] {
  if (!order.includes(sid) || before === sid) return [...order]
  const rest = order.filter((x) => x !== sid)
  const i = before === null ? -1 : rest.indexOf(before)
  if (i < 0) return [...rest, sid]
  return [...rest.slice(0, i), sid, ...rest.slice(i)]
}

/** After moving the item at index `from` to index `to` (its index after the move), the sid it now precedes (null = last). */
export function beforeAt(order: readonly number[], from: number, to: number): number | null {
  const rest = order.filter((_, i) => i !== from)
  return rest[to] ?? null
}

/**
 * Drop index. `center` is the dragged item's center on the axis; `mids` are the midpoints
 * of all items in original order (including the dragged one). Crossing an item's midpoint
 * moves past it. Returns the dragged item's index after the move.
 */
export function dropIndex(mids: readonly number[], from: number, center: number): number {
  let to = from
  for (let i = from - 1; i >= 0 && center < mids[i]!; i--) to = i
  for (let i = from + 1; i < mids.length && center > mids[i]!; i++) to = i
  return to
}

/** How close (px) the pointer must be to the scroller's edge to start auto-scrolling. */
export const EDGE_PX = 32
/** Auto-scroll speed: at most this many px per frame, faster closer to the edge. */
export const EDGE_SPEED = 12

/** Pointer position within [lo, hi] → how far to scroll this frame (negative = toward the start). */
export function edgeScroll(pos: number, lo: number, hi: number): number {
  if (pos < lo + EDGE_PX) return -Math.ceil(EDGE_SPEED * Math.min(1, (lo + EDGE_PX - pos) / EDGE_PX))
  if (pos > hi - EDGE_PX) return Math.ceil(EDGE_SPEED * Math.min(1, (pos - (hi - EDGE_PX)) / EDGE_PX))
  return 0
}

export interface DragOptions {
  axis: 'x' | 'y'
  /** The scrolling container (tab strip / drawer body). */
  scroller: HTMLElement
  /** The items being reordered, in current order. */
  items: HTMLElement[]
  /** Sids of the items when the drag started, matching items one to one (used even if the list changes mid-drag). */
  order: readonly number[]
  /** Index of the dragged item in items. */
  from: number
  /** Pointer position on the axis at press time (client coordinates). */
  start: number
}

/**
 * One drag: the dragged item follows the pointer and the others make room (transforms
 * only, no DOM changes), auto-scrolling near the edges. `finish()` clears all offsets and
 * returns the session.move to send if the position changed, else null.
 */
export class DragReorder {
  private readonly o: DragOptions
  private readonly size: number
  private readonly mids: number[]
  private readonly scroll0: number
  private pos: number
  private to: number
  private raf = 0

  constructor(o: DragOptions) {
    this.o = o
    const r = (el: HTMLElement) => el.getBoundingClientRect()
    const lo = (b: DOMRect) => (o.axis === 'x' ? b.left : b.top)
    const len = (b: DOMRect) => (o.axis === 'x' ? b.width : b.height)
    const rects = o.items.map(r)
    this.mids = rects.map((b) => lo(b) + len(b) / 2)
    // Others shift by the dragged item's size (items have no gaps between them)
    this.size = len(rects[o.from]!)
    this.scroll0 = this.scrollPos()
    this.pos = o.start
    this.to = o.from
    o.items[o.from]!.dataset.dragging = 'true'
    o.scroller.dataset.reordering = 'true'
  }

  private scrollPos(): number {
    return this.o.axis === 'x' ? this.o.scroller.scrollLeft : this.o.scroller.scrollTop
  }

  move(pos: number): void {
    this.pos = pos
    this.layout()
    if (!this.raf) this.raf = requestAnimationFrame(() => this.tick())
  }

  private tick(): void {
    this.raf = 0
    const b = this.o.scroller.getBoundingClientRect()
    const [lo, hi] = this.o.axis === 'x' ? [b.left, b.right] : [b.top, b.bottom]
    const d = edgeScroll(this.pos, lo, hi)
    if (d === 0) return
    const before = this.scrollPos()
    if (this.o.axis === 'x') this.o.scroller.scrollLeft += d
    else this.o.scroller.scrollTop += d
    if (this.scrollPos() !== before) this.layout()
    this.raf = requestAnimationFrame(() => this.tick())
  }

  private layout(): void {
    const { axis, items, from } = this.o
    const scrolled = this.scrollPos() - this.scroll0
    const delta = this.pos - this.o.start + scrolled
    this.to = dropIndex(this.mids, from, this.mids[from]! + delta)
    const t = (px: number) => (px === 0 ? '' : axis === 'x' ? `translateX(${px}px)` : `translateY(${px}px)`)
    items.forEach((el, i) => {
      if (i === from) el.style.transform = t(delta)
      else if (from < i && i <= this.to) el.style.transform = t(-this.size)
      else if (this.to <= i && i < from) el.style.transform = t(this.size)
      else el.style.transform = ''
    })
  }

  /** Release (or cancel): clears offsets; returns `{sid, before}` for session.move if the position changed, else null. */
  finish(cancel = false): { sid: number; before: number | null } | null {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    for (const el of this.o.items) el.style.transform = ''
    delete this.o.items[this.o.from]!.dataset.dragging
    delete this.o.scroller.dataset.reordering
    const { order, from } = this.o
    if (cancel || this.to === from) return null
    return { sid: order[from]!, before: beforeAt(order, from, this.to) }
  }
}
