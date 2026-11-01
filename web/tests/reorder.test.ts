/**
 * UT-order-1 (AC-4.13, ADR-0040): the pure reorder functions; the store half is in store.test.ts.
 * UT-swipe-1 (AC-4.12, ADR-0039): row swipe detection.
 */
import { describe, expect, it } from 'vitest'

import { EDGE_PX, beforeAt, dropIndex, edgeScroll, moveBefore } from '../src/ui/reorder'
import { ROW_ACTIONS_PX, RowSwipe } from '../src/ui/rowswipe'

describe('UT-order-1 moveBefore / beforeAt', () => {
  it('moves in front of an item; null or unknown before → last; before itself → no-op', () => {
    expect(moveBefore([1, 2, 3], 3, 1)).toEqual([3, 1, 2])
    expect(moveBefore([1, 2, 3], 1, 3)).toEqual([2, 1, 3])
    expect(moveBefore([1, 2, 3], 1, null)).toEqual([2, 3, 1])
    expect(moveBefore([1, 2, 3], 1, 9)).toEqual([2, 3, 1])
    expect(moveBefore([1, 2, 3], 2, 2)).toEqual([1, 2, 3])
    expect(moveBefore([1, 2, 3], 9, 1), 'unknown sid: no change').toEqual([1, 2, 3])
  })

  it('beforeAt: after moving index from to to, which item it precedes', () => {
    const order = [10, 20, 30, 40]
    expect(beforeAt(order, 3, 0)).toBe(10) // 40 to the front
    expect(beforeAt(order, 0, 3)).toBeNull() // 10 to the end
    expect(beforeAt(order, 0, 1)).toBe(30) // 10 after 20
    expect(beforeAt(order, 2, 1)).toBe(20) // 30 before 20
    for (const [from, to] of [[3, 0], [0, 3], [0, 1], [2, 1], [1, 2]] as const) {
      const sid = order[from]!
      const out = moveBefore(order, sid, beforeAt(order, from, to))
      expect(out.indexOf(sid), `${from}→${to}`).toBe(to)
    }
  })
})

describe('UT-order-1 dropIndex', () => {
  // Four items, 100 wide each: midpoints 50 150 250 350
  const mids = [50, 150, 250, 350]
  it('stays put until crossing a neighbor\'s midpoint', () => {
    expect(dropIndex(mids, 1, 150)).toBe(1)
    expect(dropIndex(mids, 1, 249)).toBe(1)
    expect(dropIndex(mids, 1, 51)).toBe(1)
  })
  it('moves one slot per midpoint crossed, clamped at both ends', () => {
    expect(dropIndex(mids, 1, 251)).toBe(2)
    expect(dropIndex(mids, 1, 351)).toBe(3)
    expect(dropIndex(mids, 1, 9999)).toBe(3)
    expect(dropIndex(mids, 3, 49)).toBe(0)
    expect(dropIndex(mids, 3, -9999)).toBe(0)
    expect(dropIndex(mids, 2, 149)).toBe(1)
  })
})

describe('UT-order-1 edge auto-scroll', () => {
  it('scrolls only within 32px of an edge, faster closer to it, in the right direction', () => {
    expect(edgeScroll(100, 0, 300)).toBe(0)
    expect(edgeScroll(EDGE_PX + 1, 0, 300)).toBe(0)
    expect(edgeScroll(10, 0, 300)).toBeLessThan(0)
    expect(edgeScroll(295, 0, 300)).toBeGreaterThan(0)
    expect(Math.abs(edgeScroll(0, 0, 300))).toBeGreaterThan(Math.abs(edgeScroll(20, 0, 300)))
  })
})

describe('UT-swipe-1 row swipe', () => {
  it('decides no direction within 10px and ignores mostly vertical movement', () => {
    const s = new RowSwipe()
    s.start(200, 100, false)
    expect(s.move(195, 103)).toBeNull()
    expect(s.move(190, 130), 'mostly vertical').toBeNull()
    expect(s.move(100, 130), 'the decision sticks').toBeNull()
    expect(s.end()).toBeNull()
  })

  it('follows the finger when mostly horizontal, clamping the offset to 0..−216', () => {
    const s = new RowSwipe()
    s.start(300, 100, false)
    expect(s.move(280, 102)).toBe(-20)
    expect(s.move(0, 102)).toBe(-ROW_ACTIONS_PX)
    expect(s.move(400, 102)).toBe(0)
  })

  it('opens when released past halfway, snaps back otherwise', () => {
    const s = new RowSwipe()
    s.start(300, 100, false)
    s.move(300 - 120, 100)
    expect(s.end()).toBe('open')
    s.start(300, 100, false)
    s.move(300 - 60, 100)
    expect(s.end()).toBe('closed')
  })

  it('closes an open row on a right swipe', () => {
    const s = new RowSwipe()
    s.start(100, 100, true)
    expect(s.move(110, 100), 'no direction within 10px').toBeNull()
    expect(s.move(120, 100)).toBe(-ROW_ACTIONS_PX + 20)
    expect(s.move(250, 100)).toBe(-ROW_ACTIONS_PX + 150)
    expect(s.end()).toBe('closed')
  })
})
