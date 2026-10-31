/** 按下 → 点 / 长按 / 拖走（CTRL / ALT 锁定、会话菜单都靠它）。 */
import { describe, expect, it } from 'vitest'

import { LONG_PRESS_MS, PressTracker, TAP_SLOP_PX, type Timers } from '../src/ui/longpress'

/** 手动推进的计时器。 */
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
  it('门槛是 500ms，拖动容差 10px', () => {
    expect(LONG_PRESS_MS).toBe(500)
    expect(TAP_SLOP_PX).toBe(10)
  })

  it('很快抬起 = 点', () => {
    const t = fakeTimers()
    const p = new PressTracker(500, t.timers)
    let long = 0
    p.down(0, 0, () => long++)
    t.advance(100)
    expect(p.up()).toBe('tap')
    t.advance(1000)
    expect(long).toBe(0)
  })

  it('按满门槛 = 长按：手指还没抬起就触发，抬起报 long，紧跟着的 click 吞掉一次', () => {
    const t = fakeTimers()
    const p = new PressTracker(500, t.timers)
    let long = 0
    p.down(0, 0, () => long++)
    t.advance(500)
    expect(long).toBe(1)
    expect(p.up()).toBe('long')
    expect(p.takeSwallowedClick()).toBe(true)
    expect(p.takeSwallowedClick(), '一次性').toBe(false)
  })

  it('拖走了既不是点也不是长按', () => {
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

  it('cancel 之后什么都不发生', () => {
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
