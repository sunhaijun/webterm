import { describe, expect, it } from 'vitest'

import { ACK_MS, InputTrace, type InputSnapshot, STALE_MS, verdictOf, viewOf } from '../src/keys/inputstats'

const T = 1_000_000

/** 一次"四段都通"的按键，全部落在同一毫秒（真实情况就是这样）。 */
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

describe('UT-inputstats-1 断点在哪一段（AC-3.17）', () => {
  it('四段都通 → 指向 webterm 之外', () => {
    const v = verdictOf(healthy(), T)
    expect(v).toContain('四段都通')
    expect(v, '要点出 tmux copy-mode 这类"不在 webterm 内"的情形').toContain('copy-mode')
  })

  it('最近没按过键 → 不下结论，让人先敲几个键', () => {
    expect(verdictOf(healthy(T - STALE_MS - 1), T)).toContain('先敲几个键')
    expect(verdictOf({ ...healthy(), keydown: { n: 0, at: 0 } }, T)).toContain('先敲几个键')
  })

  it('焦点丢了：keydown 涨而 toTerm 没跟上 → 指向焦点，并写明焦点在哪', () => {
    const s = healthy()
    s.keydown = { n: 4, at: T } // 又按了一下
    s.toTerm = { n: 3, at: T - 5000 } // 但没到终端
    const v = verdictOf(s, T)
    expect(v).toContain('焦点不在终端')
    expect(v, '焦点在哪要直接写出来').toContain(s.focus)
  })

  it('卡在 xterm：toTerm 跟上了但 data 没有（组字没复位就是这个形状）', () => {
    const s = healthy()
    s.keydown = { n: 4, at: T }
    s.toTerm = { n: 4, at: T }
    s.data = { n: 3, at: T - 5000 }
    expect(verdictOf(s, T)).toContain('卡在 xterm')
  })

  it('没发出去：data 跟上了 sent 没有；gated > 0 时另有说法', () => {
    const s = healthy()
    s.sent = { n: 3, at: T - 5000 }
    expect(verdictOf(s, T)).toContain('没发出去')
    expect(verdictOf({ ...s, gated: 2 }, T), '用户按键出现在 gated 里是 bug').toContain('回放门')
  })

  it('agent 没确认：发出去了但 unacked 迟迟不降', () => {
    const s = healthy(T - ACK_MS - 1)
    s.keydown = { n: 4, at: T - ACK_MS - 1 }
    s.unackedBytes = 7
    expect(verdictOf(s, T)).toContain('agent 没确认')
    // 刚发出去还没来得及 ack，不算问题
    expect(verdictOf({ ...healthy(T), unackedBytes: 7 }, T)).toContain('四段都通')
  })

  it('同一毫秒内的四段算"跟上了" —— 真实按键就是同一毫秒', () => {
    expect(verdictOf(healthy(T), T)).toContain('四段都通')
  })
})

describe('UT-inputstats-2 计数与视图', () => {
  it('bump 累计次数并记下最近一次时刻', () => {
    const t = new InputTrace()
    t.bump('keydown', 100)
    t.bump('keydown', 200)
    t.bumpGated()
    const s = t.snapshot({ unackedBytes: 0, focus: 'x', sid: 2 })
    expect(s.keydown).toEqual({ n: 2, at: 200 })
    expect(s.data, '没发生过的段是 0/0').toEqual({ n: 0, at: 0 })
    expect(s.gated).toBe(1)
    expect(s.sid).toBe(2)
  })

  it('snapshot 是拷贝：拿到之后再 bump 不会改到手里那份', () => {
    const t = new InputTrace()
    t.bump('data', 100)
    const s = t.snapshot({ unackedBytes: 0, focus: '', sid: null })
    t.bump('data', 300)
    expect(s.data).toEqual({ n: 1, at: 100 })
  })

  it('viewOf 把时刻换成"多久以前"，没发生过的写 -1', () => {
    const t = new InputTrace()
    t.bump('keydown', T)
    const v = viewOf(t.snapshot({ unackedBytes: 0, focus: 'f', sid: 1 }), T + 250)
    expect(v.keydown).toEqual({ n: 1, agoMs: 250 })
    expect(v.data, '从没发生过').toEqual({ n: 0, agoMs: -1 })
    expect(v.verdict).toBeTruthy()
  })

  it('reset 清干净', () => {
    const t = new InputTrace()
    t.bump('sent', 1)
    t.bumpGated()
    t.reset()
    const s = t.snapshot({ unackedBytes: 0, focus: '', sid: null })
    expect(s.sent).toEqual({ n: 0, at: 0 })
    expect(s.gated).toBe(0)
  })
})
