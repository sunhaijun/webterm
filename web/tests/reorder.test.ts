/**
 * UT-order-1（AC-4.13，ADR-0040）：排序的纯函数。store 那一半在 store.test.ts。
 * UT-swipe-1（AC-4.12，ADR-0039）：一行左滑的判定。
 */
import { describe, expect, it } from 'vitest'

import { EDGE_PX, beforeAt, dropIndex, edgeScroll, moveBefore } from '../src/ui/reorder'
import { ROW_ACTIONS_PX, RowSwipe } from '../src/ui/rowswipe'

describe('UT-order-1 moveBefore / beforeAt', () => {
  it('挪到某项前面；null、不认识的 before → 最后；before 是自己 → 不动', () => {
    expect(moveBefore([1, 2, 3], 3, 1)).toEqual([3, 1, 2])
    expect(moveBefore([1, 2, 3], 1, 3)).toEqual([2, 1, 3])
    expect(moveBefore([1, 2, 3], 1, null)).toEqual([2, 3, 1])
    expect(moveBefore([1, 2, 3], 1, 9)).toEqual([2, 3, 1])
    expect(moveBefore([1, 2, 3], 2, 2)).toEqual([1, 2, 3])
    expect(moveBefore([1, 2, 3], 9, 1), '不认识的 sid 不动').toEqual([1, 2, 3])
  })

  it('beforeAt：下标 from 挪到 to 之后，它排在谁前面', () => {
    const order = [10, 20, 30, 40]
    expect(beforeAt(order, 3, 0)).toBe(10) // 40 挪到最前
    expect(beforeAt(order, 0, 3)).toBeNull() // 10 挪到最后
    expect(beforeAt(order, 0, 1)).toBe(30) // 10 挪到 20 后面
    expect(beforeAt(order, 2, 1)).toBe(20) // 30 挪到 20 前面
    for (const [from, to] of [[3, 0], [0, 3], [0, 1], [2, 1], [1, 2]] as const) {
      const sid = order[from]!
      const out = moveBefore(order, sid, beforeAt(order, from, to))
      expect(out.indexOf(sid), `${from}→${to}`).toBe(to)
    }
  })
})

describe('UT-order-1 dropIndex', () => {
  // 四项，各 100 宽：中线 50 150 250 350
  const mids = [50, 150, 250, 350]
  it('没越过相邻项的中线就不换位', () => {
    expect(dropIndex(mids, 1, 150)).toBe(1)
    expect(dropIndex(mids, 1, 249)).toBe(1)
    expect(dropIndex(mids, 1, 51)).toBe(1)
  })
  it('越过几条中线就挪几位，两头夹住', () => {
    expect(dropIndex(mids, 1, 251)).toBe(2)
    expect(dropIndex(mids, 1, 351)).toBe(3)
    expect(dropIndex(mids, 1, 9999)).toBe(3)
    expect(dropIndex(mids, 3, 49)).toBe(0)
    expect(dropIndex(mids, 3, -9999)).toBe(0)
    expect(dropIndex(mids, 2, 149)).toBe(1)
  })
})

describe('UT-order-1 靠边自动滚', () => {
  it('离边 32px 以内才滚，越靠边越快，方向对', () => {
    expect(edgeScroll(100, 0, 300)).toBe(0)
    expect(edgeScroll(EDGE_PX + 1, 0, 300)).toBe(0)
    expect(edgeScroll(10, 0, 300)).toBeLessThan(0)
    expect(edgeScroll(295, 0, 300)).toBeGreaterThan(0)
    expect(Math.abs(edgeScroll(0, 0, 300))).toBeGreaterThan(Math.abs(edgeScroll(20, 0, 300)))
  })
})

describe('UT-swipe-1 行左滑', () => {
  it('10px 以内不判方向；纵向占优就不接管', () => {
    const s = new RowSwipe()
    s.start(200, 100, false)
    expect(s.move(195, 103)).toBeNull()
    expect(s.move(190, 130), '纵向占优').toBeNull()
    expect(s.move(100, 130), '判过一次就不改').toBeNull()
    expect(s.end()).toBeNull()
  })

  it('横向占优就跟手，位移夹在 0 到 −216', () => {
    const s = new RowSwipe()
    s.start(300, 100, false)
    expect(s.move(280, 102)).toBe(-20)
    expect(s.move(0, 102)).toBe(-ROW_ACTIONS_PX)
    expect(s.move(400, 102)).toBe(0)
  })

  it('过半松手打开，不到一半弹回', () => {
    const s = new RowSwipe()
    s.start(300, 100, false)
    s.move(300 - 120, 100)
    expect(s.end()).toBe('open')
    s.start(300, 100, false)
    s.move(300 - 60, 100)
    expect(s.end()).toBe('closed')
  })

  it('开着的行往右滑关上', () => {
    const s = new RowSwipe()
    s.start(100, 100, true)
    expect(s.move(110, 100), '10px 以内不判方向').toBeNull()
    expect(s.move(120, 100)).toBe(-ROW_ACTIONS_PX + 20)
    expect(s.move(250, 100)).toBe(-ROW_ACTIONS_PX + 150)
    expect(s.end()).toBe('closed')
  })
})
