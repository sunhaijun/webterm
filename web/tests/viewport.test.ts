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
