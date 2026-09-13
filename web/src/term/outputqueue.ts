/**
 * 输出写入队列：按帧合并 + 回看时暂停跟随（docs/40-frontend/session-ux.md §回看时暂停跟随）。
 *
 * 两件事，一个队列：
 *  1. 【合并】跟随中（视口贴底）的帧攒到下一帧再一次 write —— claude 这种每秒几十个
 *     碎帧的流，解析与渲染次数按帧算而不是按包算。
 *  2. 【暂停】用户滚上去读旧输出时，新到的字节只入队不写 xterm：解析和渲染都省掉，
 *     滚动不再和它们抢主线程。回到底部一次性写入，顺序不变、一个字节不丢 ——
 *     序号与 ack 在连接层收到时就记好了，跟这里写不写无关。
 *
 * 不碰 xterm，也不碰 DOM，方便单测。sink 就是 term.write。
 */
export interface Parked {
  lines: number
  bytes: number
}

/**
 * 跟随状态 —— 右下角提示条按它渲染。
 * `following=false` 提示条就在（哪怕还没有新输出，写「回到底部」）；
 * `parked` 是暂停以来用户还没看到的新增量（null = 还没有新输出）。
 */
export interface FollowState {
  following: boolean
  parked: Parked | null
}

export interface OutputQueueOptions {
  /** 暂停期间队列最多攒多少字节，超过就强制写入（内存上限）。默认 2 MiB。 */
  maxBytes?: number
  /** 暂停期间队列最多攒多少行，超过就强制写入 —— 再多也会被 scrollback 裁掉。默认 4000。 */
  maxLines?: number
  /** 合并写入的调度器。默认下一帧（页面隐藏时退到 setTimeout）。测试注入同步版。 */
  schedule?: (fn: () => void) => void
  /** 跟随状态 / 新增量变化时的通知（给提示条用）。 */
  onState?: (s: FollowState) => void
}

const defaultSchedule = (fn: () => void) => {
  if (typeof requestAnimationFrame === 'function' && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) {
    requestAnimationFrame(fn)
  } else {
    setTimeout(fn, 16)
  }
}

export class OutputQueue {
  private chunks: Uint8Array[] = []
  /** 队列里的量 —— 内存上限按它算，写出去就清零。 */
  private queuedBytes = 0
  private queuedLines = 0
  /** 暂停以来的新增总量 —— 提示条按它计数。强制写入不清零：那些行用户还没看到。 */
  private unseenBytes = 0
  private unseenLines = 0
  private following = true
  private scheduled = false
  private readonly maxBytes: number
  private readonly maxLines: number
  private readonly schedule: (fn: () => void) => void
  private readonly onState?: (s: FollowState) => void

  constructor(
    private readonly sink: (data: Uint8Array) => void,
    opts: OutputQueueOptions = {},
  ) {
    this.maxBytes = opts.maxBytes ?? 2 << 20
    this.maxLines = opts.maxLines ?? 4000
    this.schedule = opts.schedule ?? defaultSchedule
    this.onState = opts.onState
  }

  /** 是否在跟随（视口贴底）。 */
  get isFollowing(): boolean {
    return this.following
  }

  /** 暂停以来用户还没看到的新增量；跟随中或还没有新输出时为 null。 */
  get parked(): Parked | null {
    if (this.following || this.unseenBytes === 0) return null
    return { lines: this.unseenLines, bytes: this.unseenBytes }
  }

  get state(): FollowState {
    return { following: this.following, parked: this.parked }
  }

  /**
   * 视口贴底 ⇄ 滚上去。回到底部时把攒下的一次写掉。
   * 返回这次调用有没有真的写入。
   */
  setFollowing(f: boolean): boolean {
    if (f === this.following) return false
    this.following = f
    let had = false
    if (f) {
      had = this.chunks.length > 0
      this.drain()
      this.unseenBytes = 0
      this.unseenLines = 0
    }
    this.notify()
    return had
  }

  /** 收到一帧输出。返回它的去向，测试用。 */
  push(data: Uint8Array): 'batched' | 'parked' | 'flushed' {
    this.chunks.push(data)
    const lines = countNewlines(data)
    this.queuedBytes += data.length
    this.queuedLines += lines
    if (this.following) {
      if (!this.scheduled) {
        this.scheduled = true
        this.schedule(() => {
          this.scheduled = false
          this.drain()
        })
      }
      return 'batched'
    }
    this.unseenBytes += data.length
    this.unseenLines += lines
    if (this.queuedBytes > this.maxBytes || this.queuedLines > this.maxLines) {
      // 攒过头了：强制写入。视口位置由 xterm 维持，用户不会被拽到底部
      this.drain()
      this.notify()
      return 'flushed'
    }
    this.notify()
    return 'parked'
  }

  /** 立刻把队列里的全部内容按顺序写入（回放到达前、切会话、销毁时用）。 */
  drain(): void {
    if (this.chunks.length === 0) return
    let out: Uint8Array
    if (this.chunks.length === 1) {
      out = this.chunks[0]!
    } else {
      out = new Uint8Array(this.queuedBytes)
      let off = 0
      for (const c of this.chunks) {
        out.set(c, off)
        off += c.length
      }
    }
    this.chunks = []
    this.queuedBytes = 0
    this.queuedLines = 0
    this.sink(out)
  }

  /** 丢掉队列（终端 reset 时：屏幕要按服务端缓冲重建，攒着的旧字节没有意义）。 */
  clear(): void {
    this.chunks = []
    this.queuedBytes = 0
    this.queuedLines = 0
    this.unseenBytes = 0
    this.unseenLines = 0
    this.notify()
  }

  private notify(): void {
    this.onState?.(this.state)
  }
}

function countNewlines(data: Uint8Array): number {
  let n = 0
  for (let i = 0; i < data.length; i++) if (data[i] === 0x0a) n++
  return n
}
