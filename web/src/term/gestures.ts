/**
 * Touch gestures on the terminal (ADR-0025 §5, input.md, AC-3.20).
 *
 * Tap:
 *   - the foreground program enabled mouse tracking → do nothing and leave it to xterm
 *     (the browser synthesizes mouse events and xterm reports the click in the program's
 *     protocol);
 *   - otherwise → toggle the on-screen keyboard: blur if the terminal has focus, else
 *     focus. iOS only shows the keyboard from inside a user gesture, so this runs in
 *     touchend.
 *
 * Vertical drag: xterm's own touch scrolling without mouse tracking; with it,
 * installDragWheel turns the drag into wheel events (ADR-0029 / 0032), since xterm 5.5
 * ignores touch while mouse tracking. Horizontal drags do nothing.
 */

/** A tap moves < 10px and lasts < 300ms. */
export const TAP_MAX_MOVE = 10
export const TAP_MAX_MS = 300

export interface TouchPoint {
  x: number
  y: number
  t: number
}

/** Whether a touch is a tap. `maxMove` is the farthest distance from the start during the touch. */
export function isTap(start: TouchPoint, end: TouchPoint, maxMove: number): boolean {
  return maxMove < TAP_MAX_MOVE && end.t - start.t < TAP_MAX_MS
}

export interface TapTarget {
  /** The foreground program enabled mouse tracking. */
  mouseTracking(): boolean
  /** Whether the terminal (xterm's helper textarea) has focus. */
  focused(): boolean
  focus(): void
  blur(): void
}

/** Installs tap-to-toggle-keyboard on the terminal container. `target()` returns the active session's terminal, or null. */
export function installTapToggle(el: HTMLElement, target: () => TapTarget | null): () => void {
  let start: TouchPoint | null = null
  let maxMove = 0

  const onStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) {
      start = null
      return
    }
    const p = e.touches[0]!
    start = { x: p.clientX, y: p.clientY, t: e.timeStamp }
    maxMove = 0
  }
  const onMove = (e: TouchEvent) => {
    if (!start) return
    if (e.touches.length !== 1) {
      start = null
      return
    }
    const p = e.touches[0]!
    maxMove = Math.max(maxMove, Math.hypot(p.clientX - start.x, p.clientY - start.y))
  }
  const onEnd = (e: TouchEvent) => {
    const s = start
    start = null
    if (!s || e.changedTouches.length !== 1) return
    const p = e.changedTouches[0]!
    const end = { x: p.clientX, y: p.clientY, t: e.timeStamp }
    const move = Math.max(maxMove, Math.hypot(end.x - s.x, end.y - s.y))
    if (!isTap(s, end, move)) return
    const t = target()
    if (!t || t.mouseTracking()) return // Leave it to xterm: the synthesized mousedown reports the click
    // Stop the browser from synthesizing mousedown / click: xterm's mousedown always calls
    // focus(), which would bring back the keyboard we just hid
    if (e.cancelable) e.preventDefault()
    if (t.focused()) t.blur()
    else t.focus()
  }
  const onCancel = () => {
    start = null
  }

  el.addEventListener('touchstart', onStart, { passive: true })
  el.addEventListener('touchmove', onMove, { passive: true })
  el.addEventListener('touchend', onEnd, { passive: false })
  el.addEventListener('touchcancel', onCancel)
  return () => {
    el.removeEventListener('touchstart', onStart)
    el.removeEventListener('touchmove', onMove)
    el.removeEventListener('touchend', onEnd)
    el.removeEventListener('touchcancel', onCancel)
  }
}

// ---------- Vertical drag to wheel (ADR-0029 / ADR-0032, input.md, AC-3.21) ----------

/** Max wheel events per touchmove. Browsers coalesce touchmove to one per frame, so this is roughly a per-frame cap. */
export const WHEEL_MAX_PER_MOVE = 3

/** Accumulates vertical finger movement in row heights and converts it to wheel steps. */
export class DragWheel {
  private rest = 0

  /**
   * Feeds this frame's vertical movement (px, finger down is positive) and returns the
   * number of wheel steps: positive = scroll up (toward older output). Whole rows beyond
   * the cap are dropped rather than carried over, or scrolling would continue after release.
   */
  feed(dy: number, rowPx: number): number {
    this.rest += dy
    const n = Math.trunc(this.rest / rowPx) || 0 // trunc of a negative sub-row offset yields -0
    this.rest -= n * rowPx
    return Math.max(-WHEEL_MAX_PER_MOVE, Math.min(WHEEL_MAX_PER_MOVE, n))
  }

  reset(): void {
    this.rest = 0
  }
}

export interface WheelTarget {
  /** The foreground program enabled mouse tracking. */
  mouseTracking(): boolean
  /** Row height in px. */
  rowHeight(): number
  /** Dispatches one wheel step at viewport coordinates (x, y); up = scroll up. */
  wheel(up: boolean, x: number, y: number): void
}

/**
 * Installs "vertical drag = wheel while mouse tracking" on the terminal container: one
 * wheel step per row height of finger movement (ADR-0032). How far each step scrolls is
 * up to the program (tmux: 5 lines); no calibration, no round trips. It becomes a drag
 * once it moves 10px (the tap threshold) mostly vertically, counting from the start point;
 * while converting, preventDefault stops the browser from scrolling natively too. Without
 * mouse tracking it does nothing and xterm's touch scrolling applies.
 */
export function installDragWheel(el: HTMLElement, target: () => WheelTarget | null): () => void {
  let start: { x: number; y: number } | null = null
  let lastY = 0
  let dragging = false
  const acc = new DragWheel()

  const onStart = (e: TouchEvent) => {
    start = null
    if (e.touches.length !== 1) return
    const p = e.touches[0]!
    start = { x: p.clientX, y: p.clientY }
    lastY = p.clientY
    dragging = false
    acc.reset()
  }
  const onMove = (e: TouchEvent) => {
    if (!start) return
    if (e.touches.length !== 1) {
      start = null
      return
    }
    const t = target()
    if (!t || !t.mouseTracking()) return
    const p = e.touches[0]!
    if (!dragging) {
      const dx = p.clientX - start.x
      const dy = p.clientY - start.y
      if (Math.hypot(dx, dy) < TAP_MAX_MOVE) return // May still be a tap
      if (Math.abs(dy) <= Math.abs(dx)) {
        start = null // Horizontal drag: ignore
        return
      }
      dragging = true
    }
    if (e.cancelable) e.preventDefault()
    const n = acc.feed(p.clientY - lastY, t.rowHeight())
    lastY = p.clientY
    for (let i = 0; i < Math.abs(n); i++) t.wheel(n > 0, p.clientX, p.clientY)
  }
  const onEnd = () => {
    start = null
  }

  el.addEventListener('touchstart', onStart, { passive: true })
  el.addEventListener('touchmove', onMove, { passive: false })
  el.addEventListener('touchend', onEnd)
  el.addEventListener('touchcancel', onEnd)
  return () => {
    el.removeEventListener('touchstart', onStart)
    el.removeEventListener('touchmove', onMove)
    el.removeEventListener('touchend', onEnd)
    el.removeEventListener('touchcancel', onEnd)
  }
}
