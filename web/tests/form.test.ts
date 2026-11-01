/** UT-form-1: the form factor comes from the screen's short side (AC-5.18, ADR-0025 §1). */
import { describe, expect, it } from 'vitest'

import { COMPACT_BELOW, formOf, showsExtraKeys } from '../src/app/form'

describe('UT-form-1 form factor', () => {
  it('is compact when the short side is < 600, wide otherwise', () => {
    expect(COMPACT_BELOW).toBe(600)
    expect(formOf(393, 851), 'Pixel 5 portrait').toBe('compact')
    expect(formOf(851, 393), 'Pixel 5 landscape: still compact').toBe('compact')
    expect(formOf(430, 932), 'iPhone Pro Max').toBe('compact')
    expect(formOf(599, 1000)).toBe('compact')
    expect(formOf(600, 1000)).toBe('wide')
    expect(formOf(768, 1024), 'iPad mini').toBe('wide')
    expect(formOf(1024, 768), 'iPad mini landscape').toBe('wide')
    expect(formOf(1440, 900), 'desktop').toBe('wide')
  })

  it('depends only on the screen: rotation (swapped width/height) does not change it', () => {
    for (const [w, h] of [
      [393, 851],
      [768, 1024],
      [1440, 900],
    ] as const) {
      expect(formOf(w, h)).toBe(formOf(h, w))
    }
  })

  it('shows extra keys always on compact, on wide only with pointer: coarse', () => {
    expect(showsExtraKeys('compact', false)).toBe(true)
    expect(showsExtraKeys('compact', true)).toBe(true)
    expect(showsExtraKeys('wide', true)).toBe(true)
    expect(showsExtraKeys('wide', false)).toBe(false)
  })
})
