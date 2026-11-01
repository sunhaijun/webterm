/**
 * UT-replay-2: the replay gate swallows automatic replies, never user input (AC-2.15 /
 * ADR-0020, input.md).
 *
 * Both come out of xterm's onData; what differs is who produced them:
 *   · automatic replies (DSR / DA …) happen synchronously while term.write() parses;
 *   · keystrokes, extra keys and the text page happen synchronously inside a DOM input event.
 * Gating on "are we replaying right now" alone would also swallow what the user is typing.
 * These cases put both in the same replay window and assert on both. Replay = catch-up
 * OUTPUT (before catchup_to) and SNAPSHOT.
 */
import { describe, expect, it } from 'vitest'

import { inputTrace } from '../src/keys/inputstats'
import { SessionStore, type ConnLike } from '../src/sessions/store'
import { USER_INPUT_EVENTS, inUserInputEvent } from '../src/term/userinput'
import { info } from './helpers'

const enc = (s: string) => new TextEncoder().encode(s)

/** A query that forces an automatic reply: DSR-CPR, answered by xterm with `ESC[row;colR`. */
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
 * Simulates user input produced inside an event dispatch: xterm fires onData synchronously
 * inside keydown, and extra keys call term.input() synchronously inside pointerup. Same shape here.
 */
function inputInside(store: SessionStore, type: string, text: string): void {
  const el = document.createElement('div')
  document.body.appendChild(el)
  el.addEventListener(type, () => store.termOf(1)!.term.input(text, true))
  el.dispatchEvent(new Event(type, { bubbles: true }))
  el.remove()
}

/** Waits for xterm to parse queued writes (it chunks with setTimeout). */
const parsed = () => new Promise((r) => setTimeout(r, 30))

describe('UT-replay-2 replay gate', () => {
  it('during catch-up, automatic replies to old queries stay out of the PTY and count as gated', async () => {
    const { store, sent } = makeStore()
    const before = inputTrace.snapshot({ unackedBytes: 0, focus: '', sid: 1 }).gated
    store.output(1, enc(CPR_QUERY), true)
    await parsed()
    expect(sent, 'the CPR reply came from the terminal, not the user').toEqual([])
    expect(inputTrace.snapshot({ unackedBytes: 0, focus: '', sid: 1 }).gated).toBe(before + 1)
  })

  it('during catch-up, user keystrokes still reach the PTY', async () => {
    const { store, sent } = makeStore()
    store.output(1, enc(CPR_QUERY), true) // replay window open and not parsed yet
    inputInside(store, 'keydown', 'x')
    await parsed()
    expect(sent, 'typing during the replay window must not be swallowed').toEqual(['x'])
  })

  it('during catch-up, extra keys (term.input inside pointerdown / pointerup) still reach the PTY', async () => {
    const { store, sent } = makeStore()
    store.output(1, enc(CPR_QUERY), true)
    inputInside(store, 'pointerup', '\x1b[A')
    inputInside(store, 'pointerdown', '\t')
    await parsed()
    expect(sent).toEqual(['\x1b[A', '\t'])
  })

  it('opens the gate while writing a snapshot too, letting user input through', async () => {
    const { store, sent } = makeStore()
    store.snapshot(1, enc('\x1b[H\x1b[2Jhello' + CPR_QUERY))
    inputInside(store, 'keydown', 'y')
    await parsed()
    expect(sent).toEqual(['y'])
  })

  it('lets automatic replies through outside replay: that is live output and the program is waiting for the answer', async () => {
    const { store, sent } = makeStore()
    store.output(1, enc(CPR_QUERY), false)
    await parsed()
    expect(sent.length).toBe(1)
    expect(sent[0]).toMatch(/^\x1b\[\d+;\d+R$/)
  })

  it('lets automatic replies through again once the replay is parsed', async () => {
    const { store, sent } = makeStore()
    store.output(1, enc(CPR_QUERY), true)
    await parsed()
    expect(sent).toEqual([])

    store.output(1, enc(CPR_QUERY), false)
    await parsed()
    expect(sent.length, 'the gate only covers the replayed part').toBe(1)
  })
})

describe('UT-replay-2 the test: is a user input event being dispatched', () => {
  const fire = (type: string, ctor: (t: string) => Event) => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    let seen = false
    el.addEventListener(type, () => (seen = inUserInputEvent()))
    el.dispatchEvent(ctor(type))
    el.remove()
    return seen
  }

  it('is true inside keyboard / paste / composition / extra-key pointer events', () => {
    expect(fire('keydown', (t) => new KeyboardEvent(t))).toBe(true)
    expect(fire('keypress', (t) => new KeyboardEvent(t))).toBe(true)
    expect(fire('beforeinput', (t) => new InputEvent(t))).toBe(true)
    expect(fire('input', (t) => new InputEvent(t))).toBe(true)
    expect(fire('compositionend', (t) => new CompositionEvent(t))).toBe(true)
    expect(fire('compositionupdate', (t) => new CompositionEvent(t))).toBe(true)
    expect(fire('pointerdown', (t) => new Event(t))).toBe(true)
    expect(fire('pointerup', (t) => new Event(t))).toBe(true)
  })

  it('includes at least the nine listed in input.md', () => {
    for (const t of ['keydown', 'keypress', 'beforeinput', 'input', 'paste', 'compositionend', 'compositionupdate', 'pointerdown', 'pointerup']) {
      expect(USER_INPUT_EVENTS.has(t), t).toBe(true)
    }
  })

  it('is false inside a WebSocket message event, which is where replay comes from', () => {
    expect(fire('message', (t) => new MessageEvent(t))).toBe(false)
  })

  it('is false inside events that produce no input', () => {
    expect(fire('scroll', (t) => new Event(t))).toBe(false)
    expect(fire('resize', (t) => new Event(t))).toBe(false)
  })

  it('is false with no event being dispatched (the timer-driven chunked parsing path)', async () => {
    expect(inUserInputEvent()).toBe(false)
    const inTimer = await new Promise<boolean>((r) => setTimeout(() => r(inUserInputEvent()), 0))
    expect(inTimer).toBe(false)
  })
})
