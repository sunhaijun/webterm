/**
 * AC-3.20 tapping the terminal: toggles the on-screen keyboard without mouse tracking,
 * leaves it to xterm with mouse tracking; drags are not taps.
 * UT-touch-1 (AC-3.21): with mouse tracking, vertical drags become wheel events.
 */
import { describe, expect, it } from 'vitest'

import {
  DragWheel,
  TAP_MAX_MOVE,
  WHEEL_MAX_PER_MOVE,
  TAP_MAX_MS,
  installDragWheel,
  installTapToggle,
  isTap,
  type TapTarget,
  type WheelTarget,
} from '../src/term/gestures'

describe('isTap', () => {
  it('requires movement < 10px and duration < 300ms', () => {
    expect(TAP_MAX_MOVE).toBe(10)
    expect(TAP_MAX_MS).toBe(300)
    const s = { x: 0, y: 0, t: 0 }
    expect(isTap(s, { x: 2, y: 2, t: 100 }, 3)).toBe(true)
    expect(isTap(s, { x: 0, y: 30, t: 100 }, 30), 'vertical drag of 30px').toBe(false)
    expect(isTap(s, { x: 0, y: 0, t: 400 }, 0), 'held too long').toBe(false)
    expect(isTap(s, { x: 0, y: 0, t: 100 }, 12), 'moved away and back').toBe(false)
  })
})

function touch(el: HTMLElement, type: string, y: number, timeStamp: number): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  const pts = [{ clientX: 50, clientY: y }]
  Object.defineProperty(ev, 'touches', { value: type === 'touchend' ? [] : pts })
  Object.defineProperty(ev, 'changedTouches', { value: pts })
  Object.defineProperty(ev, 'timeStamp', { value: timeStamp })
  el.dispatchEvent(ev)
  return ev
}

function target(tracking = false) {
  const log: string[] = []
  let focused = false
  const t: TapTarget = {
    mouseTracking: () => tracking,
    focused: () => focused,
    focus: () => {
      focused = true
      log.push('focus')
    },
    blur: () => {
      focused = false
      log.push('blur')
    },
  }
  return { t, log }
}

describe('installTapToggle', () => {
  it('tap focuses, a second tap blurs, and synthesized mouse events are prevented', () => {
    const el = document.createElement('div')
    const { t, log } = target()
    installTapToggle(el, () => t)
    touch(el, 'touchstart', 100, 0)
    const end = touch(el, 'touchend', 102, 80)
    expect(end.defaultPrevented).toBe(true)
    touch(el, 'touchstart', 100, 1000)
    touch(el, 'touchend', 100, 1050)
    expect(log).toEqual(['focus', 'blur'])
  })

  it('a 30px vertical drag does not change focus (it is a scroll)', () => {
    const el = document.createElement('div')
    const { t, log } = target()
    installTapToggle(el, () => t)
    touch(el, 'touchstart', 100, 0)
    touch(el, 'touchmove', 130, 50)
    const end = touch(el, 'touchend', 130, 100)
    expect(log).toEqual([])
    expect(end.defaultPrevented).toBe(false)
  })

  it('with mouse tracking, leaves it to xterm without toggling the keyboard or blocking synthesized mouse events', () => {
    const el = document.createElement('div')
    const { t, log } = target(true)
    installTapToggle(el, () => t)
    touch(el, 'touchstart', 100, 0)
    const end = touch(el, 'touchend', 100, 50)
    expect(log).toEqual([])
    expect(end.defaultPrevented).toBe(false)
  })

  it('does nothing without an active session and stops responding once uninstalled', () => {
    const el = document.createElement('div')
    const { t, log } = target()
    let cur: TapTarget | null = null
    const off = installTapToggle(el, () => cur)
    touch(el, 'touchstart', 100, 0)
    touch(el, 'touchend', 100, 50)
    cur = t
    off()
    touch(el, 'touchstart', 100, 100)
    touch(el, 'touchend', 100, 150)
    expect(log).toEqual([])
  })
})

/** One finger at (x, y); touches is empty on touchend. */
function finger(el: HTMLElement, type: string, x: number, y: number, fingers = 1): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  const pts = Array.from({ length: fingers }, () => ({ clientX: x, clientY: y }))
  Object.defineProperty(ev, 'touches', { value: type === 'touchend' ? [] : pts })
  Object.defineProperty(ev, 'changedTouches', { value: pts })
  el.dispatchEvent(ev)
  return ev
}

const ROW = 17

function wheelTarget(tracking = true) {
  const wheels: { up: boolean; x: number; y: number }[] = []
  const t: WheelTarget & { tracking: boolean } = {
    tracking,
    mouseTracking: () => t.tracking,
    rowHeight: () => ROW,
    wheel: (up, x, y) => {
      wheels.push({ up, x, y })
    },
  }
  return { t, wheels }
}

describe('UT-touch-1 DragWheel accumulates by row height', () => {
  it('caps at 3', () => {
    expect(WHEEL_MAX_PER_MOVE).toBe(3)
  })

  it('emits once per full row and carries the remainder; finger down is positive (wheel up)', () => {
    const d = new DragWheel()
    expect(d.feed(10, ROW)).toBe(0)
    expect(d.feed(10, ROW), '10 + 10 = 20: one row, 3 left').toBe(1)
    expect(d.feed(ROW * 2, ROW)).toBe(2)
    expect(d.feed(-20, ROW), '3 − 20 = −17: exactly one row down').toBe(-1)
    expect(d.feed(-16, ROW)).toBe(0)
  })

  it('emits at most 3 per call, dropping the excess instead of carrying it; reset clears the remainder', () => {
    const d = new DragWheel()
    expect(d.feed(ROW * 8 + 5, ROW)).toBe(3)
    expect(d.feed(ROW - 6, ROW), 'remainder 5 + 11 = 16, under a row; the 5 dropped rows were not kept').toBe(0)
    expect(d.feed(-ROW * 10, ROW)).toBe(-3)
    d.feed(16, ROW)
    d.reset()
    expect(d.feed(1, ROW)).toBe(0)
  })
})

describe('UT-touch-1 installDragWheel (AC-3.21, ADR-0032)', () => {
  it('emits as soon as the drag starts without waiting for round trips, then once per row height, counting from the start', () => {
    const el = document.createElement('div')
    const { t, wheels } = wheelTarget()
    installDragWheel(el, () => t)
    finger(el, 'touchstart', 50, 100)
    const small = finger(el, 'touchmove', 50, 105)
    expect(wheels, 'under 10px: may still be a tap').toEqual([])
    expect(small.defaultPrevented).toBe(false)
    const first = finger(el, 'touchmove', 52, 100 + ROW + 1)
    expect(first.defaultPrevented, 'the browser must not scroll as well while converting').toBe(true)
    expect(wheels, 'a full row from the start: emit right away').toEqual([{ up: true, x: 52, y: 100 + ROW + 1 }])
    finger(el, 'touchmove', 52, 100 + ROW * 4)
    expect(wheels.length, '4 rows in total').toBe(4)
    expect(wheels.every((w) => w.up)).toBe(true)
    // Drag back 2 rows: 2 steps down
    finger(el, 'touchmove', 52, 100 + ROW * 2)
    expect(wheels.slice(4).map((w) => w.up)).toEqual([false, false])
    finger(el, 'touchend', 52, 100 + ROW * 2)
  })

  it('starts each drag from zero without carrying the previous remainder', () => {
    const el = document.createElement('div')
    const { t, wheels } = wheelTarget()
    installDragWheel(el, () => t)
    finger(el, 'touchstart', 50, 100)
    finger(el, 'touchmove', 50, 100 + ROW * 1.9)
    finger(el, 'touchend', 50, 100 + ROW * 1.9)
    expect(wheels.length).toBe(1)
    finger(el, 'touchstart', 50, 300)
    finger(el, 'touchmove', 50, 300 + 12)
    expect(wheels.length, '12px is under a row').toBe(1)
  })

  it('caps a fast fling at 3 per touchmove', () => {
    const el = document.createElement('div')
    const { t, wheels } = wheelTarget()
    installDragWheel(el, () => t)
    finger(el, 'touchstart', 50, 100)
    finger(el, 'touchmove', 50, 100 + ROW * 10)
    expect(wheels.length).toBe(3)
  })

  it('ignores mostly horizontal drags without preventing them', () => {
    const el = document.createElement('div')
    const { t, wheels } = wheelTarget()
    installDragWheel(el, () => t)
    finger(el, 'touchstart', 50, 100)
    const a = finger(el, 'touchmove', 170, 110)
    const b = finger(el, 'touchmove', 170, 100 + ROW * 4)
    expect(wheels).toEqual([])
    expect(a.defaultPrevented || b.defaultPrevented).toBe(false)
  })

  it('without mouse tracking, leaves it to xterm touch scrolling: no wheel events, nothing prevented', () => {
    const el = document.createElement('div')
    const { t, wheels } = wheelTarget(false)
    installDragWheel(el, () => t)
    finger(el, 'touchstart', 50, 100)
    const mv = finger(el, 'touchmove', 50, 100 + ROW * 5)
    expect(wheels).toEqual([])
    expect(mv.defaultPrevented).toBe(false)
  })

  it('ignores two-finger pinches, does nothing without an active session, and stops once uninstalled', () => {
    const el = document.createElement('div')
    const { t, wheels } = wheelTarget()
    let cur: WheelTarget | null = t
    const off = installDragWheel(el, () => cur)
    finger(el, 'touchstart', 50, 100, 2)
    finger(el, 'touchmove', 50, 100 + ROW * 5, 2)
    expect(wheels).toEqual([])
    cur = null
    finger(el, 'touchstart', 50, 100)
    finger(el, 'touchmove', 50, 100 + ROW * 5)
    expect(wheels).toEqual([])
    cur = t
    off()
    finger(el, 'touchstart', 50, 100)
    finger(el, 'touchmove', 50, 100 + ROW * 5)
    expect(wheels).toEqual([])
  })
})
