/** Exponential backoff (protocol §5.2 step 3 / AC-2.9). */

export interface BackoffOptions {
  base?: number
  factor?: number
  max?: number
  /** Jitter ratio; 0.2 = ±20% */
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

  /** Delay before the next retry, in ms. */
  next(): number {
    const raw = Math.min(this.base * this.factor ** this.attempt, this.max)
    this.attempt++
    // Jitter keeps many tabs / devices from reconnecting in the same millisecond
    const spread = raw * this.jitter
    return Math.round(raw - spread + this.random() * spread * 2)
  }

  /** Reset on a successful connection or when the network comes back. */
  reset(): void {
    this.attempt = 0
  }

  get attempts(): number {
    return this.attempt
  }
}
