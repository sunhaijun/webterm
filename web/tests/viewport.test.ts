/** UT-resize-1：resize 防抖与断点。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { breakpoint, debounce, isShort } from '../src/ui/viewport'

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

describe('断点', () => {
  it('只依据视口宽度', () => {
    expect(breakpoint(390)).toBe('phone')
    expect(breakpoint(639)).toBe('phone')
    expect(breakpoint(640)).toBe('tablet')
    expect(breakpoint(1023)).toBe('tablet')
    expect(breakpoint(1024)).toBe('desktop')
  })

  it('高度受限是叠加规则，主要针对手机横屏', () => {
    expect(isShort(390)).toBe(true)
    expect(isShort(479)).toBe(true)
    expect(isShort(480)).toBe(false)
    expect(isShort(844)).toBe(false)
  })
})

import { isKeyboardUp, KEYBOARD_MIN_PX, layoutViewportHeight } from '../src/ui/viewport'

/**
 * 键盘闸门（app.tsx applyViewport）：可视视口比【布局视口】矮一大截才算键盘弹起。
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
