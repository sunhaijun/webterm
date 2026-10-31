/**
 * 按下 → 判「点一下 / 长按 / 拖走了」。附加键的 CTRL / ALT 锁定、会话行与标签的
 * 会话菜单都用它（ADR-0025 §2 / §4）。
 *
 * 纯状态机，计时器可注入，便于单测。组件把它放在 useRef 里：一次按压跨越多次渲染。
 */

/** 长按的门槛。 */
export const LONG_PRESS_MS = 500
/** 移动超过这么多就不算「点」也不算「长按」，是拖动。 */
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
  private swallowClick = false
  private readonly ms: number
  private readonly timers: Timers

  constructor(ms = LONG_PRESS_MS, timers: Timers = realTimers) {
    this.ms = ms
    this.timers = timers
  }

  /** 按下。`onLong` 在按满门槛且没拖动时触发（手指还没抬起，反馈要立刻给）。 */
  down(x: number, y: number, onLong: () => void): void {
    this.cancel()
    this.active = true
    this.moved = false
    this.fired = false
    this.swallowClick = false
    this.x0 = x
    this.y0 = y
    this.timer = this.timers.set(() => {
      this.timer = undefined
      if (!this.active || this.moved) return
      this.fired = true
      this.swallowClick = true
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

  /** 抬起：这一下是点、长按、还是拖走了。 */
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

  /**
   * 长按之后浏览器还会补一个 click —— 在 onClick 里先问这一句，是就吞掉。
   * 一次性：问过就清。
   */
  takeSwallowedClick(): boolean {
    const v = this.swallowClick
    this.swallowClick = false
    return v
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer)
    this.timer = undefined
  }
}
