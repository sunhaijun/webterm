/**
 * 终端区单指手势的轴锁与横滑判定（AC-4.7）。
 *
 * 纯函数，由 `pinch.ts` 调用；规则见
 * docs/40-frontend/session-ux.md §左右滑动切换。
 */

/** 锁定方向前要走够的像素。小于它算抖动，谁都不给 —— 和浏览器原生滚动的 touch slop 同量级。 */
export const LOCK_PX = 12
/** 位移过它就算切换。 */
export const SWITCH_PX = 80
/** 甩动：速度过它也算切换（px/ms）。 */
export const SWITCH_VELOCITY = 0.5
/** 但甩动另有位移下限 —— 否则一次轻微的快抖就把会话切走了。 */
export const FLICK_MIN_PX = 24

export type Axis = 'none' | 'x' | 'y'

/** 前 LOCK_PX 像素里谁占优谁拿走整段手势；锁定后调用方不再改判。 */
export function lockAxis(dx: number, dy: number): Axis {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (ax < LOCK_PX && ay < LOCK_PX) return 'none'
  return ax > ay ? 'x' : 'y'
}

/**
 * 松手时切几格：`+1` 下一个（左滑）、`-1` 上一个（右滑）、`0` 不切。
 *
 * `ms <= 0` 当成「没有速度信息」而不是「无限快」：真手指不可能零耗时，
 * 而合成事件（测试、自动化）常常同一毫秒发完 —— 把它当甩动会误切。
 */
export function switchDelta(dx: number, ms: number): -1 | 0 | 1 {
  const ax = Math.abs(dx)
  if (ax < FLICK_MIN_PX) return 0
  const v = ms > 0 ? ax / ms : 0
  if (ax < SWITCH_PX && v < SWITCH_VELOCITY) return 0
  return dx < 0 ? 1 : -1
}
