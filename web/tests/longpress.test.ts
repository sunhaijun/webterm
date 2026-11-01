/** Press → tap / long-press / drag (used by CTRL / ALT locking and the session menu). */
import { describe, expect, it } from 'vitest'

import { LONG_PRESS_MS, PressTracker, TAP_SLOP_PX, type Timers } from '../src/ui/longpress'

/** A manually advanced timer. */
function fakeTimers() {
  let pending: { fn: () => void; at: number; id: number } | null = null
  let now = 0
  let seq = 0
  const timers: Timers = {
    set(fn, ms) {
      pending = { fn, at: now + ms, id: ++seq }
      return pending.id
    },
    clear(h) {
      if (pending?.id === h) pending = null
    },
  }
  const advance = (ms: number) => {
    now += ms
    if (pending && pending.at <= now) {
      const p = pending
      pending = null
      p.fn()
    }
  }
  return { timers, advance }
}

describe('PressTracker', () => {
  it('uses a 500ms threshold and 10px drag slop', () => {
    expect(LONG_PRESS_MS).toBe(500)
    expect(TAP_SLOP_PX).toBe(10)
  })

  it('treats a quick release as a tap', () => {
    const t = fakeTimers()
    const p = new PressTracker(500, t.timers)
    let long = 0
    p.down(0, 0, () => long++)
    t.advance(100)
    expect(p.up()).toBe('tap')
    t.advance(1000)
    expect(long).toBe(0)
  })

  it('fires long-press at the threshold while still pressed, and reports long on release', () => {
    const t = fakeTimers()
    const p = new PressTracker(500, t.timers)
    let long = 0
    p.down(0, 0, () => long++)
    t.advance(500)
    expect(long).toBe(1)
    expect(p.up()).toBe('long')
  })

  it('treats a drag as neither tap nor long-press', () => {
    const t = fakeTimers()
    const p = new PressTracker(500, t.timers)
    let long = 0
    p.down(0, 0, () => long++)
    p.move(3, 3)
    p.move(0, 12)
    t.advance(600)
    expect(long).toBe(0)
    expect(p.up()).toBe('none')
  })

  it('does nothing after cancel', () => {
    const t = fakeTimers()
    const p = new PressTracker(500, t.timers)
    let long = 0
    p.down(0, 0, () => long++)
    p.cancel()
    t.advance(600)
    expect(long).toBe(0)
    expect(p.up()).toBe('none')
  })
})
