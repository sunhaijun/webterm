/**
 * 惯性滚动的衰减（AC-5.15，[ADR-0024](../../../docs/20-architecture/adr/0024-scrollback-layered-model.md) §2）。
 *
 * 纯函数，由 `pinch.ts` 的单指纵向拖调用。速度一律是 **px/ms**，与
 * `hswipe.ts` 的横滑判定同一套口径 —— 包括那条最要紧的规则：
 *
 * 【`ms <= 0` 当成"没有速度信息"而不是"无限快"】。真手指不可能零耗时，而合成
 * 事件（测试、自动化）常常同一毫秒发完；把它当甩动，一次轻点就能把屏幕甩飞。
 */

/** 速度衰减的半衰期：每 120ms 减半。 */
export const HALF_LIFE_MS = 120
/** 低于它就算停了（px/ms）。约等于每帧半个像素。 */
export const MIN_VELOCITY = 0.04
/** 速度上限（px/ms）。挡住异常时间戳甩出几屏 —— 4 px/ms 已经是很猛的一甩。 */
export const MAX_VELOCITY = 4
/** 手指停住超过它再抬起，就不是甩动：松手前最后一段没有速度，惯性不该接管。 */
export const FLICK_WINDOW_MS = 60
/**
 * 短于它的采样不算速度。
 *
 * 浏览器把 touchmove 合并到每帧一个（~16ms），比这更密的间隔【只可能是合成事件】——
 * 测试与自动化常常同一 tick 发完整段拖动，`now - lastMoveAt` 是 0.1ms 这种量级，
 * 除出来是几百 px/ms。那不是"甩得猛"，是没有速度信息，与 `ms <= 0` 同一类。
 */
export const MIN_SAMPLE_MS = 4
/** 末速度的平滑系数：新样本占七成，压掉单帧抖动又不迟钝。 */
const SMOOTH = 0.7

/** 一段位移的速度。`ms <= 0` 没有速度信息（见文件头）。 */
export function velocity(dy: number, ms: number): number {
  if (ms <= 0) return 0
  const v = dy / ms
  return Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, v))
}

/** 指数平滑：把新样本混进已有速度。 */
export function smooth(prev: number, v: number): number {
  return v * SMOOTH + prev * (1 - SMOOTH)
}

/**
 * 采一次速度。
 *
 * 【采样过短 = 没采到，不是速度 0】。返回原值而不是把已有速度冲淡 —— 这两件事
 * 差别很大：松手前的最后一小段常常只隔 1~2ms，按"速度 0"混进去会把刚量准的
 * 速度打掉三成，一次正常的甩动就飞不起来了。
 *
 * 调用方【按帧采】而不是按事件采：主线程忙的时候 touchmove 会一帧堆好几个，
 * 每个样本的 dt 都接近 0，按事件采等于把速度全丢了。
 */
export function sample(prev: number, dy: number, ms: number): number {
  if (ms < MIN_SAMPLE_MS) return prev
  return smooth(prev, velocity(dy, ms))
}

/** 衰减 `dt` 毫秒之后的速度。半衰期恒定，与帧率无关 —— 掉帧不会让它滑得更远。 */
export function decay(v: number, dt: number): number {
  if (dt <= 0) return v
  return v * Math.pow(2, -dt / HALF_LIFE_MS)
}

/** 还在动吗。 */
export function moving(v: number): boolean {
  return Math.abs(v) >= MIN_VELOCITY
}

/**
 * 松手时该不该接管。`sinceLastMove` 是最后一次 touchmove 到 touchend 的间隔。
 *
 * `reduced`（`prefers-reduced-motion`）下一律不接管：惯性是新增的动效，
 * 与横滑切会话的处理一致。
 */
export function shouldFling(v: number, sinceLastMove: number, reduced: boolean): boolean {
  return !reduced && moving(v) && sinceLastMove <= FLICK_WINDOW_MS
}
