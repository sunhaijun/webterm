/**
 * Per-stage probe of the input path (AC-3.17, corollary 3 of
 * [ADR-0020](../../../docs/20-architecture/adr/0020-input-never-silently-dropped.md)).
 *
 * ADR-0020 says input is never silently dropped or dead, but not how to check that it
 * holds. Without this, debugging "typing does nothing" starts with guessing. Each stage
 * keeps a count and the time of its most recent event:
 *
 *   key reaches the page → focus in terminal → xterm emits onData → sent to agent → agent acks
 *
 * The break is at the first stage whose most recent event lags the previous stage's.
 *
 * Compare most recent events, not totals. Totals accumulate since page load, and the
 * successful input before the hang dominates them, so they would always say "all good".
 */

/** One stage: how many times it happened and when last (`Date.now()`, 0 = never). */
export interface Segment {
  n: number
  at: number
}

export type SegmentName = 'keydown' | 'toTerm' | 'data' | 'sent'

/** Everything known at snapshot time. `verdictOf` reads only this, which keeps it unit-testable. */
export interface InputSnapshot {
  keydown: Segment
  toTerm: Segment
  data: Segment
  sent: Segment
  /** Count dropped by the replay gate (automatic replies, ADR-0020 decision 2). User keystrokes here are a bug. */
  gated: number
  /** Bytes sent but not yet acked. Growing and never shrinking = not arriving, or the agent can't write to the PTY. */
  unackedBytes: number
  /** className of the focused element, so focus problems are obvious at a glance. */
  focus: string
  sid: number | null
}

/** No keystroke within this window means there is nothing to diagnose. */
export const STALE_MS = 10_000
/** Sent this long ago without an ack counts as not delivered. */
export const ACK_MS = 2_000

/**
 * Which stage the input stops at.
 *
 * Walking downstream, the first stage whose most recent event lags the previous stage's
 * is the break. All four stages of one keystroke usually land in the same millisecond, so
 * the comparison is strictly-less-than: equal counts as keeping up.
 */
export function verdictOf(s: InputSnapshot, now: number): string {
  if (s.keydown.n === 0 || now - s.keydown.at > STALE_MS) {
    return 'No recent keystrokes: type a few keys, then check again (stages compare the most recent event, not totals)'
  }
  if (s.toTerm.at < s.keydown.at) {
    return `Focus is not in the terminal (it is on ${s.focus || '(none)'}): tap the terminal. This is a bug; please report it with inputStats`
  }
  if (s.data.at < s.toTerm.at) {
    return 'Stuck in xterm: most likely IME composition never reset (composing stuck at true), or an app-level shortcut caught the key'
  }
  if (s.sent.at < s.data.at) {
    return s.gated > 0
      ? 'Dropped by the replay gate: user keystrokes should never be gated. This is a bug'
      : 'Not sent: check whether the banner says "Reconnecting" and whether the offline queue is full'
  }
  if (s.unackedBytes > 0 && now - s.sent.at > ACK_MS) {
    return 'Agent has not acked: the connection may be a zombie, or the agent cannot write to the PTY'
  }
  return 'All four stages OK: input reached the agent. If the program still does not react, the cause is outside webterm (the foreground program is not reading stdin, or is in a mode of its own)'
}

/** The counters. A single global: the controller, session store and connection all record into it, and threading it through as a parameter would be messier. */
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

  /** The replay gate dropped one (an automatic reply). */
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

/** Snapshot plus verdict in a human-readable shape (the return value of `__webterm.inputStats()`). */
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
