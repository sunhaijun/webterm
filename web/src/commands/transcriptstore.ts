/**
 * 转录状态（ADR-0012 γ）：按会话存 claude / codex 的对话条目。
 *
 * 来源两条：WS 的 transcript 增量（reset 先清空）和 HTTP 回放（重连 / 切会话补齐）。
 * 两条会重叠，按 id 去重。
 */
import type { Transcript, TranscriptItem } from '../protocol/messages'

export interface TranscriptState {
  source: 'claude' | 'codex' | null
  active: boolean
  items: TranscriptItem[]
}

export interface TranscriptSnapshot {
  sid: number
  source: 'claude' | 'codex'
  active: boolean
  items: TranscriptItem[]
}

export class TranscriptStore {
  private readonly by = new Map<number, { state: TranscriptState; seen: Set<string> }>()

  get(sid: number): TranscriptState | undefined {
    return this.by.get(sid)?.state
  }

  /** WS 增量。返回 true 表示状态有变化（用来触发重渲染）。 */
  apply(msg: Transcript): boolean {
    let e = this.by.get(msg.sid)
    if (!e || msg.reset) {
      e = { state: { source: msg.source, active: true, items: [] }, seen: new Set() }
      this.by.set(msg.sid, e)
    }
    e.state.source = msg.source
    return this.append(e, msg.items) || !!msg.reset
  }

  /** HTTP 回放：整份替换，但保留已有条目的顺序去重（不会闪一下清空）。 */
  replace(snap: TranscriptSnapshot): void {
    const e = { state: { source: snap.source, active: snap.active, items: [] as TranscriptItem[] }, seen: new Set<string>() }
    this.append(e, snap.items)
    this.by.set(snap.sid, e)
  }

  /** 命令结束：标记不再活跃（条目留着，直到下一轮 reset 或会话关闭）。 */
  finish(sid: number): void {
    const e = this.by.get(sid)
    if (e) e.state.active = false
  }

  clear(sid: number): void {
    this.by.delete(sid)
  }

  private append(e: { state: TranscriptState; seen: Set<string> }, items: TranscriptItem[]): boolean {
    let changed = false
    for (const it of items) {
      if (e.seen.has(it.id)) continue
      e.seen.add(it.id)
      e.state.items.push(it)
      changed = true
    }
    return changed
  }
}

/** 读视图要不要显示转录：前台正在跑的程序是我们有转录格式的那两个。 */
export function aiSourceOf(program: string | null): 'claude' | 'codex' | null {
  return program === 'claude' || program === 'codex' ? program : null
}
