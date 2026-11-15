/**
 * Swiping sideways on the terminal switches sessions (AC-4.15, ADR-0067,
 * session-ux.md §Swiping on the terminal).
 *
 * The decisions are pure functions below; installSessionSwipe wires them to the terminal
 * container's touch events. It listens in the capture phase: until a touch has travelled
 * 10px everything passes through as usual (taps, xterm's scrolling, drag-to-wheel), and once
 * a touch is a swipe its moves and its release stop at the container, so xterm doesn't
 * scroll, no wheel events or mouse reports go out, the keyboard doesn't toggle, and
 * preventDefault keeps the browser from synthesizing a click.
 */
import { EDGE_PX, SWIPE_PX } from '../keys/collapse'
import { TAP_MAX_MOVE } from './gestures'

export { EDGE_PX }
/** The axis is decided once the finger has moved this far (the tap threshold). */
export const LOCK_PX = TAP_MAX_MOVE
/** A swipe must be at least this many times as wide as it is tall when decided (about 27°). */
export const AXIS_RATIO = 2
/** Releasing switches after this fraction of the terminal's width… */
export const SWITCH_FRACTION = 0.25
/** …but never needs more than this. */
export const SWITCH_MAX_PX = 160
/** A flick switches from this travel on (the extra keys' swipe threshold)… */
export const FLICK_PX = SWIPE_PX
/** …at this speed, px/ms, in the swipe's direction. */
export const FLICK_SPEED = 0.5
/** Far enough, but heading back this fast (px/ms) at release: changed your mind. */
export const BACK_SPEED = 0.3
/** Speed is measured over this last stretch of the touch. */
export const SPEED_WINDOW_MS = 100
export const SLIDE_IN_MS = 200
export const SLIDE_BACK_MS = 180
const EASE_OUT = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

/**
 * Whether a touch at (x, y) may become a swipe: away from both screen edges (the system's
 * Back / Forward), and above the restore band while the extra keys are collapsed (bandTop,
 * else null).
 */
export function canStartSwipe(x: number, y: number, viewportWidth: number, bandTop: number | null): boolean {
  if (x < EDGE_PX || x > viewportWidth - EDGE_PX) return false
  return bandTop === null || y < bandTop
}

export type Axis = 'pending' | 'swipe' | 'other'

/** Decided once, at LOCK_PX of travel: a swipe only if clearly horizontal; never revisited. */
export function lockAxis(dx: number, dy: number): Axis {
  if (Math.hypot(dx, dy) < LOCK_PX) return 'pending'
  return Math.abs(dx) >= AXIS_RATIO * Math.abs(dy) ? 'swipe' : 'other'
}

/** The travel at which releasing switches. */
export function switchDistance(width: number): number {
  return Math.min(width * SWITCH_FRACTION, SWITCH_MAX_PX)
}

/**
 * Whether releasing switches. dx / dy: travel from the touch's start; speed: px/ms along x
 * over the last SPEED_WINDOW_MS (positive = rightward), or null when unknown.
 */
export function releaseSwitches(dx: number, dy: number, speed: number | null, width: number): boolean {
  const ax = Math.abs(dx)
  if (ax === 0 || ax <= Math.abs(dy)) return false
  const onward = speed === null ? 0 : speed * Math.sign(dx) // > 0: still moving away from the start
  if (ax >= FLICK_PX && onward >= FLICK_SPEED) return true
  return ax >= switchDistance(width) && onward > -BACK_SPEED
}

/** How far the terminal moves when there is no session on that side: iOS's rubber band. */
export function rubberBand(d: number, width: number): number {
  if (d === 0 || width <= 0) return 0
  return Math.sign(d) * (1 - 1 / ((0.55 * Math.abs(d)) / width + 1)) * width
}

/** Horizontal speed over the last SPEED_WINDOW_MS of a touch. */
export class SpeedTracker {
  private samples: { x: number; t: number }[] = []

  add(x: number, t: number): void {
    this.samples.push({ x, t })
    const cut = t - SPEED_WINDOW_MS
    while (this.samples.length > 1 && this.samples[0]!.t < cut) this.samples.shift()
  }

  /** px/ms, or null with fewer than two samples in the window or no time between them. */
  speed(): number | null {
    const a = this.samples[0]
    const b = this.samples.at(-1)
    if (!a || !b || a === b || b.t <= a.t) return null
    return (b.x - a.x) / (b.t - a.t)
  }

  reset(): void {
    this.samples = []
  }
}

export interface SwipeNeighbour {
  sid: number
  /** `[n]`, as in the tabs and the drawer. */
  index: number
  name: string
  attention: boolean
}

/** The label in the gap: which side it is on, how far along, and whether releasing would switch. */
export interface Peek extends SwipeNeighbour {
  side: 'left' | 'right'
  /** 0–1: travel over the switching distance. */
  progress: number
  ready: boolean
}

export interface SwipeTarget {
  /** The active session's neighbour: +1 next (finger left), -1 previous; null at the ends. */
  neighbour(dir: 1 | -1): SwipeNeighbour | null
  /** The active session's host element, which moves with the finger. */
  host(): HTMLElement | null
  /** The terminal's width. */
  width(): number
  viewportWidth(): number
  /** While the extra keys are collapsed, the restore band's top (viewport y); else null. */
  bandTop(): number | null
  reducedMotion(): boolean
  /** Shows, updates or (null) hides the label in the gap. */
  peek(p: Peek | null): void
  /** Switches; called inside touchend so focus can follow (iOS keyboard). */
  switchTo(sid: number): void
}

interface Gesture {
  x: number
  y: number
  axis: Axis
  /** dx when the swipe was recognized: the terminal follows from there. */
  lockDx: number
  host: HTMLElement | null
  /** Where the host is now. */
  offset: number
}

/** Installs the session swipe on the terminal container. Returns the uninstaller. */
export function installSessionSwipe(el: HTMLElement, target: SwipeTarget): () => void {
  let g: Gesture | null = null
  /** The slide in flight, if any. */
  let moving: { host: HTMLElement; anim: Animation } | null = null
  const speed = new SpeedTracker()

  /** Ends a slide at once, at its resting place. */
  const stop = () => {
    const m = moving
    moving = null
    if (!m) return
    m.anim.cancel()
    delete m.host.dataset.swiping
  }

  /**
   * The host comes to rest at no transform, animating from `from` unless motion is reduced.
   * While it moves it has data-swiping, which draws its edges and dims the gap (style.css).
   */
  const settle = (host: HTMLElement | null, from: number, ms: number) => {
    if (!host) return
    host.style.transform = ''
    if (from === 0 || target.reducedMotion() || typeof host.animate !== 'function') {
      delete host.dataset.swiping
      return
    }
    host.dataset.swiping = 'true'
    const a = host.animate([{ transform: `translateX(${from}px)` }, { transform: 'translateX(0px)' }], { duration: ms, easing: EASE_OUT })
    const m = { host, anim: a }
    moving = m
    a.onfinish = () => {
      if (moving !== m) return
      moving = null
      delete host.dataset.swiping
    }
  }

  /** A swipe that won't switch: label away, terminal back. */
  const abort = (cur: Gesture) => {
    if (cur.axis !== 'swipe') return
    target.peek(null)
    settle(cur.host, cur.offset, SLIDE_BACK_MS)
  }

  const follow = (cur: Gesture, dx: number, dy: number) => {
    const d = dx - cur.lockDx
    const dir: 1 | -1 = d < 0 ? 1 : -1
    const nb = d === 0 ? null : target.neighbour(dir)
    const w = target.width()
    cur.offset = nb ? d : rubberBand(d, w)
    if (cur.host && !target.reducedMotion()) {
      cur.host.style.transform = `translateX(${cur.offset}px)`
      cur.host.dataset.swiping = 'true'
    }
    if (!nb) {
      target.peek(null)
      return
    }
    const dist = switchDistance(w)
    const ax = Math.abs(dx)
    target.peek({
      sid: nb.sid,
      index: nb.index,
      name: nb.name,
      attention: nb.attention,
      side: dir === 1 ? 'right' : 'left',
      progress: Math.min(1, ax / dist),
      ready: Math.sign(dx) === -dir && ax >= dist && ax > Math.abs(dy),
    })
  }

  const onStart = (e: TouchEvent) => {
    stop()
    if (g && e.touches.length > 1) abort(g) // A second finger cancels a swipe under way
    else if (g?.axis === 'swipe') {
      // A new touch while a swipe never ended: its touchend went to a node that was detached
      // meanwhile (the session closed elsewhere) and never reached us. Clean up, no animation.
      target.peek(null)
      if (g.host) {
        g.host.style.transform = ''
        delete g.host.dataset.swiping
      }
    }
    g = null
    const t = e.touches[0]
    if (e.touches.length !== 1 || !t) return
    if (!canStartSwipe(t.clientX, t.clientY, target.viewportWidth(), target.bandTop())) return
    g = { x: t.clientX, y: t.clientY, axis: 'pending', lockDx: 0, host: null, offset: 0 }
    speed.reset()
    speed.add(t.clientX, e.timeStamp)
  }

  const onMove = (e: TouchEvent) => {
    const cur = g
    if (!cur) return
    const t = e.touches[0]
    if (e.touches.length !== 1 || !t) {
      abort(cur)
      g = null
      return
    }
    speed.add(t.clientX, e.timeStamp)
    const dx = t.clientX - cur.x
    const dy = t.clientY - cur.y
    if (cur.axis === 'pending') {
      cur.axis = lockAxis(dx, dy)
      if (cur.axis === 'pending') return
      cur.host = cur.axis === 'swipe' ? target.host() : null
      if (!cur.host) {
        g = null // Not a swipe (or nothing to move): leave the whole touch to the other gestures
        return
      }
      cur.lockDx = dx
    }
    e.stopPropagation()
    if (e.cancelable) e.preventDefault()
    follow(cur, dx, dy)
  }

  const onEnd = (e: TouchEvent) => {
    const cur = g
    g = null
    if (!cur || cur.axis !== 'swipe') return
    e.stopPropagation()
    if (e.cancelable) e.preventDefault()
    const t = e.changedTouches[0]
    if (!t) {
      abort(cur)
      return
    }
    speed.add(t.clientX, e.timeStamp)
    const dx = t.clientX - cur.x
    const dy = t.clientY - cur.y
    const dir: 1 | -1 = dx < 0 ? 1 : -1
    // The session it started on is still current (not closed or switched meanwhile)
    const same = target.host() === cur.host
    const nb = dx === 0 || !same ? null : target.neighbour(dir)
    const w = target.width()
    if (!nb || !releaseSwitches(dx, dy, speed.speed(), w)) {
      abort(cur)
      return
    }
    target.peek(null)
    const old = cur.host
    if (old) {
      old.style.transform = ''
      delete old.dataset.swiping
    }
    target.switchTo(nb.sid)
    const now = target.host()
    // The new terminal sat right next to the old one: it continues from there
    if (now && now !== old) settle(now, cur.offset + dir * w, SLIDE_IN_MS)
  }

  const onCancel = () => {
    if (g) abort(g)
    g = null
  }

  const opts = { capture: true, passive: false }
  el.addEventListener('touchstart', onStart, { capture: true, passive: true })
  el.addEventListener('touchmove', onMove, opts)
  el.addEventListener('touchend', onEnd, opts)
  el.addEventListener('touchcancel', onCancel, { capture: true, passive: true })
  return () => {
    stop()
    el.removeEventListener('touchstart', onStart, { capture: true })
    el.removeEventListener('touchmove', onMove, { capture: true })
    el.removeEventListener('touchend', onEnd, { capture: true })
    el.removeEventListener('touchcancel', onCancel, { capture: true })
  }
}

