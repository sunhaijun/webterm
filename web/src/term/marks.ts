/**
 * 输出流里的行锚点 —— ADR-0011 分片 ④「在终端里看 定位到该块」。
 *
 * 块是按 out_seq（字节）切的，xterm 的缓冲是按行的，两者之间没有现成的映射。
 * 这里在写入时【把帧在 out_seq 位置切开】，在前半段解析完的回调里登记一个
 * xterm marker —— 那一刻光标所在的行就是该 out_seq 对应的行。marker 随
 * scrollback 一起移动、滚出保留窗口就自行失效，我们不维护行号。
 *
 * 前提：command.start/end 先于包含其 out_seq 的输出帧到达（协议 §4 有承诺，
 * agent 先发事件再推帧）。帧已经先到的（老 agent、续传）就登记不了 ——
 * markAt 返回 false，定位退回文本搜索。
 */
import type { IMarker, Terminal } from '@xterm/xterm'

interface Pending {
  seq: number
  key: string
}

/** 待登记锚点的上限：后台会话收得到 command.* 却收不到帧，别让它无限长。 */
const MAX_PENDING = 200
/** 已登记 marker 的上限：块流自己也只保留有限的块。 */
const MAX_MARKS = 600

export class MarkTracker {
  private pending: Pending[] = []
  private readonly marks = new Map<string, IMarker>()
  /** 已经写进 xterm 的 out_seq 水位；-1 = 还没写过。 */
  private written = -1

  constructor(private readonly term: Terminal) {}

  /** 想在 out_seq = seq 处登记锚点 key。那个位置已经写过去了就返回 false。 */
  markAt(seq: number, key: string): boolean {
    if (this.written >= 0 && seq < this.written) return false
    this.pending.push({ seq, key })
    this.pending.sort((a, b) => a.seq - b.seq)
    if (this.pending.length > MAX_PENDING) this.pending.splice(0, this.pending.length - MAX_PENDING)
    return true
  }

  /**
   * 写一帧。startSeq 是 data[skip] 那个字节的 out_seq；skip 是不计数的渲染前缀长度
   * （reset 回放帧开头那 4 个字节）。落在 [startSeq, startSeq+len] 的锚点把帧切开，
   * 在切口处登记 marker。切口在帧尾的（seq == end）也在这一帧登记，不等下一帧。
   */
  write(data: Uint8Array, startSeq: number, skip = 0): void {
    const term = this.term
    const body = data.subarray(skip)
    const end = startSeq + body.length
    this.written = end
    if (this.pending.length === 0 || this.pending[0]!.seq > end) {
      term.write(data)
      return
    }
    let pos = 0 // body 内偏移
    let first = true
    const writePart = (to: number, cb?: () => void) => {
      // 不计数的前缀连同第一段一起写
      const part = first ? data.subarray(0, skip + to) : body.subarray(pos, to)
      first = false
      pos = to
      term.write(part, cb)
    }
    while (this.pending.length > 0 && this.pending[0]!.seq <= end) {
      const m = this.pending.shift()!
      if (m.seq < startSeq) continue // 位置已经过去了，登记不了
      writePart(m.seq - startSeq, () => this.register(m.key))
    }
    if (pos < body.length || first) writePart(body.length)
  }

  private register(key: string): void {
    const marker = this.term.registerMarker(0)
    if (!marker) return
    this.marks.get(key)?.dispose()
    this.marks.set(key, marker)
    marker.onDispose(() => {
      if (this.marks.get(key) === marker) this.marks.delete(key)
    })
    if (this.marks.size > MAX_MARKS) {
      const oldest = this.marks.keys().next().value
      if (oldest !== undefined) {
        this.marks.get(oldest)?.dispose()
        this.marks.delete(oldest)
      }
    }
  }

  /** 取锚点；已经随 scrollback 滚掉的算没有。 */
  get(key: string): IMarker | undefined {
    const m = this.marks.get(key)
    return m && !m.isDisposed ? m : undefined
  }

  /** 缓冲重置（reset 回放 / term.reset）：行号全部作废，水位归零。 */
  reset(): void {
    for (const m of this.marks.values()) m.dispose()
    this.marks.clear()
    this.pending = []
    this.written = -1
  }

  get pendingCount(): number {
    return this.pending.length
  }
}
