/**
 * Classifies a press as tap, long-press or drag. Used by CTRL / ALT locking on the extra
 * keys, long-press on drawer rows (reveals the buttons) and long-press on tabs (menu /
 * drag) (ADR-0025 §2, ADR-0039, ADR-0040).
 *
 * A pure state machine with an injectable timer for unit tests. Components keep it in a
 * useRef because one press spans several renders.
 */

/** Long-press threshold. */
export const LONG_PRESS_MS = 500
/** Moving farther than this makes it a drag, neither tap nor long-press. */
export const TAP_SLOP_PX = 10

export type PressResult = 'tap' | 'long' | 'none'

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export class PressTracker {
  private x0 = 0
  private y0 = 0
  private timer: unknown = undefined
  private active = false
  private moved = false
  private fired = false
  private readonly ms: number
  private readonly timers: Timers

  constructor(ms = LONG_PRESS_MS, timers: Timers = realTimers) {
    this.ms = ms
    this.timers = timers
  }

  /** Press. `onLong` fires once the threshold passes without a drag (the finger is still down, so feedback is immediate). */
  down(x: number, y: number, onLong: () => void): void {
    this.cancel()
    this.active = true
    this.moved = false
    this.fired = false
    this.x0 = x
    this.y0 = y
    this.timer = this.timers.set(() => {
      this.timer = undefined
      if (!this.active || this.moved) return
      this.fired = true
      onLong()
    }, this.ms)
  }

  move(x: number, y: number): void {
    if (!this.active || this.moved) return
    if (Math.hypot(x - this.x0, y - this.y0) >= TAP_SLOP_PX) {
      this.moved = true
      this.clearTimer()
    }
  }

  /** Release: was it a tap, a long-press or a drag. */
  up(): PressResult {
    if (!this.active) return 'none'
    this.active = false
    this.clearTimer()
    if (this.fired) return 'long'
    return this.moved ? 'none' : 'tap'
  }

  cancel(): void {
    this.active = false
    this.clearTimer()
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer)
    this.timer = undefined
  }
}
