/** UT-resize-1: resize debounce, the keyboard gate, scrolling the selection into view, menu placement. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { appFit, debounce, menuPosition, needsReveal } from '../src/ui/viewport'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('UT-resize-1 debounce', () => {
  it('fires only the last of rapid calls', () => {
    const fn = vi.fn()
    const d = debounce(fn, 100)
    d(1)
    d(2)
    d(3)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(3)
  })

  it('fires each call when spaced out enough', () => {
    const fn = vi.fn()
    const d = debounce(fn, 100)
    d()
    vi.advanceTimersByTime(100)
    d()
    vi.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('does not fire after cancel', () => {
    const fn = vi.fn()
    const d = debounce(fn, 100)
    d()
    d.cancel()
    vi.advanceTimersByTime(500)
    expect(fn).not.toHaveBeenCalled()
  })
})

import { isKeyboardUp, KEYBOARD_MIN_PX, layoutViewportHeight } from '../src/ui/viewport'

/**
 * Keyboard gate (viewport.ts appFit): the keyboard is up only when the visual viewport is
 * much shorter than the layout viewport. The reference must be the layout viewport
 * (documentElement.clientHeight), not window.innerHeight: Safari's innerHeight is the
 * visual viewport height and shrinks with the keyboard, so the gate would never open.
 */
describe('isKeyboardUp / layoutViewportHeight', () => {
  it('keyboard up: visual 450 vs layout 851 → open', () => {
    expect(isKeyboardUp(450, 851)).toBe(true)
  })
  it('address bar slide / bounce: difference within threshold → closed (no offsetTop tracking, no jitter loop)', () => {
    expect(isKeyboardUp(851, 851)).toBe(false)
    expect(isKeyboardUp(851 - KEYBOARD_MIN_PX, 851)).toBe(false)
    expect(isKeyboardUp(851 - KEYBOARD_MIN_PX - 1, 851)).toBe(true)
  })
  it('stays open under Safari semantics where innerHeight shrinks with the keyboard: the reference is the layout viewport', () => {
    // Simulated: layout stays 851 while Safari's innerHeight became 450; the gate must not look at it
    expect(isKeyboardUp(450, 851)).toBe(true)
    expect(isKeyboardUp(450, 450), 'using innerHeight as the reference would close it (the original bug)').toBe(false)
  })
  it('layoutViewportHeight reads documentElement.clientHeight, falling back to innerHeight on 0', () => {
    const real = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(document.documentElement), 'clientHeight')
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, get: () => 777 })
    expect(layoutViewportHeight()).toBe(777)
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, get: () => 0 })
    expect(layoutViewportHeight()).toBe(window.innerHeight)
    if (real) Object.defineProperty(Object.getPrototypeOf(document.documentElement), 'clientHeight', real)
    // @ts-expect-error remove the instance override
    delete document.documentElement.clientHeight
  })
})

describe('appFit: .app tracks the visual viewport (AC-3.8)', () => {
  it('keyboard up: height = visual height, translateY follows offsetTop, bottom safe area zeroed', () => {
    expect(appFit({ height: 400, offsetTop: 327 }, 727)).toEqual({ height: 400, translateY: 327, keyboardUp: true })
  })
  it('layout viewport shrinks too (resizes-content): offsetTop 0, no compensation', () => {
    expect(appFit({ height: 450, offsetTop: 0 }, 450)).toEqual({ height: 450, translateY: 0, keyboardUp: false })
  })
  it('plain bounce: offsetTop changes but height does not → not followed (guards the drag jitter fix)', () => {
    expect(appFit({ height: 727, offsetTop: -40 }, 727).translateY).toBe(0)
    expect(appFit({ height: 727, offsetTop: 60 }, 727).translateY).toBe(0)
  })
  it('rounds the height', () => {
    expect(appFit({ height: 399.6, offsetTop: 0 }, 400).height).toBe(400)
  })
})

describe('needsReveal: whether the selection must scroll into view (AC-4.9)', () => {
  const view = { left: 0, top: 0, right: 600, bottom: 40 }
  it('fully visible: no scroll', () => {
    expect(needsReveal({ left: 10, top: 0, right: 200, bottom: 40 }, view)).toBe(false)
    expect(needsReveal({ left: 0, top: 0, right: 600, bottom: 40 }, view)).toBe(false)
  })
  it('half visible or fully outside: scroll', () => {
    expect(needsReveal({ left: 550, top: 0, right: 650, bottom: 40 }, view)).toBe(true)
    expect(needsReveal({ left: -20, top: 0, right: 80, bottom: 40 }, view)).toBe(true)
    expect(needsReveal({ left: 700, top: 0, right: 800, bottom: 40 }, view)).toBe(true)
  })
  it('works the same for vertical lists', () => {
    expect(needsReveal({ left: 0, top: 30, right: 100, bottom: 82 }, { left: 0, top: 0, right: 400, bottom: 60 })).toBe(true)
  })
})

describe('menuPosition: the session menu sits next to the trigger point and stays on screen', () => {
  const m = { width: 184, height: 152 }
  it('goes below-right of the trigger point when it fits', () => {
    expect(menuPosition(100, 100, m, 393, 851)).toEqual({ left: 100, top: 100 })
  })
  it('pulls back when it does not fit, keeping an 8px margin', () => {
    expect(menuPosition(380, 840, m, 393, 851)).toEqual({ left: 393 - 184 - 8, top: 851 - 152 - 8 })
    expect(menuPosition(-5, -5, m, 393, 851)).toEqual({ left: 8, top: 8 })
  })
})
