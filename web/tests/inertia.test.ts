import { describe, expect, it } from 'vitest'

import { decay, FLICK_WINDOW_MS, HALF_LIFE_MS, MAX_VELOCITY, MIN_SAMPLE_MS, MIN_VELOCITY, moving, sample, shouldFling, smooth, velocity } from '../src/term/inertia'

describe('惯性滚动的衰减（AC-5.15 / UT-scroll-1）', () => {
  it('ms <= 0 没有速度信息，不是无限快（与 hswipe.switchDelta 同一条规则）', () => {
    expect(velocity(60, 0), 'ms = 0').toBe(0)
    expect(velocity(60, -5), 'ms < 0').toBe(0)
    expect(velocity(16, 16), '真手指：一帧走 16px').toBeCloseTo(1, 6)
  })

  it('采样过短 = 【没采到】，返回原值而不是把已有速度冲淡', () => {
    const v = 0.8
    expect(sample(v, 60, MIN_SAMPLE_MS / 2), '0.1ms 这种间隔只可能是合成事件或松手前的尾巴').toBe(v)
    expect(sample(v, 60, 0), 'dt = 0 同理').toBe(v)
    // 够长才算一个样本，按平滑混进去
    expect(sample(0, 16, 16)).toBeCloseTo(0.7, 6)
    // 【按帧采】：一帧里堆了 3 个 touchmove，位移累加成一个样本，速度才量得准
    expect(sample(0, 36, 16), '一帧走了 36px').toBeCloseTo(smooth(0, 36 / 16), 6)
  })

  it('一串"没采到"不会把速度磨没 —— 松手时还认得出这是一次甩动', () => {
    let v = 0
    for (let i = 0; i < 5; i++) v = sample(v, 12, 16) // 五帧正常采样
    const sampled = v
    for (let i = 0; i < 5; i++) v = sample(v, 1, 1) // 松手前一串过短的尾巴
    expect(v, '尾巴不该改变速度').toBe(sampled)
    expect(shouldFling(v, 0, false), '这仍然是一次甩动').toBe(true)
  })

  it('速度有上限，方向保留', () => {
    expect(velocity(1000, 10)).toBe(MAX_VELOCITY)
    expect(velocity(-1000, 10)).toBe(-MAX_VELOCITY)
  })

  it('半衰期恒定，与帧率无关 —— 掉帧不会让它滑得更远', () => {
    const v0 = 2
    expect(decay(v0, HALF_LIFE_MS)).toBeCloseTo(v0 / 2, 6)
    // 一帧 32ms（掉了一帧）与两帧各 16ms，衰减到同一个值
    expect(decay(v0, 32)).toBeCloseTo(decay(decay(v0, 16), 16), 6)
    expect(decay(v0, 0), 'dt = 0 不动').toBe(v0)
  })

  it('单调递减，且有限时间内停下来（E2E-37 断言 1 秒内停）', () => {
    let v = MAX_VELOCITY
    let t = 0
    let prev = v
    while (moving(v)) {
      v = decay(v, 16)
      expect(Math.abs(v)).toBeLessThan(Math.abs(prev))
      prev = v
      t += 16
      expect(t, '不能滑不完').toBeLessThan(1000)
    }
    expect(t, '最猛的一甩也在 1 秒内停').toBeLessThan(1000)
  })

  it('滑行距离有界：最猛的一甩也不会甩出几屏', () => {
    let v = MAX_VELOCITY
    let dist = 0
    while (moving(v)) {
      dist += Math.abs(v) * 16
      v = decay(v, 16)
    }
    // 理论上限 v0 * HALF_LIFE / ln2 ≈ 692px
    expect(dist).toBeGreaterThan(300)
    expect(dist).toBeLessThan(800)
  })

  it('平滑：新样本占多数，但压得住单帧抖动', () => {
    expect(smooth(0, 1)).toBeCloseTo(0.7, 6)
    // 稳定速度 1 连采几次会收敛到 1
    let v = 0
    for (let i = 0; i < 10; i++) v = smooth(v, 1)
    expect(v).toBeCloseTo(1, 3)
    // 一帧抖动不会把速度带飞
    expect(smooth(1, 0)).toBeCloseTo(0.3, 6)
  })

  it('shouldFling：速度见底、手指停住再抬、prefers-reduced-motion，三者任一都不接管', () => {
    expect(shouldFling(1, 0, false), '正常甩动').toBe(true)
    expect(shouldFling(MIN_VELOCITY / 2, 0, false), '速度见底').toBe(false)
    expect(shouldFling(1, FLICK_WINDOW_MS + 1, false), '停住再抬手不是甩动').toBe(false)
    expect(shouldFling(1, 0, true), 'reduced-motion 下不做惯性').toBe(false)
    expect(shouldFling(-1, 0, false), '向上甩同样接管').toBe(true)
  })
})
