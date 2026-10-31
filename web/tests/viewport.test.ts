/** UT-resize-1：resize 防抖；软键盘闸门；选中项滚进视野；菜单定位。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { appFit, debounce, menuPosition, needsReveal } from '../src/ui/viewport'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('UT-resize-1 防抖', () => {
  it('连续调用只触发最后一次', () => {
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

  it('间隔足够时各触发一次', () => {
    const fn = vi.fn()
    const d = debounce(fn, 100)
    d()
    vi.advanceTimersByTime(100)
    d()
    vi.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('cancel 之后不再触发', () => {
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
 * 键盘闸门（viewport.ts appFit）：可视视口比【布局视口】矮一大截才算键盘弹起。
 * 参照必须是布局视口（documentElement.clientHeight）而不是 window.innerHeight ——
 * Safari 的 innerHeight 是可视视口高度，键盘一弹跟着变矮，闸门永远关不上。
 */
describe('isKeyboardUp / layoutViewportHeight', () => {
  it('键盘弹起：可视 450 vs 布局 851 → 开', () => {
    expect(isKeyboardUp(450, 851)).toBe(true)
  })
  it('地址栏滑入滑出 / 回弹：高度差在阈值内 → 关（不追 offsetTop，防抖动环）', () => {
    expect(isKeyboardUp(851, 851)).toBe(false)
    expect(isKeyboardUp(851 - KEYBOARD_MIN_PX, 851)).toBe(false)
    expect(isKeyboardUp(851 - KEYBOARD_MIN_PX - 1, 851)).toBe(true)
  })
  it('Safari 语义下 innerHeight 跟着键盘变矮，也不能把闸门关掉：参照是布局视口', () => {
    // 模拟：布局 851 恒定；Safari 的 innerHeight 已变成 450 —— 闸门不该看它
    expect(isKeyboardUp(450, 851)).toBe(true)
    expect(isKeyboardUp(450, 450), '若错误地拿 innerHeight 当参照就会关上（这正是那个 bug）').toBe(false)
  })
  it('layoutViewportHeight 读 documentElement.clientHeight，0 时回退 innerHeight', () => {
    const real = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(document.documentElement), 'clientHeight')
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, get: () => 777 })
    expect(layoutViewportHeight()).toBe(777)
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, get: () => 0 })
    expect(layoutViewportHeight()).toBe(window.innerHeight)
    if (real) Object.defineProperty(Object.getPrototypeOf(document.documentElement), 'clientHeight', real)
    // @ts-expect-error 清掉实例上的覆盖
    delete document.documentElement.clientHeight
  })
})

describe('appFit：.app 跟着可视视口走（AC-3.8）', () => {
  it('键盘弹起：高度 = 可视高度，translateY 追 offsetTop，safe-area 下边距归零', () => {
    expect(appFit({ height: 400, offsetTop: 327 }, 727)).toEqual({ height: 400, translateY: 327, keyboardUp: true })
  })
  it('布局视口一起缩（resizes-content）：offsetTop 为 0，不补偿', () => {
    expect(appFit({ height: 450, offsetTop: 0 }, 450)).toEqual({ height: 450, translateY: 0, keyboardUp: false })
  })
  it('普通回弹：offsetTop 变而高度不变 → 不追（守住拖动抖动的修复）', () => {
    expect(appFit({ height: 727, offsetTop: -40 }, 727).translateY).toBe(0)
    expect(appFit({ height: 727, offsetTop: 60 }, 727).translateY).toBe(0)
  })
  it('高度取整', () => {
    expect(appFit({ height: 399.6, offsetTop: 0 }, 400).height).toBe(400)
  })
})

describe('needsReveal：选中项要不要滚进视野（AC-4.9）', () => {
  const view = { left: 0, top: 0, right: 600, bottom: 40 }
  it('整个已可见：不动', () => {
    expect(needsReveal({ left: 10, top: 0, right: 200, bottom: 40 }, view)).toBe(false)
    expect(needsReveal({ left: 0, top: 0, right: 600, bottom: 40 }, view)).toBe(false)
  })
  it('露出一半或完全在外：要滚', () => {
    expect(needsReveal({ left: 550, top: 0, right: 650, bottom: 40 }, view)).toBe(true)
    expect(needsReveal({ left: -20, top: 0, right: 80, bottom: 40 }, view)).toBe(true)
    expect(needsReveal({ left: 700, top: 0, right: 800, bottom: 40 }, view)).toBe(true)
  })
  it('纵向列表同理', () => {
    expect(needsReveal({ left: 0, top: 30, right: 100, bottom: 82 }, { left: 0, top: 0, right: 400, bottom: 60 })).toBe(true)
  })
})

describe('menuPosition：会话菜单锚在触发点旁边，不出屏', () => {
  const m = { width: 184, height: 152 }
  it('放得下就放在触发点右下', () => {
    expect(menuPosition(100, 100, m, 393, 851)).toEqual({ left: 100, top: 100 })
  })
  it('放不下就往回收，留 8px 边', () => {
    expect(menuPosition(380, 840, m, 393, 851)).toEqual({ left: 393 - 184 - 8, top: 851 - 152 - 8 })
    expect(menuPosition(-5, -5, m, 393, 851)).toEqual({ left: 8, top: 8 })
  })
})
