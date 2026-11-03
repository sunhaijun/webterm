/**
 * Input resend queue (protocol §5.3).
 *
 * Per session:
 *   inSeqNext: the next in_seq to assign
 *   pending:   input sent but not yet acked
 */

/**
 * Cap on pending bytes: what the agent's per-session input queue holds (protocol §5.6), so
 * a resend after reconnecting always fits. Exceeding it raises a visible error instead of
 * dropping silently.
 */
export const PENDING_LIMIT = 256 * 1024

export interface PendingItem {
  seq: number
  bytes: Uint8Array
}

export class PendingFullError extends Error {
  constructor() {
    super('Input buffer full')
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
   * Assigns a seq and queues the bytes. Returns the item to send.
   *
   * Throws PendingFullError when full; the caller must tell the user the offline input
   * buffer is full rather than drop input silently.
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
   * Handles an ack by dropping what was confirmed.
   *
   * A partially acked item has its acked prefix trimmed rather than being kept or dropped
   * whole.
   */
  ack(inAck: number): void {
    const kept: PendingItem[] = []
    let bytes = 0
    for (const it of this.items) {
      const end = it.seq + it.bytes.length
      if (end <= inAck) continue // Fully acked
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
   * After a reconnect, trims at welcome.resumed[].in_ack and returns what to resend in
   * ascending seq order.
   *
   * inSeqNext also rewinds to in_ack + remaining bytes; otherwise the next push would skip
   * seqs and the agent would close the connection with input_gap.
   */
  resumeFrom(inAck: number): readonly PendingItem[] {
    this.ack(inAck)
    this.next = inAck + this.bytes
    return this.items
  }

  /** Clears the queue when the session is gone. */
  reset(): void {
    this.items = []
    this.bytes = 0
    this.next = 0
  }
}
