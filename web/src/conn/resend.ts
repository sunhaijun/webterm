/**
 * 输入重发队列（协议 §5.3）。
 *
 * 每会话维护：
 *   inSeqNext —— 下一个要分配的 in_seq
 *   pending   —— 已发送但未被 ack 的输入
 */

/** pending 上限。超出时【明确提示】而不是静默丢弃。 */
export const PENDING_LIMIT = 64 * 1024

export interface PendingItem {
  seq: number
  bytes: Uint8Array
}

export class PendingFullError extends Error {
  constructor() {
    super('离线输入已满')
    this.name = 'PendingFullError'
  }
}

export class ResendQueue {
  private next = 0
  private items: PendingItem[] = []
  private bytes = 0

  get inSeqNext(): number {
    return this.next
  }

  get pendingBytes(): number {
    return this.bytes
  }

  get pending(): readonly PendingItem[] {
    return this.items
  }

  /**
   * 分配 seq 并入队。返回要发出去的条目。
   *
   * 队列满时抛 PendingFullError —— 调用方必须在 UI 上明确提示
   * "离线输入已满"，**不要静默丢弃**。
   */
  push(bytes: Uint8Array): PendingItem {
    if (this.bytes + bytes.length > PENDING_LIMIT) throw new PendingFullError()
    const item: PendingItem = { seq: this.next, bytes }
    this.next += bytes.length
    this.items.push(item)
    this.bytes += bytes.length
    return item
  }

  /**
   * 收到 ack：丢弃已确认的部分。
   *
   * 某项被【部分】ack 时要裁掉它的前部，而不是整条留着或整条丢掉。
   */
  ack(inAck: number): void {
    const kept: PendingItem[] = []
    let bytes = 0
    for (const it of this.items) {
      const end = it.seq + it.bytes.length
      if (end <= inAck) continue // 整条都被确认了
      if (it.seq >= inAck) {
        kept.push(it)
        bytes += it.bytes.length
        continue
      }
      const cut = inAck - it.seq
      const rest = { seq: inAck, bytes: it.bytes.subarray(cut) }
      kept.push(rest)
      bytes += rest.bytes.length
    }
    this.items = kept
    this.bytes = bytes
  }

  /**
   * 重连后按 welcome.resumed[].in_ack 裁剪，返回要【按 seq 升序重发】的内容。
   *
   * inSeqNext 也要跟着回退到 in_ack + 剩余长度 —— 否则下一次 push 分配的
   * seq 会跳空，agent 会判 input_gap 关连接。
   */
  resumeFrom(inAck: number): readonly PendingItem[] {
    this.ack(inAck)
    this.next = inAck + this.bytes
    return this.items
  }

  /** 会话结束（gone）时清空。 */
  reset(): void {
    this.items = []
    this.bytes = 0
    this.next = 0
  }
}
