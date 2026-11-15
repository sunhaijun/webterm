/**
 * UT-sessionswipe-1 (AC-4.15, ADR-0067): swiping sideways on the terminal switches sessions.
 * Where a swipe may start, the 10px axis lock, the release rules, the rubber band at the ends,
 * the speed over the last 100ms, and the installer keeping a swipe's events from xterm and the
 * other terminal gestures.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  AXIS_RATIO,
  BACK_SPEED,
  EDGE_PX,
  FLICK_PX,
  FLICK_SPEED,
  LOCK_PX,
  SLIDE_BACK_MS,
  SLIDE_IN_MS,
  SpeedTracker,
  canStartSwipe,
  installSessionSwipe,
  lockAxis,
  releaseSwitches,
  rubberBand,
  switchDistance,
  type Peek,
  type SwipeNeighbour,
  type SwipeTarget,
} from '../src/term/sessionswipe'

describe('canStartSwipe', () => {
  it('needs 24px from both screen edges', () => {
    expect(EDGE_PX).toBe(24)
    expect(canStartSwipe(23, 300, 393, null)).toBe(false)
    expect(canStartSwipe(24, 300, 393, null)).toBe(true)
    expect(canStartSwipe(369, 300, 393, null)).toBe(true)
    expect(canStartSwipe(370, 300, 393, null)).toBe(false)
  })

  it('leaves the restore band to the restore swipe while the keys are collapsed', () => {
    expect(canStartSwipe(200, 499, 393, 500)).toBe(true)
    expect(canStartSwipe(200, 500, 393, 500)).toBe(false)
    expect(canStartSwipe(200, 640, 393, 500)).toBe(false)
    expect(canStartSwipe(200, 640, 393, null), 'keys not collapsed: no band').toBe(true)
  })
})

describe('lockAxis', () => {
  it('waits for 10px of travel', () => {
    expect(LOCK_PX).toBe(10)
    expect(lockAxis(5, 5)).toBe('pending')
    expect(lockAxis(9, 4), '9.8px').toBe('pending')
  })

  it('is a swipe only when clearly horizontal (|dx| ≥ 2|dy|), otherwise never', () => {
    expect(AXIS_RATIO).toBe(2)
    expect(lockAxis(10, 0)).toBe('swipe')
    expect(lockAxis(-10, 5)).toBe('swipe')
    expect(lockAxis(12, -6)).toBe('swipe')
    expect(lockAxis(10, 5.1)).toBe('other')
    expect(lockAxis(7, 7.2), 'diagonal').toBe('other')
    expect(lockAxis(3, -10), 'vertical').toBe('other')
  })
})

describe('releaseSwitches', () => {
  it('needs a quarter of the width, at most 160px', () => {
    expect(switchDistance(393)).toBeCloseTo(98.25)
    expect(switchDistance(1000)).toBe(160)
    expect(releaseSwitches(-99, 0, null, 393)).toBe(true)
    expect(releaseSwitches(99, 0, null, 393)).toBe(true)
    expect(releaseSwitches(-97, 0, null, 393)).toBe(false)
    expect(releaseSwitches(-160, 0, 0, 1000)).toBe(true)
    expect(releaseSwitches(-159, 0, 0, 1000)).toBe(false)
  })

  it('far enough, but heading back at ≥ 0.3 px/ms: you changed your mind', () => {
    expect(BACK_SPEED).toBe(0.3)
    // dx < 0 (finger went left); a positive speed is the finger moving right, back toward the start
    expect(releaseSwitches(-150, 0, 0.3, 393)).toBe(false)
    expect(releaseSwitches(-150, 0, 0.29, 393)).toBe(true)
    expect(releaseSwitches(150, 0, -0.3, 393)).toBe(false)
  })

  it('a flick: ≥ 40px at ≥ 0.5 px/ms in the swipe direction', () => {
    expect(FLICK_PX).toBe(40)
    expect(FLICK_SPEED).toBe(0.5)
    expect(releaseSwitches(-40, 0, -0.5, 393)).toBe(true)
    expect(releaseSwitches(40, 0, 0.5, 393)).toBe(true)
    expect(releaseSwitches(-39, 0, -2, 393), 'too short').toBe(false)
    expect(releaseSwitches(-60, 0, -0.49, 393), 'too slow').toBe(false)
    expect(releaseSwitches(-60, 0, 1, 393), 'fast, but the other way').toBe(false)
    expect(releaseSwitches(-60, 0, null, 393), 'no speed information').toBe(false)
  })

  it('the whole travel must still be mostly horizontal', () => {
    expect(releaseSwitches(-150, 150, null, 393)).toBe(false)
    expect(releaseSwitches(-150, -149, null, 393)).toBe(true)
    expect(releaseSwitches(-60, 60, -1, 393)).toBe(false)
  })
})

describe('rubberBand', () => {
  it('resists: grows with travel, always less than half of it, keeps the sign', () => {
    expect(rubberBand(0, 393)).toBe(0)
    const a = rubberBand(50, 393)
    const b = rubberBand(150, 393)
    expect(a).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(a)
    expect(b).toBeLessThan(75)
    expect(rubberBand(-150, 393)).toBeCloseTo(-b)
    expect(rubberBand(10_000, 393)).toBeLessThan(393)
  })
})

describe('SpeedTracker', () => {
  it('measures px/ms over the last 100ms', () => {
    const s = new SpeedTracker()
    for (let i = 0; i <= 10; i++) s.add(-14 * i, 16 * i)
    expect(s.speed()).toBeCloseTo(-14 / 16)
  })

  it('a fast drag that stopped has no speed left', () => {
    const s = new SpeedTracker()
    for (let i = 0; i <= 10; i++) s.add(-20 * i, 16 * i)
    for (let i = 1; i <= 8; i++) s.add(-200, 160 + 16 * i)
    expect(Math.abs(s.speed() ?? 0)).toBeLessThan(0.05)
  })

  it('a hold before the release leaves one sample in the window: no speed', () => {
    const s = new SpeedTracker()
    for (let i = 0; i <= 10; i++) s.add(-13 * i, 16 * i)
    s.add(-130, 460)
    expect(s.speed()).toBeNull()
  })

  it('moves stamped at the same millisecond give no speed', () => {
    const s = new SpeedTracker()
    for (let i = 0; i <= 10; i++) s.add(-14 * i, 0)
    expect(s.speed()).toBeNull()
  })

  it('reset forgets earlier touches', () => {
    const s = new SpeedTracker()
    s.add(0, 0)
    s.add(100, 50)
    s.reset()
    s.add(0, 1000)
    expect(s.speed()).toBeNull()
  })
})

// ---------- the installer ----------

type Pt = { x: number; y: number }

function fire(el: Element, type: string, pts: Pt[], t: number, changed?: Pt[]): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  const list = pts.map((p) => ({ clientX: p.x, clientY: p.y }))
  const ch = (changed ?? pts).map((p) => ({ clientX: p.x, clientY: p.y }))
  Object.defineProperty(ev, 'touches', { value: list })
  Object.defineProperty(ev, 'changedTouches', { value: ch })
  Object.defineProperty(ev, 'timeStamp', { value: t })
  el.dispatchEvent(ev)
  return ev
}

interface Anim {
  el: HTMLElement
  from: string
  to: string
  duration: number
  cancelled: boolean
  /** Runs the animation's onfinish, as the browser would at its end. */
  finish(): void
}

/** jsdom has no Web Animations: record what would have been animated. */
function stubAnimate(el: HTMLElement, anims: Anim[]): HTMLElement {
  ;(el as unknown as { animate: unknown }).animate = (kf: Keyframe[], o: KeyframeAnimationOptions) => {
    let done: (() => void) | null = null
    const a: Anim = {
      el,
      from: String(kf[0]!.transform),
      to: String(kf.at(-1)!.transform),
      duration: Number(o.duration),
      cancelled: false,
      finish: () => done?.(),
    }
    anims.push(a)
    return {
      cancel: () => (a.cancelled = true),
      set onfinish(fn: () => void) {
        done = fn
      },
    }
  }
  return el
}

interface Rig {
  area: HTMLElement
  anims: Anim[]
  /** Stands in for xterm's screen element: where touches land. */
  screen: HTMLElement
  host: HTMLElement
  /** Events that reached xterm's element. */
  inner: string[]
  /** Events seen by bubble listeners on the area (the tap toggle, drag-to-wheel). */
  outer: string[]
  switched: number[]
  peeks: (Peek | null)[]
  next: SwipeNeighbour | null
  prev: SwipeNeighbour | null
  band: number | null
  reduced: boolean
  undo: () => void
}

function rig(): Rig {
  const anims: Anim[] = []
  const area = document.createElement('div')
  const host = stubAnimate(document.createElement('div'), anims)
  const screen = document.createElement('div')
  host.appendChild(screen)
  area.appendChild(host)
  document.body.appendChild(area)
  const r: Rig = {
    area,
    anims,
    screen,
    host,
    inner: [],
    outer: [],
    switched: [],
    peeks: [],
    next: { sid: 3, index: 3, name: 'api', attention: true },
    prev: { sid: 1, index: 1, name: 'web', attention: false },
    band: null,
    reduced: false,
    undo: () => {},
  }
  for (const t of ['touchstart', 'touchmove', 'touchend']) {
    screen.addEventListener(t, () => r.inner.push(t))
    area.addEventListener(t, () => r.outer.push(t))
  }
  const target: SwipeTarget = {
    neighbour: (dir) => (dir === 1 ? r.next : r.prev),
    host: () => r.host,
    width: () => 393,
    viewportWidth: () => 393,
    bandTop: () => r.band,
    reducedMotion: () => r.reduced,
    peek: (p) => r.peeks.push(p),
    switchTo: (sid) => {
      r.switched.push(sid)
      // The store swaps the hosts, as activate() does
      const nh = stubAnimate(document.createElement('div'), anims)
      nh.appendChild(screen) // touches now land in the new session's xterm
      r.host.remove()
      area.appendChild(nh)
      r.host = nh
    },
  }
  r.undo = installSessionSwipe(area, target)
  return r
}

/** drag: start at (x, y), move by (dx, dy) in `steps` moves `ms` apart, then optionally hold and release. */
function drag(r: Rig, x: number, y: number, dx: number, dy: number, o: { steps?: number; ms?: number; hold?: number; release?: boolean } = {}) {
  const steps = o.steps ?? 10
  const ms = o.ms ?? 16
  let t = 1000
  fire(r.screen, 'touchstart', [{ x, y }], t)
  let p = { x, y }
  for (let i = 1; i <= steps; i++) {
    t += ms
    p = { x: x + (dx * i) / steps, y: y + (dy * i) / steps }
    fire(r.screen, 'touchmove', [p], t)
  }
  t += o.hold ?? 0
  if (o.release === false) return { p, t }
  const end = fire(r.screen, 'touchend', [], t, [p])
  return { p, t, end }
}

const px = (transform: string) => {
  const m = /translateX\((-?[\d.]+)px\)/.exec(transform)
  return m ? Number(m[1]) : 0
}
const tx = (el: HTMLElement) => px(el.style.transform)

describe('installSessionSwipe', () => {
  let r: Rig
  beforeEach(() => {
    r = rig()
  })
  afterEach(() => {
    r.undo()
    r.area.remove()
  })

  it('a flick left switches to the next session, a flick right to the previous', () => {
    drag(r, 200, 300, -140, 0)
    expect(r.switched).toEqual([3])
    r.next = null
    drag(r, 200, 300, 140, 0)
    expect(r.switched).toEqual([3, 1])
  })

  it('the terminal follows the finger from the point the swipe was recognized; the label names the neighbour', () => {
    const old = r.host
    drag(r, 200, 300, -60, 0, { release: false })
    expect(old.dataset.swiping, 'edges drawn, gap dimmed while it moves').toBe('true')
    expect(tx(old)).toBeLessThan(-40)
    expect(tx(old)).toBeGreaterThan(-60)
    const p = r.peeks.at(-1)!
    expect(p).toMatchObject({ side: 'right', index: 3, name: 'api', attention: true, ready: false })
    expect(p.progress).toBeGreaterThan(0)
    expect(p.progress).toBeLessThan(1)
  })

  it('ready once releasing would switch by distance', () => {
    drag(r, 200, 300, -110, 0, { release: false })
    expect(r.peeks.at(-1)).toMatchObject({ ready: true, progress: 1 })
  })

  it('a slow drag past a quarter of the width switches; a short one slides back', () => {
    drag(r, 200, 300, -70, 0, { hold: 300 })
    expect(r.switched).toEqual([])
    expect(r.peeks.at(-1), 'label hidden on release').toBeNull()
    expect(r.host.style.transform, 'the resting place is no transform').toBe('')
    const back = r.anims.at(-1)!
    expect(back.el).toBe(r.host)
    expect(px(back.from)).toBeCloseTo(-70 + 14)
    expect(px(back.to)).toBe(0)
    expect(back.duration).toBe(SLIDE_BACK_MS)
    expect(r.host.dataset.swiping, 'still moving').toBe('true')
    back.finish()
    expect(r.host.dataset.swiping, 'at rest').toBeUndefined()
    drag(r, 200, 300, -110, 0, { hold: 300 })
    expect(r.switched).toEqual([3])
  })

  it('the new terminal slides in from the side the finger went, starting where the old edge was', () => {
    const old = r.host
    drag(r, 200, 300, -140, 0)
    expect(old.style.transform, "the old host's transform is cleared").toBe('')
    expect(old.dataset.swiping).toBeUndefined()
    expect(r.host.style.transform).toBe('')
    expect(r.host.dataset.swiping).toBe('true')
    const a = r.anims.at(-1)!
    expect(a.el).toBe(r.host)
    // The old terminal was at -126 (followed from the lock at 14px); the new one sat right after it
    expect(px(a.from)).toBeCloseTo(393 - 126)
    expect(px(a.to)).toBe(0)
    expect(a.duration).toBe(SLIDE_IN_MS)
    // And from the other side
    r.next = null
    drag(r, 200, 300, 140, 0)
    expect(px(r.anims.at(-1)!.from)).toBeCloseTo(126 - 393)
  })

  it('with no session on that side: resists, no label, never switches', () => {
    r.next = null
    drag(r, 200, 300, -150, 0, { release: false })
    expect(tx(r.host)).toBeLessThan(0)
    expect(tx(r.host)).toBeGreaterThan(-75)
    expect(r.peeks.filter(Boolean)).toEqual([])
    fire(r.screen, 'touchend', [], 1200, [{ x: 50, y: 300 }])
    expect(r.switched).toEqual([])
  })

  it('once a swipe, its moves and release stop at the area: nothing reaches xterm or the other gestures', () => {
    const { end } = drag(r, 200, 300, -140, 0)
    // touchstart and the moves before the lock pass; nothing after
    const lockedAt = r.inner.filter((t) => t === 'touchmove').length
    expect(lockedAt).toBeLessThan(2)
    expect(r.inner).not.toContain('touchend')
    expect(r.outer).not.toContain('touchend')
    expect(end!.defaultPrevented, 'no synthesized click').toBe(true)
  })

  it('a vertical or diagonal drag is never a swipe and passes through untouched', () => {
    const { end } = drag(r, 200, 300, -120, 70, { hold: 300 })
    expect(r.switched).toEqual([])
    expect(r.host.style.transform).toBe('')
    expect(r.inner.filter((t) => t === 'touchmove')).toHaveLength(10)
    expect(r.inner).toContain('touchend')
    expect(end!.defaultPrevented).toBe(false)
    drag(r, 200, 300, 4, 200)
    expect(r.switched).toEqual([])
  })

  it('a scroll that turns sideways later stays a scroll', () => {
    fire(r.screen, 'touchstart', [{ x: 200, y: 300 }], 0)
    fire(r.screen, 'touchmove', [{ x: 200, y: 320 }], 16)
    fire(r.screen, 'touchmove', [{ x: 60, y: 325 }], 32)
    fire(r.screen, 'touchend', [], 48, [{ x: 60, y: 325 }])
    expect(r.switched).toEqual([])
  })

  it('never from the screen edges', () => {
    drag(r, 10, 300, 140, 0)
    drag(r, 385, 300, -140, 0)
    expect(r.switched).toEqual([])
  })

  it('never from the restore band while the keys are collapsed', () => {
    r.band = 500
    drag(r, 200, 520, -140, 0)
    expect(r.switched).toEqual([])
    drag(r, 200, 300, -140, 0)
    expect(r.switched).toEqual([3])
  })

  it('a second finger cancels: slides back, no switch', () => {
    drag(r, 200, 300, -130, 0, { release: false })
    fire(r.screen, 'touchstart', [{ x: 70, y: 300 }, { x: 250, y: 400 }], 1200)
    fire(r.screen, 'touchend', [{ x: 250, y: 400 }], 1250, [{ x: 70, y: 300 }])
    fire(r.screen, 'touchend', [], 1300, [{ x: 250, y: 400 }])
    expect(r.switched).toEqual([])
    expect(r.host.style.transform).toBe('')
    expect(r.anims.at(-1)!.duration).toBe(SLIDE_BACK_MS)
  })

  it('touchcancel slides back', () => {
    drag(r, 200, 300, -130, 0, { release: false })
    fire(r.screen, 'touchcancel', [], 1200, [])
    expect(r.switched).toEqual([])
    expect(r.peeks.at(-1)).toBeNull()
    expect(r.host.style.transform).toBe('')
    expect(r.anims.at(-1)!.duration).toBe(SLIDE_BACK_MS)
  })

  it('a neighbour closed during the swipe: slides back', () => {
    drag(r, 200, 300, -130, 0, { release: false })
    r.next = null
    fire(r.screen, 'touchend', [], 1300, [{ x: 70, y: 300 }])
    expect(r.switched).toEqual([])
  })

  it('the current session changed during the swipe: slides back, does not switch from the new one', () => {
    const old = r.host
    drag(r, 200, 300, -130, 0, { release: false })
    r.host = document.createElement('div')
    fire(r.screen, 'touchend', [], 1300, [{ x: 70, y: 300 }])
    expect(r.switched).toEqual([])
    expect(old.style.transform).toBe('')
  })

  it("a swipe whose end never arrived (its host was detached) is cleaned up by the next touch, without animating", () => {
    const old = r.host
    drag(r, 200, 300, -130, 0, { release: false })
    expect(r.peeks.at(-1)).not.toBeNull()
    const n = r.anims.length
    fire(r.screen, 'touchstart', [{ x: 200, y: 300 }], 3000)
    expect(r.peeks.at(-1)).toBeNull()
    expect(old.style.transform).toBe('')
    expect(old.dataset.swiping).toBeUndefined()
    expect(r.anims.length).toBe(n)
  })

  it('a new touch during an animation ends it at once', () => {
    drag(r, 200, 300, -140, 0)
    const a = r.anims.at(-1)!
    expect(a.cancelled).toBe(false)
    fire(r.screen, 'touchstart', [{ x: 200, y: 300 }], 2000)
    expect(a.cancelled).toBe(true)
    expect(r.host.dataset.swiping).toBeUndefined()
  })

  it('prefers-reduced-motion: nothing moves, the label still shows, release switches', () => {
    r.reduced = true
    const old = r.host
    drag(r, 200, 300, -110, 0, { release: false })
    expect(old.style.transform).toBe('')
    expect(old.dataset.swiping).toBeUndefined()
    expect(r.peeks.at(-1)).toMatchObject({ ready: true })
    fire(r.screen, 'touchend', [], 1300, [{ x: 90, y: 300 }])
    expect(r.switched).toEqual([3])
    expect(r.anims, 'nothing animates').toEqual([])
  })

  it('unmounting removes the listeners', () => {
    r.undo()
    drag(r, 200, 300, -140, 0)
    expect(r.switched).toEqual([])
  })
})
