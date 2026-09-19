/**
 * 输入路径的分段探针（AC-3.17，[ADR-0020](../../../docs/20-architecture/adr/0020-input-never-silently-dropped.md) 推论三）。
 *
 * ADR-0020 立了"绝不静默丢弃 / 失活"的原则，却没有回答**怎么确认它没被违反**。
 * 四条路修完之后再遇到"打字没反应"，第一步仍然是猜。这里给每一段留一个计数与
 * **最近一次发生的时刻**：
 *
 *   按键到达页面 → 焦点在终端 → xterm 吐出 onData → 发给 agent → agent 确认
 *
 * 断点落在哪一段，看哪一段的"最近一次"没跟上前一段即可。
 *
 * 【按最近一次比，不按总量比】。总量是页面打开以来的累计，卡住之前那些成功的
 * 输入早把它撑满了 —— 拿总量判，任何时候都显示"一切正常"。
 */

/** 一段：发生过多少次，最近一次在什么时候（`Date.now()`，0 = 从没发生）。 */
export interface Segment {
  n: number
  at: number
}

export type SegmentName = 'keydown' | 'toTerm' | 'data' | 'sent'

/** 取快照那一刻的全部事实。`verdictOf` 只看它，方便单测。 */
export interface InputSnapshot {
  keydown: Segment
  toTerm: Segment
  data: Segment
  sent: Segment
  /** 被回放门丢掉的次数（自动应答，ADR-0020 决策二）。用户按键出现在这里就是 bug。 */
  gated: number
  /** 发了但 agent 还没 ack 的字节。涨着不降 = 没送到，或 agent 那侧写不进 PTY。 */
  unackedBytes: number
  /** 当前焦点元素的 className —— 焦点问题一眼可见。 */
  focus: string
  sid: number | null
}

/** 最近这么久没按过键，就没什么可判的。 */
export const STALE_MS = 10_000
/** 发出去这么久还没 ack，就当没送到。 */
export const ACK_MS = 2_000

/**
 * 断点在哪一段。
 *
 * 规则是"后一段的最近一次没跟上前一段"，顺着输入的流向从前往后问，第一个断的就是它。
 * 同一次按键里四段的时刻通常落在同一毫秒，所以比较用【严格小于】：相等算跟上了。
 */
export function verdictOf(s: InputSnapshot, now: number): string {
  if (s.keydown.n === 0 || now - s.keydown.at > STALE_MS) {
    return '最近没有按键 —— 先敲几个键再看（计数按最近一次发生判，不按总量判）'
  }
  if (s.toTerm.at < s.keydown.at) {
    return `焦点不在终端（当前在 ${s.focus || '(无)'}）—— 点一下终端。这是 bug，请连 inputStats 一起提`
  }
  if (s.data.at < s.toTerm.at) {
    return '卡在 xterm：多半是组字状态没复位（composing 恒真），或按键被应用级快捷键拦下'
  }
  if (s.sent.at < s.data.at) {
    return s.gated > 0
      ? '被回放门丢掉了 —— 用户按键不该出现在 gated 里，这是 bug'
      : '没发出去：看状态条是不是"重连中"，以及离线队列是不是满了'
  }
  if (s.unackedBytes > 0 && now - s.sent.at > ACK_MS) {
    return 'agent 没确认：连接可能假在线（僵尸连接），或 agent 那侧 PTY 写不进'
  }
  return '四段都通：输入已经送达 agent —— 程序还是没反应就不在 webterm 内（前台程序不读 stdin，或进了别的模式，例如 tmux 的 copy-mode）'
}

/** 计数器。全局一份：三个文件（app / store / connection）都要往里记，穿参数反而更绕。 */
export class InputTrace {
  private readonly seg: Record<SegmentName, Segment> = {
    keydown: { n: 0, at: 0 },
    toTerm: { n: 0, at: 0 },
    data: { n: 0, at: 0 },
    sent: { n: 0, at: 0 },
  }
  private gated = 0

  bump(name: SegmentName, now = Date.now()): void {
    const s = this.seg[name]
    s.n++
    s.at = now
  }

  /** 回放门丢掉了一次（自动应答）。 */
  bumpGated(): void {
    this.gated++
  }

  snapshot(extra: { unackedBytes: number; focus: string; sid: number | null }): InputSnapshot {
    return {
      keydown: { ...this.seg.keydown },
      toTerm: { ...this.seg.toTerm },
      data: { ...this.seg.data },
      sent: { ...this.seg.sent },
      gated: this.gated,
      ...extra,
    }
  }

  reset(): void {
    for (const k of Object.keys(this.seg) as SegmentName[]) this.seg[k] = { n: 0, at: 0 }
    this.gated = 0
  }
}

/** 快照 + 判断，排成人能一眼读的形状（`__webterm.inputStats()` 的返回值）。 */
export function viewOf(s: InputSnapshot, now: number) {
  const seg = (x: Segment) => ({ n: x.n, agoMs: x.at === 0 ? -1 : now - x.at })
  return {
    keydown: seg(s.keydown),
    toTerm: seg(s.toTerm),
    data: seg(s.data),
    sent: seg(s.sent),
    gated: s.gated,
    unackedBytes: s.unackedBytes,
    focus: s.focus,
    sid: s.sid,
    verdict: verdictOf(s, now),
  }
}

export const inputTrace = new InputTrace()
