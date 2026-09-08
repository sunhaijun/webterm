/**
 * 命令块 —— 把"一条命令 + 它的输出"当成一个可折叠的整体。
 *
 * 手机上一屏只有二十来行，而 `npm install` 动辄几百行。连续的 scrollback
 * 逼着人用手指去翻找"上一条命令在哪结束、失败的是哪一条"。
 *
 * 【这些边界服务端早就知道】：shell 集成走 OSC 133，cmd_start / cmd_end
 * 两条消息各自带着 out_seq —— 也就是这条命令的输出在字节流里的
 * 起止偏移，外加命令原文、cwd、退出码、时长。协议里一直有，
 * 只是主终端视图把它们扔了，照旧画一个连续的 VT 网格。
 *
 * 这个模块只做一件事：把字节流按 out_seq 切成块。渲染是别人的事。
 *
 * 【保留窗口是有界的】。客户端不可能留下全部输出，服务端的环形缓冲
 * 也只有 1MB 且【没有按区间取的接口】（只有 Replay(from)）。所以块的
 * 元数据总是在，而输出只对还在窗口里的那部分可得 —— bytesOf 会明说
 * 哪些被截断了，而不是假装完整。
 */

/** reset 回放前置的 SGR reset 字节数，不计入 out_seq（见 protocol/frame.ts）。 */
const ATTR_PREFIX_LEN = 4

/** 每个会话保留的输出字节上限。超出的从最旧的一端丢。 */
export const DEFAULT_RETAIN_BYTES = 512 * 1024

export interface Block {
  cmdId: number
  text: string
  cwd: string
  /** 开始时间，epoch 毫秒。 */
  at: number
  startSeq: number
  /** null 表示还在跑。 */
  endSeq: number | null
  exitCode: number | null
  durationMs: number | null
}

export interface BlockBytes {
  bytes: Uint8Array
  /** 开头有一段已经滚出保留窗口 —— 拿到的不是完整输出。 */
  truncated: boolean
}

interface Chunk {
  /** 这块数据第一个字节的 out_seq。 */
  seq: number
  data: Uint8Array
}

interface SessionState {
  blocks: Block[]
  byId: Map<number, Block>
  chunks: Chunk[]
  bytes: number
  /** 保留窗口里最早那个字节的 out_seq。 */
  baseSeq: number
  /** 已收到的字节总数（下一个字节的 out_seq）。 */
  headSeq: number
}

export class BlockStore {
  private sessions = new Map<number, SessionState>()

  constructor(private readonly retainBytes: number = DEFAULT_RETAIN_BYTES) {}

  /**
   * 收下一段输出。
   *
   * startSeq 是【计入 seq 的第一个字节】的偏移。attrPrefix 为真时 data
   * 的前 4 字节是渲染修正、不计数，这里要跳过 —— 否则整条流的记账
   * 会整体偏移 4 字节，每个块都会切错位置。
   */
  write(sid: number, data: Uint8Array, attrPrefix: boolean, startSeq: number): void {
    const st = this.ensure(sid)
    const body = attrPrefix ? data.subarray(ATTR_PREFIX_LEN) : data

    if (attrPrefix) {
      // reset 回放：服务端的环形缓冲被覆盖过，之前的字节再也拿不回来了。
      // 【块的元数据留着】—— 命令本身还是发生过的，只是输出没了。
      st.chunks = []
      st.bytes = 0
      st.baseSeq = startSeq
    }

    if (body.length > 0) {
      st.chunks.push({ seq: startSeq, data: body })
      st.bytes += body.length
    }
    st.headSeq = startSeq + body.length
    this.evict(st)
  }

  /** cmd_start：一条命令开始，它的输出从 outSeq 起。 */
  cmdStart(sid: number, m: { cmd_id: number; text: string; cwd: string; at: number; out_seq: number }): void {
    const st = this.ensure(sid)
    if (st.byId.has(m.cmd_id)) return // 重连重放，别建重复的块
    const b: Block = {
      cmdId: m.cmd_id,
      text: m.text,
      cwd: m.cwd,
      at: m.at,
      startSeq: m.out_seq,
      endSeq: null,
      exitCode: null,
      durationMs: null,
    }
    st.blocks.push(b)
    st.byId.set(b.cmdId, b)
  }

  /**
   * cmd_end：命令结束。
   *
   * 【配不上 cmd_start 的直接丢掉】。断线跨过命令边界时会出现这种情况：
   * 只补到了结束、没有开始，那就不知道输出从哪儿起 —— 与其画一个
   * 起点可疑的块，不如不画。
   */
  cmdEnd(sid: number, m: { cmd_id: number; exit_code: number | null; duration_ms: number; out_seq: number }): void {
    const b = this.sessions.get(sid)?.byId.get(m.cmd_id)
    if (!b) return
    b.endSeq = m.out_seq
    b.exitCode = m.exit_code
    b.durationMs = m.duration_ms
  }

  /** 按时间顺序返回这个会话的块。 */
  blocks(sid: number): Block[] {
    return this.sessions.get(sid)?.blocks ?? []
  }

  /**
   * 取一个块的输出字节。
   *
   * 还在跑的块取到"到目前为止"的输出。整段都滚出窗口时返回空 + truncated。
   */
  bytesOf(sid: number, b: Block): BlockBytes | null {
    const st = this.sessions.get(sid)
    if (!st) return null
    return this.slice(st, b.startSeq, b.endSeq ?? st.headSeq)
  }

  /**
   * 尾块：最后一个块结束之后（没有块时从保留窗口起点）到当前的字节 ——
   * 没有被任何块认领的输出。
   *
   * 这是读视图的降级形态：没有 OSC 133 标记时（ssh 出去、集成不可用），
   * 所有输出都落在这里，块流退化成一个块。标记回来从那儿重新切块。
   * 有块在跑时尾块为空（那些字节归运行中的块）。
   */
  tailBytes(sid: number): BlockBytes | null {
    const st = this.sessions.get(sid)
    if (!st) return null
    const last = st.blocks[st.blocks.length - 1]
    const from = last ? (last.endSeq ?? st.headSeq) : st.baseSeq
    return this.slice(st, from, st.headSeq)
  }

  /** 有没有还在跑的块。 */
  hasRunning(sid: number): boolean {
    const st = this.sessions.get(sid)
    if (!st) return false
    const last = st.blocks[st.blocks.length - 1]
    return !!last && last.endSeq === null
  }

  private slice(st: SessionState, wantFrom: number, to: number): BlockBytes {
    const from = Math.max(wantFrom, st.baseSeq)
    const truncated = from > wantFrom
    if (to <= from) return { bytes: new Uint8Array(0), truncated }

    const out = new Uint8Array(to - from)
    let n = 0
    for (const c of st.chunks) {
      const cEnd = c.seq + c.data.length
      if (cEnd <= from) continue
      if (c.seq >= to) break
      const s = Math.max(from, c.seq)
      const e = Math.min(to, cEnd)
      out.set(c.data.subarray(s - c.seq, e - c.seq), s - from)
      n = Math.max(n, e - from)
    }
    return { bytes: out.subarray(0, n), truncated }
  }

  /** 会话关掉时把它的东西丢干净，别让内存一直涨。 */
  forget(sid: number): void {
    this.sessions.delete(sid)
  }

  /** 当前保留了多少字节（测试与诊断用）。 */
  retained(sid: number): number {
    return this.sessions.get(sid)?.bytes ?? 0
  }

  private ensure(sid: number): SessionState {
    let st = this.sessions.get(sid)
    if (!st) {
      st = { blocks: [], byId: new Map(), chunks: [], bytes: 0, baseSeq: 0, headSeq: 0 }
      this.sessions.set(sid, st)
    }
    return st
  }

  /**
   * 丢掉最旧的数据直到回到上限内。
   *
   * 【整块丢，不切半块】—— 切一半要重写 chunk，多一处能出错的地方，
   * 而这里省下的那点内存不值得。
   */
  private evict(st: SessionState): void {
    while (st.bytes > this.retainBytes && st.chunks.length > 1) {
      const c = st.chunks.shift()!
      st.bytes -= c.data.length
      st.baseSeq = c.seq + c.data.length
    }
  }
}
