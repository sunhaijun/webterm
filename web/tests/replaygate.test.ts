/**
 * UT-replay-2：回放门只吞【自动应答】，不吞【用户按键】（AC-2.15 / ADR-0020）。
 *
 * 两样东西都从 xterm 的 onData 出来，区别在于谁产生的：
 *   · 自动应答（DSR / DA …）同步发生在 term.write() 的解析里；
 *   · 用户按键同步发生在一次 DOM 输入事件的派发里。
 * 按"此刻是否在回放"一刀切，就会把用户正在敲的字一起吞掉 —— 而回放窗口在
 * ring_bytes 满载时是秒级的。这组用例把两者摆在同一个回放窗口里，一次断言两边。
 */
import { describe, expect, it } from 'vitest'

import type { Connection } from '../src/conn/connection'
import type { SessionInfo } from '../src/protocol/messages'
import { SessionStore } from '../src/sessions/store'
import { inUserInputEvent } from '../src/term/userinput'

const enc = (s: string) => new TextEncoder().encode(s)

/** 一个能逼出自动应答的查询：DSR-CPR，xterm 会回 `ESC[行;列R`。 */
const CPR_QUERY = '\x1b[6n'

function info(sid: number): SessionInfo {
  return {
    sid,
    name: 's',
    name_is_manual: false,
    cwd: '/tmp',
    status: 'running',
    exit_code: null,
    cols: 80,
    rows: 24,
    integration: 'active',
    prompt_state: null,
    base_seq: 0,
    head_seq: 0,
    created_at: 0,
  }
}

function makeStore() {
  const sent: string[] = []
  const store = new SessionStore({} as unknown as Connection, () => 14, {
    onChange() {},
    onModeChange() {},
    onTermData: (_sid, data) => sent.push(data),
    allowKey: () => true,
    onInteractive() {},
  })
  store.upsert(info(1))
  return { store, sent }
}

/**
 * 模拟"用户按了一个键"：xterm 的 onData 是在 keydown 派发里【同步】触发的，
 * 这里用同一个形状 —— 在一次 keydown 的监听器里调 term.input()。
 * 不能直接调 term.input()：那样就没有正在派发的事件，和自动应答分不开了。
 */
function typeInsideKeydown(store: SessionStore, text: string): void {
  const el = document.createElement('div')
  document.body.appendChild(el)
  el.addEventListener('keydown', () => store.termOf(1)!.term.input(text))
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }))
  el.remove()
}

/** 等 xterm 把排着的 write 解析完（它是 setTimeout 分片的）。 */
const parsed = () => new Promise((r) => setTimeout(r, 30))

describe('UT-replay-2 回放门', () => {
  it('回放期间：历史查询的自动应答不进 PTY', async () => {
    const { store, sent } = makeStore()
    store.write(1, enc(CPR_QUERY), true)
    await parsed()
    expect(sent, 'CPR 应答是终端自己答的，不是用户输入').toEqual([])
  })

  it('回放期间：用户的按键照常进 PTY', async () => {
    const { store, sent } = makeStore()
    store.write(1, enc(CPR_QUERY), true) // replayDepth 升起来，且还没解析
    typeInsideKeydown(store, 'x')
    await parsed()
    expect(sent, '回放窗口里敲的字不能被吞掉').toEqual(['x'])
  })

  it('不在回放时：自动应答照常回 —— 那是实时输出，程序在等这个答复', async () => {
    const { store, sent } = makeStore()
    store.write(1, enc(CPR_QUERY), false)
    await parsed()
    expect(sent.length).toBe(1)
    expect(sent[0]).toMatch(/^\x1b\[\d+;\d+R$/)
  })

  it('回放解析完之后，自动应答恢复正常', async () => {
    const { store, sent } = makeStore()
    store.write(1, enc(CPR_QUERY), true)
    await parsed()
    expect(sent).toEqual([])

    store.write(1, enc(CPR_QUERY), false)
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

  it('键盘 / 粘贴 / 组字事件里为真', () => {
    expect(fire('keydown', (t) => new KeyboardEvent(t))).toBe(true)
    expect(fire('keypress', (t) => new KeyboardEvent(t))).toBe(true)
    expect(fire('beforeinput', (t) => new InputEvent(t))).toBe(true)
    expect(fire('input', (t) => new InputEvent(t))).toBe(true)
    expect(fire('compositionend', (t) => new CompositionEvent(t))).toBe(true)
    expect(fire('compositionupdate', (t) => new CompositionEvent(t))).toBe(true)
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
