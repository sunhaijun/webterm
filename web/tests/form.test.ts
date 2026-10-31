/** UT-form-1：形态由屏幕短边决定（AC-5.18，ADR-0025 §1）。 */
import { describe, expect, it } from 'vitest'

import { COMPACT_BELOW, formOf, showsExtraKeys } from '../src/app/form'

describe('UT-form-1 形态', () => {
  it('短边 < 600 是 compact，否则 wide', () => {
    expect(COMPACT_BELOW).toBe(600)
    expect(formOf(393, 851), 'Pixel 5 竖屏').toBe('compact')
    expect(formOf(851, 393), 'Pixel 5 横屏：仍是 compact').toBe('compact')
    expect(formOf(430, 932), 'iPhone Pro Max').toBe('compact')
    expect(formOf(599, 1000)).toBe('compact')
    expect(formOf(600, 1000)).toBe('wide')
    expect(formOf(768, 1024), 'iPad mini').toBe('wide')
    expect(formOf(1024, 768), 'iPad mini 横屏').toBe('wide')
    expect(formOf(1440, 900), '桌面').toBe('wide')
  })

  it('判据只看屏幕：旋转（宽高互换）不改变形态', () => {
    for (const [w, h] of [
      [393, 851],
      [768, 1024],
      [1440, 900],
    ] as const) {
      expect(formOf(w, h)).toBe(formOf(h, w))
    }
  })

  it('附加键：compact 恒显示，wide 只在 pointer: coarse 时显示', () => {
    expect(showsExtraKeys('compact', false)).toBe(true)
    expect(showsExtraKeys('compact', true)).toBe(true)
    expect(showsExtraKeys('wide', true)).toBe(true)
    expect(showsExtraKeys('wide', false)).toBe(false)
  })
})
