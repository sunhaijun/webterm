/**
 * 带预算的写入器（AC-5.16，[ADR-0024](../../../docs/20-architecture/adr/0024-scrollback-layered-model.md) §2）。
 *
 * 回放、快照恢复、回看期间的强制写入都是【一次几百 KB 到 1 MiB】的大块。整块交给
 * xterm 不会冻住页面（它按 ~12ms 的预算分片解析），但会连着占掉几十帧 —— 这期间
 * 滚动就是卡的。这里把大块切成每帧至多 `WRITE_BUDGET` 字节。
 *
 * 【顺序绝不改】。xterm 不能前插，"先写最后一屏再补历史"只会把顺序搞乱。所以
 * 所有写入都从这一个写入器过、严格 FIFO：大块还在滴的时候到达的实时帧排在它
 * 后面，不允许插队。三条路（回放 / 快照恢复 / 强制写入）合用同一个写入器的理由
 * 就在这 —— 各写各的就没有统一的顺序可言。
 *
 * 【不怕切在转义序列中间】。xterm 的解析器是流式的，跨 write 的分片与网络分片
 * 同形。（agent 侧"硬裁剪可能切断转义序列"是另一回事，见 ADR-0024 §不做的。）
 *
 * 不碰 DOM，sink 就是 term.write，方便单测。
 */

/** 每帧最多交给 xterm 的字节数。64 KiB 是初值，按实测调（AC-5.16）。 */
export const WRITE_BUDGET = 64 << 10

/**
 * 下一帧。页面隐藏时 rAF 不再触发，退到 setTimeout —— 否则切到后台的标签页
 * 会把队列一直攒着，切回来时是一大坨。
 */
export const nextFrame = (fn: () => void): void => {
  if (typeof requestAnimationFrame === 'function' && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) {
    requestAnimationFrame(fn)
  } else {
    setTimeout(fn, 16)
  }
}

/** `done` 在这一块【全部】交给 sink 之后调用（回放用它收 replayDepth 的窗口）。 */
export type WriteSink = (data: Uint8Array, done?: () => void) => void

export interface BudgetWriterOptions {
  /** 每帧预算，默认 `WRITE_BUDGET`。 */
  budget?: number
  /** 调度器，默认下一帧。测试注入手动版。 */
  schedule?: (fn: () => void) => void
}

interface Item {
  data: Uint8Array
  /** 已经写出去多少 —— 大块跨帧写，这是断点。 */
  off: number
  done?: () => void
}

export class BudgetWriter {
  private readonly items: Item[] = []
  private queued = 0
  private scheduled = false
  private readonly budget: number
  private readonly schedule: (fn: () => void) => void

  constructor(
    private readonly sink: WriteSink,
    opts: BudgetWriterOptions = {},
  ) {
    this.budget = opts.budget ?? WRITE_BUDGET
    this.schedule = opts.schedule ?? nextFrame
  }

  /** 还排着多少字节没交给 xterm。 */
  get pending(): number {
    return this.queued
  }

  /**
   * 写一块，受预算约束。
   *
   * 【小块且没有积压时直接写】：实时帧本来就已经按帧合并过了（`OutputQueue`），
   * 再压一帧只是白白多等 16ms。一旦有积压就必须排队，否则实时帧会插到还没滴完的
   * 回放前面去 —— 那就是顺序错乱。
   */
  write(data: Uint8Array, done?: () => void): void {
    if (data.length === 0) {
      done?.()
      return
    }
    if (this.items.length === 0 && data.length <= this.budget) {
      this.sink(data, done)
      return
    }
    this.items.push({ data, off: 0, done })
    this.queued += data.length
    this.kick()
  }

  /**
   * 立刻写完：把积压连同 `data` 一次性交给 xterm，不受预算约束。
   *
   * 用在 AC-5.9 那几个"一次写完"的时刻（回到底部 / 点提示条 / 输入 / 占屏程序
   * 启动 / 回放到达）—— 那些时刻用户等的就是完整的那一屏，慢滴反而不对。
   */
  writeNow(data?: Uint8Array, done?: () => void): void {
    const pend = this.items.splice(0)
    this.queued = 0
    for (const it of pend) this.sink(it.off === 0 ? it.data : it.data.subarray(it.off), it.done)
    if (data && data.length > 0) this.sink(data, done)
    else done?.()
  }

  /**
   * 丢掉积压（`terminal.reset()`：屏幕要按服务端缓冲重建，攒着的旧字节没有意义）。
   *
   * 【done 照样要调】—— 它是回放窗口的收尾，丢了数据却不收窗口，之后用户敲的字
   * 会被一直当成"回放期间的自动应答"吞掉（ADR-0020）。
   */
  clear(): void {
    const pend = this.items.splice(0)
    this.queued = 0
    for (const it of pend) it.done?.()
  }

  private kick(): void {
    if (this.scheduled) return
    this.scheduled = true
    this.schedule(() => {
      this.scheduled = false
      this.tick()
    })
  }

  private tick(): void {
    let left = this.budget
    while (left > 0 && this.items.length > 0) {
      const it = this.items[0]!
      const rest = it.data.length - it.off
      const n = Math.min(rest, left)
      left -= n
      this.queued -= n
      if (n === rest) {
        this.items.shift()
        this.sink(it.off === 0 ? it.data : it.data.subarray(it.off), it.done)
      } else {
        this.sink(it.data.subarray(it.off, it.off + n))
        it.off += n
      }
    }
    if (this.items.length > 0) this.kick()
  }
}
