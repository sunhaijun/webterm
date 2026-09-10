import { describe, expect, it } from 'vitest'

import { MAX_SCALE, MIN_SCALE, clampPan, clampScale, dist } from '../src/term/pinch'

/** UT-pinch：双指缩放的纯数学（ADR-0013）。 */
describe('pinch math', () => {
  it('clampScale 夹在 [1,3]', () => {
    expect(clampScale(0.5)).toBe(MIN_SCALE)
    expect(clampScale(2)).toBe(2)
    expect(clampScale(9)).toBe(MAX_SCALE)
  })
  it('dist 是欧氏距离', () => {
    expect(dist(0, 0, 3, 4)).toBe(5)
  })
  it('clampPan：origin 左上，平移只能在 [-(scale-1)*size, 0]', () => {
    expect(clampPan(50, 2, 400), '正数拖不动（会露出左/上边）').toBe(0)
    expect(clampPan(-100, 2, 400)).toBe(-100)
    expect(clampPan(-9999, 2, 400), '拖过头夹到 -(2-1)*400').toBe(-400)
    expect(clampPan(-100, 1, 400), '1× 不能平移').toBe(0)
  })
})
