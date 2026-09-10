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

import { anchorTranslate } from '../src/term/pinch'

describe('anchorTranslate（锚定缩放）', () => {
  it('手势起点锚下的内容点，缩放后仍在锚点下', () => {
    // startMid=100, startT=0, startScale=1 → 锚下内容点 p0=100
    // 放到 scale=2、当前锚点仍在 mid=100：t 应让 p0*2 + t = 100
    const t = anchorTranslate(100, 100, 0, 1, 2)
    expect(100 * 2 + t).toBe(100)
    expect(t).toBe(-100)
  })
  it('锚点漂移 = 顺带平移：mid 变了，内容点跟着锚点走', () => {
    const t = anchorTranslate(160, 100, 0, 1, 2) // 中点从 100 漂到 160
    expect(100 * 2 + t, 'p0(=100) 现在压在 160 下').toBe(160)
  })
  it('从已放大状态再放大也保持锚点：scale 1→2 后 2→3', () => {
    const t2 = anchorTranslate(100, 100, 0, 1, 2) // = -100
    const p0 = (100 - t2) / 2 // 100 下的内容点
    const t3 = anchorTranslate(100, 100, t2, 2, 3)
    expect(p0 * 3 + t3).toBeCloseTo(100, 6)
  })
})
