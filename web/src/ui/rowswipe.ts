/**
 * Swipe-left on a phone drawer row (AC-4.12, ADR-0039): a pure state machine; the
 * component just writes the offset into a transform.
 */

/** One row button's width. */
export const ROW_ACT_PX = 72
/** Total width of the session rows' three buttons. */
export const ROW_ACTIONS_PX = 3 * ROW_ACT_PX
/** A swipe needs more than this much mostly-horizontal movement (otherwise it is a tap, long-press or vertical scroll). */
export const ROW_SWIPE_SLOP_PX = 10

export class RowSwipe {
  private x0 = 0
  private y0 = 0
  private base = 0
  private offset = 0
  /** null = direction not decided; true = horizontal, ours; false = vertical, ignored. */
  private horizontal: boolean | null = null

  /** `width`: the buttons' total width (the session drawer's three, ADR-0039; the file list's two, ADR-0059). */
  constructor(private readonly width = ROW_ACTIONS_PX) {}

  /** Press. `open`: whether the row is currently open. */
  start(x: number, y: number, open: boolean): void {
    this.x0 = x
    this.y0 = y
    this.base = open ? -this.width : 0
    this.offset = this.base
    this.horizontal = null
  }

  /** Move: returns the current offset (0 to −width) once the swipe is ours, else null. */
  move(x: number, y: number): number | null {
    const dx = x - this.x0
    const dy = y - this.y0
    if (this.horizontal === null) {
      if (Math.abs(dx) <= ROW_SWIPE_SLOP_PX && Math.abs(dy) <= ROW_SWIPE_SLOP_PX) return null
      this.horizontal = Math.abs(dx) > Math.abs(dy)
    }
    if (!this.horizontal) return null
    this.offset = Math.max(-this.width, Math.min(0, this.base + dx))
    return this.offset
  }

  /** Release: if the swipe was ours, returns whether the row rests open or closed (past halfway = open), else null. */
  end(): 'open' | 'closed' | null {
    const took = this.horizontal === true
    this.horizontal = null
    if (!took) return null
    return this.offset < -this.width / 2 ? 'open' : 'closed'
  }
}
