/**
 * UT-swipe-1：轴锁与横滑阈值（AC-4.7）。
 *
 * 判定规则写在 docs/40-frontend/session-ux.md §左右滑动切换，这里逐条对着测。
 */
import { describe, expect, it } from 'vitest'

import { FLICK_MIN_PX, LOCK_PX, SWITCH_PX, lockAxis, switchDelta } from '../src/term/hswipe'

describe('UT-swipe-1 轴锁', () => {
  it('走够 12px 之前谁都不给 —— 抖动不该当成方向', () => {
    expect(lockAxis(0, 0)).toBe('none')
    expect(lockAxis(LOCK_PX - 1, LOCK_PX - 1)).toBe('none')
    expect(lockAxis(-11, 8)).toBe('none')
  })

  it('横向占优锁 x，纵向占优锁 y', () => {
    expect(lockAxis(30, 5)).toBe('x')
    expect(lockAxis(-30, 5)).toBe('x')
    expect(lockAxis(5, 30)).toBe('y')
    expect(lockAxis(5, -30)).toBe('y')
  })

  it('斜着走时按占优的那一轴；相等给 y（滚动是更常见的意图）', () => {
    expect(lockAxis(40, 39)).toBe('x')
    expect(lockAxis(39, 40)).toBe('y')
    expect(lockAxis(20, 20)).toBe('y')
  })
})

describe('UT-swipe-1 切换阈值', () => {
  it('位移过 80px 就切：左滑下一个、右滑上一个', () => {
    expect(switchDelta(-(SWITCH_PX + 1), 300)).toBe(1)
    expect(switchDelta(SWITCH_PX + 1, 300)).toBe(-1)
  })

  it('位移不够但够快（> 0.5 px/ms）也切', () => {
    expect(switchDelta(-50, 60)).toBe(1) // 0.83 px/ms
    expect(switchDelta(50, 60)).toBe(-1)
  })

  it('慢慢拖了 40px 不切 —— 没过位移阈值也不算甩动', () => {
    expect(switchDelta(-40, 400)).toBe(0) // 0.1 px/ms
    expect(switchDelta(40, 400)).toBe(0)
  })

  it('快抖一下也不切：甩动另有 24px 的位移下限', () => {
    expect(switchDelta(-(FLICK_MIN_PX - 1), 1)).toBe(0)
    expect(switchDelta(20, 5)).toBe(0) // 4 px/ms，但只走了 20px
  })

  it('零耗时当成没有速度信息，不当成无限快', () => {
    expect(switchDelta(-40, 0)).toBe(0)
    expect(switchDelta(-140, 0)).toBe(1) // 位移够，跟速度无关
  })
})
