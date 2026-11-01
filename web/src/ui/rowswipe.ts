/**
 * Swipe-left on a phone drawer row (AC-4.12, ADR-0039): a pure state machine; the
 * component just writes the offset into a transform.
 */

/** Total width of the three buttons (72px each). */
export const ROW_ACTIONS_PX = 216
/** A swipe needs more than this much mostly-horizontal movement (otherwise it is a tap, long-press or vertical scroll). */
export const ROW_SWIPE_SLOP_PX = 10

export class RowSwipe {
  private x0 = 0
  private y0 = 0
  private base = 0
  private offset = 0
  /** null = direction not decided; true = horizontal, ours; false = vertical, ignored. */
  private horizontal: boolean | null = null

  /** Press. `open`: whether the row is currently open. */
  start(x: number, y: number, open: boolean): void {
    this.x0 = x
    this.y0 = y
    this.base = open ? -ROW_ACTIONS_PX : 0
    this.offset = this.base
    this.horizontal = null
  }

  /** Move: returns the current offset (0 to −216) once the swipe is ours, else null. */
  move(x: number, y: number): number | null {
    const dx = x - this.x0
    const dy = y - this.y0
    if (this.horizontal === null) {
      if (Math.abs(dx) <= ROW_SWIPE_SLOP_PX && Math.abs(dy) <= ROW_SWIPE_SLOP_PX) return null
      this.horizontal = Math.abs(dx) > Math.abs(dy)
    }
    if (!this.horizontal) return null
    this.offset = Math.max(-ROW_ACTIONS_PX, Math.min(0, this.base + dx))
    return this.offset
  }

  /** Release: if the swipe was ours, returns whether the row rests open or closed (past halfway = open), else null. */
  end(): 'open' | 'closed' | null {
    const took = this.horizontal === true
    this.horizontal = null
    if (!took) return null
    return this.offset < -ROW_ACTIONS_PX / 2 ? 'open' : 'closed'
  }
}
