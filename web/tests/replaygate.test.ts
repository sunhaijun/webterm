/**
 * UT-replay-2：回放门只吞【自动应答】，不吞【用户输入】（AC-2.15 / ADR-0020，input.md §回放门）。
 *
 * 两样东西都从 xterm 的 onData 出来，区别在于谁产生的：
 *   · 自动应答（DSR / DA …）同步发生在 term.write() 的解析里；
 *   · 用户按键、附加键、文本页同步发生在一次 DOM 输入事件的派发里。
 * 按"此刻是否在回放"一刀切，就会把用户正在敲的字一起吞掉。这组用例把两者摆在同一个
 * 回放窗口里，一次断言两边。回放 = 补课的 OUTPUT（catchup_to 之前）与 SNAPSHOT。
 */
import { describe, expect, it } from 'vitest'

import { inputTrace } from '../src/keys/inputstats'
import { SessionStore, type ConnLike } from '../src/sessions/store'
import { USER_INPUT_EVENTS, inUserInputEvent } from '../src/term/userinput'
import { info } from './helpers'

const enc = (s: string) => new TextEncoder().encode(s)

/** 一个能逼出自动应答的查询：DSR-CPR，xterm 会回 `ESC[行;列R`。 */
const CPR_QUERY = '\x1b[6n'

const fakeConn: ConnLike = {
  subscribe() {},
  unsubscribe() {},
  forget() {},
  outSeqOf: () => 0,
  headSeqOf: () => 0,
  isUnread: () => false,
}

function makeStore() {
  const sent: string[] = []
  const store = new SessionStore(fakeConn, {
    onChange() {},
    onData: (_sid, data) => sent.push(data),
    allowKey: () => true,
    theme: () => undefined,
    fontSize: () => 14,
  })
  store.upsert(info(1))
  return { store, sent }
}

/**
 * 模拟"用户在某个事件的派发里产生了输入"：xterm 的 onData 是在 keydown 派发里【同步】
 * 触发的，附加键是在 pointerup 里同步调 term.input()。这里用同一个形状。
 */
function inputInside(store: SessionStore, type: string, text: string): void {
  const el = document.createElement('div')
  document.body.appendChild(el)
  el.addEventListener(type, () => store.termOf(1)!.term.input(text, true))
  el.dispatchEvent(new Event(type, { bubbles: true }))
  el.remove()
}

/** 等 xterm 把排着的 write 解析完（它是 setTimeout 分片的）。 */
const parsed = () => new Promise((r) => setTimeout(r, 30))

describe('UT-replay-2 回放门', () => {
  it('补课期间：历史查询的自动应答不进 PTY，并计入 gated', async () => {
    const { store, sent } = makeStore()
    const before = inputTrace.snapshot({ unackedBytes: 0, focus: '', sid: 1 }).gated
    store.output(1, enc(CPR_QUERY), true)
    await parsed()
    expect(sent, 'CPR 应答是终端自己答的，不是用户输入').toEqual([])
    expect(inputTrace.snapshot({ unackedBytes: 0, focus: '', sid: 1 }).gated).toBe(before + 1)
  })

  it('补课期间：用户的按键照常进 PTY', async () => {
    const { store, sent } = makeStore()
    store.output(1, enc(CPR_QUERY), true) // 回放窗口打开，且还没解析
    inputInside(store, 'keydown', 'x')
    await parsed()
    expect(sent, '回放窗口里敲的字不能被吞掉').toEqual(['x'])
  })

  it('补课期间：附加键（pointerdown / pointerup 里的 term.input）照常进 PTY', async () => {
    const { store, sent } = makeStore()
    store.output(1, enc(CPR_QUERY), true)
    inputInside(store, 'pointerup', '\x1b[A')
    inputInside(store, 'pointerdown', '\t')
    await parsed()
    expect(sent).toEqual(['\x1b[A', '\t'])
  })

  it('写快照期间同样开门：用户输入放行', async () => {
    const { store, sent } = makeStore()
    store.snapshot(1, enc('\x1b[H\x1b[2Jhello' + CPR_QUERY))
    inputInside(store, 'keydown', 'y')
    await parsed()
    expect(sent).toEqual(['y'])
  })

  it('不在回放时：自动应答照常回 —— 那是实时输出，程序在等这个答复', async () => {
    const { store, sent } = makeStore()
    store.output(1, enc(CPR_QUERY), false)
    await parsed()
    expect(sent.length).toBe(1)
    expect(sent[0]).toMatch(/^\x1b\[\d+;\d+R$/)
  })

  it('回放解析完之后，自动应答恢复正常', async () => {
    const { store, sent } = makeStore()
    store.output(1, enc(CPR_QUERY), true)
    await parsed()
    expect(sent).toEqual([])

    store.output(1, enc(CPR_QUERY), false)
    await parsed()
    expect(sent.length, '回放门只管回放那一段').toBe(1)
  })
})

describe('UT-replay-2 判据：正在派发的是不是用户输入事件', () => {
  const fire = (type: string, ctor: (t: string) => Event) => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    let seen = false
    el.addEventListener(type, () => (seen = inUserInputEvent()))
    el.dispatchEvent(ctor(type))
    el.remove()
    return seen
  }

  it('键盘 / 粘贴 / 组字 / 附加键的指针事件里为真', () => {
    expect(fire('keydown', (t) => new KeyboardEvent(t))).toBe(true)
    expect(fire('keypress', (t) => new KeyboardEvent(t))).toBe(true)
    expect(fire('beforeinput', (t) => new InputEvent(t))).toBe(true)
    expect(fire('input', (t) => new InputEvent(t))).toBe(true)
    expect(fire('compositionend', (t) => new CompositionEvent(t))).toBe(true)
    expect(fire('compositionupdate', (t) => new CompositionEvent(t))).toBe(true)
    expect(fire('pointerdown', (t) => new Event(t))).toBe(true)
    expect(fire('pointerup', (t) => new Event(t))).toBe(true)
  })

  it('表里至少有 input.md 列的那九个', () => {
    for (const t of ['keydown', 'keypress', 'beforeinput', 'input', 'paste', 'compositionend', 'compositionupdate', 'pointerdown', 'pointerup']) {
      expect(USER_INPUT_EVENTS.has(t), t).toBe(true)
    }
  })

  it('WebSocket 的 message 事件里为假 —— 回放就是从那儿灌进来的', () => {
    expect(fire('message', (t) => new MessageEvent(t))).toBe(false)
  })

  it('不产生输入的事件里为假', () => {
    expect(fire('scroll', (t) => new Event(t))).toBe(false)
    expect(fire('resize', (t) => new Event(t))).toBe(false)
  })

  it('没有正在派发的事件时为假（定时器分片解析走的就是这条）', async () => {
    expect(inUserInputEvent()).toBe(false)
    const inTimer = await new Promise<boolean>((r) => setTimeout(() => r(inUserInputEvent()), 0))
    expect(inTimer).toBe(false)
  })
})
