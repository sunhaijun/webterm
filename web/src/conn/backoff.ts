/** 指数退避（协议 §5.2 步骤③ / AC-2.9）。 */

export interface BackoffOptions {
  base?: number
  factor?: number
  max?: number
  /** 抖动比例，0.2 = ±20% */
  jitter?: number
  random?: () => number
}

export class Backoff {
  private readonly base: number
  private readonly factor: number
  private readonly max: number
  private readonly jitter: number
  private readonly random: () => number
  private attempt = 0

  constructor(opts: BackoffOptions = {}) {
    this.base = opts.base ?? 500
    this.factor = opts.factor ?? 1.5
    this.max = opts.max ?? 15_000
    this.jitter = opts.jitter ?? 0.2
    this.random = opts.random ?? Math.random
  }

  /** 下一次重试的延迟（毫秒）。 */
  next(): number {
    const raw = Math.min(this.base * this.factor ** this.attempt, this.max)
    this.attempt++
    // 抖动是为了让多个标签页/多台设备不要在同一毫秒一起重连
    const spread = raw * this.jitter
    return Math.round(raw - spread + this.random() * spread * 2)
  }

  /** 连接成功、或网络恢复事件到来时重置。 */
  reset(): void {
    this.attempt = 0
  }

  get attempts(): number {
    return this.attempt
  }
}
