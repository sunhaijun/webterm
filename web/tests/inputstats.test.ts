import { describe, expect, it } from 'vitest'

import { ACK_MS, InputTrace, type InputSnapshot, STALE_MS, verdictOf, viewOf } from '../src/keys/inputstats'

const T = 1_000_000

/** A keystroke that passes all four stages, all in the same millisecond (as real ones do). */
function healthy(at = T): InputSnapshot {
  return {
    keydown: { n: 3, at },
    toTerm: { n: 3, at },
    data: { n: 3, at },
    sent: { n: 3, at },
    gated: 0,
    unackedBytes: 0,
    focus: 'xterm-helper-textarea',
    sid: 1,
  }
}

describe('UT-inputstats-1 which stage input stops at (AC-3.17)', () => {
  it('points outside webterm when all four stages pass', () => {
    const v = verdictOf(healthy(), T)
    expect(v).toContain('All four stages OK')
    expect(v, 'should say the cause is outside webterm').toContain('outside webterm')
  })

  it('draws no conclusion without recent keystrokes and asks to type first', () => {
    expect(verdictOf(healthy(T - STALE_MS - 1), T)).toContain('type a few keys')
    expect(verdictOf({ ...healthy(), keydown: { n: 0, at: 0 } }, T)).toContain('type a few keys')
  })

  it('blames focus when keydown advances but toTerm lags, and says where focus is', () => {
    const s = healthy()
    s.keydown = { n: 4, at: T } // another key press
    s.toTerm = { n: 3, at: T - 5000 } // that never reached the terminal
    const v = verdictOf(s, T)
    expect(v).toContain('Focus is not in the terminal')
    expect(v, 'must name where focus is').toContain(s.focus)
  })

  it('blames xterm when toTerm keeps up but data lags (the shape of a stuck composition)', () => {
    const s = healthy()
    s.keydown = { n: 4, at: T }
    s.toTerm = { n: 4, at: T }
    s.data = { n: 3, at: T - 5000 }
    expect(verdictOf(s, T)).toContain('Stuck in xterm')
  })

  it('reports not sent when data keeps up but sent lags, with a different message when gated > 0', () => {
    const s = healthy()
    s.sent = { n: 3, at: T - 5000 }
    expect(verdictOf(s, T)).toContain('Not sent')
    expect(verdictOf({ ...s, gated: 2 }, T), 'user keystrokes in gated are a bug').toContain('replay gate')
  })

  it('blames the agent when input was sent but unacked bytes do not drop', () => {
    const s = healthy(T - ACK_MS - 1)
    s.keydown = { n: 4, at: T - ACK_MS - 1 }
    s.unackedBytes = 7
    expect(verdictOf(s, T)).toContain('Agent has not acked')
    // Just sent and not acked yet is fine
    expect(verdictOf({ ...healthy(T), unackedBytes: 7 }, T)).toContain('All four stages OK')
  })

  it('counts all four stages in the same millisecond as keeping up, as real keystrokes are', () => {
    expect(verdictOf(healthy(T), T)).toContain('All four stages OK')
  })
})

describe('UT-inputstats-2 counters and view', () => {
  it('bump counts and records the latest time', () => {
    const t = new InputTrace()
    t.bump('keydown', 100)
    t.bump('keydown', 200)
    t.bumpGated()
    const s = t.snapshot({ unackedBytes: 0, focus: 'x', sid: 2 })
    expect(s.keydown).toEqual({ n: 2, at: 200 })
    expect(s.data, 'a stage that never happened is 0/0').toEqual({ n: 0, at: 0 })
    expect(s.gated).toBe(1)
    expect(s.sid).toBe(2)
  })

  it('snapshot is a copy that later bumps do not change', () => {
    const t = new InputTrace()
    t.bump('data', 100)
    const s = t.snapshot({ unackedBytes: 0, focus: '', sid: null })
    t.bump('data', 300)
    expect(s.data).toEqual({ n: 1, at: 100 })
  })

  it('viewOf turns times into "how long ago", -1 for never', () => {
    const t = new InputTrace()
    t.bump('keydown', T)
    const v = viewOf(t.snapshot({ unackedBytes: 0, focus: 'f', sid: 1 }), T + 250)
    expect(v.keydown).toEqual({ n: 1, agoMs: 250 })
    expect(v.data, 'never happened').toEqual({ n: 0, agoMs: -1 })
    expect(v.verdict).toBeTruthy()
  })

  it('reset clears everything', () => {
    const t = new InputTrace()
    t.bump('sent', 1)
    t.bumpGated()
    t.reset()
    const s = t.snapshot({ unackedBytes: 0, focus: '', sid: null })
    expect(s.sent).toEqual({ n: 0, at: 0 })
    expect(s.gated).toBe(0)
  })
})
