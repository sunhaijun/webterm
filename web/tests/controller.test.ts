/**
 * The controller (app/controller.ts): connection ⇄ sessions ⇄ input. Only covers the
 * paths that tie modules together: subscribing after creating a session, extra keys and
 * sticky modifiers through the onData exit, the text page, Enter closing an exited
 * session, focus following the session, and agent restarts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { AppController } from '../src/app/controller'
import type { UploadOutcome } from '../src/app/uploads'
import type { WebSocketLike } from '../src/conn/connection'
import { decodeFrame, encodeFrame, TYPE_OUTPUT, TYPE_SNAPSHOT } from '../src/protocol/frame'
import { flush, info } from './helpers'

beforeAll(() => {
  // Things jsdom lacks
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
  }
  if (!('ResizeObserver' in window)) {
    ;(window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      disconnect() {}
    }
  }
})

class FakeSocket implements WebSocketLike {
  binaryType = 'arraybuffer'
  readyState = 0
  sent: (string | Uint8Array)[] = []
  onopen: ((ev: unknown) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  send(d: string | ArrayBufferLike | ArrayBufferView) {
    this.sent.push(typeof d === 'string' ? d : new Uint8Array(d as ArrayBuffer))
  }
  close() {
    this.readyState = 3
    this.onclose?.({})
  }
  open() {
    this.readyState = 1
    this.onopen?.({})
  }
  text(obj: object) {
    this.onmessage?.({ data: JSON.stringify(obj) })
  }
  frame(f: Parameters<typeof encodeFrame>[0]) {
    const b = encodeFrame(f)
    this.onmessage?.({ data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) })
  }
  msgs(t: string) {
    return this.sent.filter((s): s is string => typeof s === 'string').map((s) => JSON.parse(s)).filter((m) => m.t === t)
  }
  inputs() {
    return this.sent.filter((s): s is Uint8Array => s instanceof Uint8Array).map((b) => new TextDecoder().decode(decodeFrame(b).payload))
  }
}

const welcome = (sessions: object[], extra: object = {}) => ({
  t: 'welcome',
  protocol: 2,
  server_version: 't',
  instance_id: 'i1',
  limits: { max_sessions: 5, ring_bytes: 262144, max_frame_bytes: 262144 },
  sessions,
  resumed: [],
  ...extra,
})

let ctl: AppController
let sock: FakeSocket
let sockets: FakeSocket[]
let probeStatus = 200
let probes = 0
/** What the sign-out request resolves to; an Error rejects it (network down). */
let signOutResult: number | Error = 204
let signOuts = 0
/** What the controller sees as document.hasFocus(). */
let focused = true
/** Uploads in flight, oldest first; each resolves when the test says so. */
let pendingUploads: { file: File; done: (o: UploadOutcome) => void }[] = []
let unmount: () => void
let area: HTMLElement

function setup() {
  sockets = []
  ctl = new AppController({
    url: 'ws://t/ws',
    clientID: 'c1',
    socketFactory: () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
    authProbe: () => {
      probes++
      return Promise.resolve(probeStatus)
    },
    signOut: () => {
      signOuts++
      return signOutResult instanceof Error ? Promise.reject(signOutResult) : Promise.resolve(signOutResult)
    },
    hasFocus: () => focused,
    upload: (file) => new Promise<UploadOutcome>((done) => pendingUploads.push({ file, done })),
  })
  const root = document.createElement('div')
  const stage = document.createElement('div')
  area = document.createElement('div')
  stage.appendChild(area)
  root.appendChild(stage)
  document.body.appendChild(root)
  unmount = ctl.mount(area, root)
  sock = sockets[0]!
  sock.open()
}

/** Runs fn inside a user input event dispatch (pointerup for extra keys, keydown for the keyboard). */
function inside(type: string, fn: () => void) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  el.addEventListener(type, fn)
  el.dispatchEvent(new Event(type))
  el.remove()
}

const term = () => (window as unknown as { __webterm: { sid(): number | null } }).__webterm
/** A session's xterm instance, to simulate on-screen / physical keyboard input (`term.input(data, true)`, through onData). */
const xterm = (sid: number) =>
  (ctl as unknown as { store: { termOf(sid: number): { term: { input(data: string, wasUserInput: boolean): void } } | undefined } }).store.termOf(sid)!.term

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  probeStatus = 200
  probes = 0
  signOutResult = 204
  signOuts = 0
  focused = true
  pendingUploads = []
  setup()
})
afterEach(() => {
  unmount()
  document.body.innerHTML = ''
})

describe('session creation and subscription', () => {
  it('creates a session on the first welcome when there are none, then sends subscribe{out_seq: 0, cols, rows} after session.created', () => {
    sock.text(welcome([]))
    const create = sock.msgs('session.create')
    expect(create).toHaveLength(1)
    sock.text({ t: 'session.created', req_id: create[0].req_id, session: info(1) })
    const sub = sock.msgs('subscribe')
    expect(sub).toHaveLength(1)
    expect(sub[0]).toMatchObject({ sid: 1, out_seq: 0 })
    expect(sub[0].cols).toBeGreaterThan(0)
    expect(term().sid()).toBe(1)
    expect(sock.msgs('resize'), 'no separate resize when subscribing').toHaveLength(0)
  })

  it('does not switch to a session created in another tab', () => {
    sock.text(welcome([info(1)]))
    sock.text({ t: 'session.created', session: info(2) })
    expect(term().sid()).toBe(1)
    expect(ctl.get().sessions.map((s) => s.sid)).toEqual([1, 2])
  })

  it('voids all old sessions and shows "Session ended" when the agent restarted (instance_id changed)', async () => {
    sock.text(welcome([info(1, { name: 'old-1' }), info(2, { name: 'old-2' })]))
    expect(term().sid()).toBe(1)
    sock.close()
    expect(ctl.get().conn).toBe('reconnecting')
    await new Promise((r) => setTimeout(r, 900)) // backoff 0.5s ±20%
    const s2 = sockets[sockets.length - 1]!
    expect(s2).not.toBe(sock)
    s2.open()
    const hello = s2.msgs('hello')[0]
    expect(hello).toMatchObject({ instance_id: 'i1', resume: [{ sid: 1, out_seq: 0 }] })
    s2.text(
      welcome([info(1, { name: 'brand-new' })], {
        instance_id: 'i2',
        resumed: [{ sid: 1, status: 'gone', from_seq: 0, in_ack: 0 }],
      }),
    )
    expect(ctl.get().sessions.map((x) => `${x.sid}:${x.name}`)).toEqual(['1:brand-new'])
    expect(ctl.get().connNote?.text, 'a connection message: in the banner (ADR-0049)').toBe('Session ended (agent may have restarted)')
    expect(ctl.get().toast).toBeNull()
    expect(term().sid(), 'the new sid 1 is a different session, subscribed from 0').toBe(1)
    expect(s2.msgs('subscribe')).toMatchObject([{ sid: 1, out_seq: 0 }])
  })
})

describe('input exit', () => {
  beforeEach(() => {
    sock.text(welcome([info(1)]))
  })

  it('extra keys compute bytes from modifiers and DECCKM and go out through onData', async () => {
    inside('pointerup', () => ctl.pressKey('ArrowUp'))
    sock.frame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: new TextEncoder().encode('\x1b[?1h') })
    await new Promise((r) => setTimeout(r, 30))
    inside('pointerup', () => ctl.pressKey('ArrowUp'))
    expect(sock.inputs()).toEqual(['\x1b[A', '\x1bOA'])
  })

  it('sticky CTRL applies to the next on-screen keyboard character, but not twice to extra keys', () => {
    ctl.sticky.tap('ctrl')
    inside('pointerup', () => ctl.pressKey('ArrowLeft'))
    ctl.sticky.hold('ctrl')
    inside('pointerup', () => ctl.pressKey('Escape'))
    inside('keydown', () => xterm(1).input('c', true)) // c from the on-screen keyboard
    expect(sock.inputs()).toEqual(['\x1b[1;5D', '\x1b', '\x03'])
  })

  it('text page sends the text then a separate \\r, or just \\r when empty (ADR-0027)', () => {
    inside('keydown', () => ctl.sendText({ kind: 'submit', text: 'echo TEXT-ONE' }))
    inside('keydown', () => ctl.sendText({ kind: 'submit', text: '' }))
    expect(sock.inputs()).toEqual(['echo TEXT-ONE', '\r', '\r'])
  })

  it('text page wraps the text in bracketed paste when enabled, with Enter after the end marker', async () => {
    sock.frame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: new TextEncoder().encode('\x1b[?2004h') })
    await new Promise((r) => setTimeout(r, 30))
    inside('keydown', () => ctl.sendText({ kind: 'submit', text: '长段 prompt\n第二行' }))
    expect(sock.inputs().join('')).toBe('\x1b[200~长段 prompt\r第二行\x1b[201~\r')
  })

  it('text page ignores sticky modifiers: Enter stays \\r with ALT armed (ESC \\r is a newline in claude), and ALT stays armed', () => {
    ctl.sticky.tap('alt')
    ctl.sticky.hold('ctrl')
    inside('keydown', () => ctl.sendText({ kind: 'submit', text: 'y' }))
    expect(sock.inputs()).toEqual(['y', '\r'])
    expect(ctl.sticky.state('alt')).toBe('armed')
    expect(ctl.sticky.state('ctrl')).toBe('locked')
  })

  // UT-input-size-1: a paste the connection refuses is not followed by Enter, and the text
  // page is told so it keeps the draft (the user would otherwise lose the text and run
  // whatever was already on the line).
  it('text page: refused text sends no Enter and reports failure; accepted text reports success', () => {
    let ok = true
    inside('keydown', () => (ok = ctl.sendText({ kind: 'submit', text: 'x'.repeat(256 * 1024 + 1) })))
    expect(ok).toBe(false)
    expect(sock.inputs()).toEqual([])
    inside('keydown', () => (ok = ctl.sendText({ kind: 'submit', text: 'ls' })))
    expect(ok).toBe(true)
    expect(sock.inputs()).toEqual(['ls', '\r'])
  })

  it('exited session: Enter closes it without confirmation, other input is dropped', () => {
    sock.text({ t: 'session.updated', sid: 1, status: 'exited', exit_code: 1 })
    inside('keydown', () => xterm(1).input('ls', true))
    expect(sock.inputs()).toEqual([])
    expect(sock.msgs('session.close')).toEqual([])
    inside('keydown', () => xterm(1).input('\r', true))
    expect(sock.msgs('session.close')).toMatchObject([{ sid: 1 }])
  })

  it('exited session: text page Enter drops the text and the trailing \\r closes the session', () => {
    sock.text({ t: 'session.updated', sid: 1, status: 'exited', exit_code: 1 })
    inside('keydown', () => ctl.sendText({ kind: 'submit', text: 'ls' }))
    expect(sock.inputs()).toEqual([])
    expect(sock.msgs('session.close')).toMatchObject([{ sid: 1 }])
  })
})

describe('snapshots and the exit line', () => {
  it('SNAPSHOT clears and redraws via the store; for an exited session the exit line follows', async () => {
    sock.text(welcome([info(1, { status: 'exited', exit_code: 3, head_seq: 10 })]))
    sock.frame({ type: TYPE_SNAPSHOT, flags: 0, sid: 1, seq: 10n, payload: new TextEncoder().encode('restored\r\n') })
    const w = window as unknown as { __webterm: { text(): string; outSeq(): number; frames(): { kind: string }[] } }
    const t = (ctl as unknown as { store: { termOf(sid: number): { term: Parameters<typeof flush>[0] } } }).store.termOf(1)!.term
    await flush(t)
    await flush(t)
    expect(w.__webterm.text()).toContain('restored')
    expect(w.__webterm.text()).toContain('[Exited (code 3) · Enter to close]')
    expect(w.__webterm.outSeq()).toBe(10)
    expect(w.__webterm.frames().map((f) => f.kind)).toEqual(['SNAPSHOT'])
  })
})

describe('switching sessions', () => {
  it('Ctrl+Shift+↓ moves focus to the new session\'s terminal if it was in the terminal', () => {
    sock.text(welcome([info(1), info(2)]))
    expect(term().sid()).toBe(1)
    const helper = area.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!
    helper.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', ctrlKey: true, shiftKey: true }))
    expect(term().sid()).toBe(2)
    expect(document.activeElement?.classList.contains('xterm-helper-textarea')).toBe(true)
    expect(area.contains(document.activeElement)).toBe(true)
    expect(sock.msgs('unsubscribe')).toMatchObject([{ sid: 1 }])
  })

  it('Ctrl+Shift+B does nothing on wide', () => {
    sock.text(welcome([info(1)]))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'B', ctrlKey: true, shiftKey: true }))
    expect(ctl.get().sessionsOpen).toBe(ctl.get().form === 'compact')
  })

  it('switches to the next session after closing the active one', () => {
    sock.text(welcome([info(1), info(2), info(3)]))
    ctl.select(2)
    sock.text({ t: 'session.closed', sid: 2, exit_code: 0 })
    expect(term().sid()).toBe(3)
    expect(ctl.get().sessions.map((s) => s.index)).toEqual([1, 2])
  })
})

describe('UT-textinput-2 text page follows the session (AC-3.22 / AC-4.8, ADR-0036)', () => {
  /** The two DOM nodes the extra-keys component hands over (jsdom has no styles; only the `data-page` value matters). */
  function textPage() {
    const slot = document.createElement('div')
    slot.className = 'extrakeys'
    const ta = document.createElement('textarea')
    slot.appendChild(ta)
    document.body.appendChild(slot)
    ctl.registerTextPage({ slot, text: ta })
    return { slot, ta }
  }
  const inTerm = () => area.contains(document.activeElement)

  it('swaps page and draft on switch, focuses the new session\'s input, and restores both on switch-back', () => {
    sock.text(welcome([info(1), info(2)]))
    const { slot, ta } = textPage()
    expect([ctl.get().page, slot.dataset.page]).toEqual(['keys', 'keys'])

    ctl.togglePage()
    expect([ctl.get().page, slot.dataset.page]).toEqual(['text', 'text'])
    expect(document.activeElement).toBe(ta)
    ta.value = 'echo DRAFT-1'

    // In 1's text box → switch to 2 (on the key page): focus goes to 2's terminal, the box no longer holds 1's draft
    ctl.select(2)
    expect(term().sid()).toBe(2)
    expect([ctl.get().page, slot.dataset.page, ta.value]).toEqual(['keys', 'keys', ''])
    expect(inTerm(), 'new session on the key page: focus goes to the terminal').toBe(true)

    ctl.togglePage()
    ta.value = 'echo DRAFT-2'
    ctl.togglePage() // 2 back to the key page, draft kept
    expect(inTerm(), 'flipping back to the key page returns focus from the text box to the terminal').toBe(true)

    // In 2's terminal → switch to 1 (on the text page): focus goes to the text box, holding 1's draft
    ctl.select(1)
    expect([ctl.get().page, slot.dataset.page, ta.value]).toEqual(['text', 'text', 'echo DRAFT-1'])
    expect(document.activeElement).toBe(ta)

    ctl.select(2)
    expect([ctl.get().page, ta.value]).toEqual(['keys', 'echo DRAFT-2'])
    expect(inTerm()).toBe(true)
  })

  it('selecting the active session leaves focus alone: text page open, typing in the terminal, focus stays there', () => {
    sock.text(welcome([info(1)]))
    const { ta } = textPage()
    ctl.togglePage()
    ctl.focusTerm()
    ctl.select(1)
    expect(inTerm()).toBe(true)
    expect(document.activeElement).not.toBe(ta)
  })

  it('a new session starts on the key page with an empty draft and terminal focus; the old draft survives', () => {
    sock.text(welcome([info(1)]))
    const { ta } = textPage()
    ctl.togglePage()
    ta.value = 'half'
    ctl.newSession()
    const [create] = sock.msgs('session.create')
    sock.text({ t: 'session.created', req_id: create.req_id, session: info(2) })
    expect(term().sid()).toBe(2)
    expect([ctl.get().page, ta.value]).toEqual(['keys', ''])
    expect(inTerm()).toBe(true)
    ctl.select(1)
    expect([ctl.get().page, ta.value]).toEqual(['text', 'half'])
  })

  it('drops the draft when the session closes; a reused sid starts fresh', () => {
    sock.text(welcome([info(1), info(2)]))
    const { ta } = textPage()
    ctl.select(2)
    ctl.togglePage()
    ta.value = 'gone'
    sock.text({ t: 'session.closed', sid: 2, exit_code: 0 })
    expect(term().sid()).toBe(1)
    expect([ctl.get().page, ta.value]).toEqual(['keys', ''])
    expect(document.activeElement, 'was typing in the text box: focus goes to 1\'s input (key page → terminal)').not.toBe(ta)
    expect(inTerm()).toBe(true)

    sock.text({ t: 'session.created', session: info(2) })
    ctl.select(2)
    expect([ctl.get().page, ta.value]).toEqual(['keys', ''])
  })

  it('switching mid-composition blurs first so the IME commits, then saves the draft and swaps', () => {
    sock.text(welcome([info(1), info(2)]))
    const { ta } = textPage()
    ctl.togglePage()
    ta.value = '你'
    ta.dispatchEvent(new CompositionEvent('compositionstart'))
    const atBlur: string[] = []
    // The IME commits the pending text on blur
    ta.addEventListener('blur', () => {
      ta.value += '好'
      atBlur.push(ta.value)
    })
    ctl.select(2)
    expect(atBlur, 'blurred before swapping contents').toEqual(['你好'])
    expect(ta.value).toBe('')
    ctl.select(1)
    expect(ta.value, 'the committed text belongs to 1\'s draft').toBe('你好')
  })

  it('does not blur when not composing (switching tabs on iPad keeps the text box focused)', () => {
    sock.text(welcome([info(1), info(2)]))
    const { ta } = textPage()
    ctl.select(2)
    ctl.togglePage()
    ctl.select(1)
    ctl.togglePage()
    let blurs = 0
    ta.addEventListener('blur', () => blurs++)
    ta.dispatchEvent(new CompositionEvent('compositionstart'))
    ta.dispatchEvent(new CompositionEvent('compositionend'))
    ctl.select(2)
    expect(blurs).toBe(0)
    expect(document.activeElement).toBe(ta)
  })
})

describe('device revoked (AC-1.11 / E2E-15)', () => {
  it('notice + error{unauthorized} stops reconnecting and sets revoked (the gate then shows the pairing page)', async () => {
    sock.text(welcome([info(1)]))
    sock.text({ t: 'notice', level: 'error', message: 'This device has been revoked' })
    sock.text({ t: 'error', code: 'unauthorized', message: 'device revoked' })
    expect(ctl.get().revoked).toBe(true)
    expect(ctl.get().fatal).toBe('This device has been revoked')
    sock.close() // the agent closes the connection next
    await new Promise((r) => setTimeout(r, 900))
    expect(sockets, 'no more reconnects').toHaveLength(1)
  })

  it('asks REST once when the upgrade is rejected (closed before welcome); 401 means revoked', async () => {
    probeStatus = 401
    sock.close()
    await new Promise((r) => setTimeout(r, 10))
    expect(probes).toBe(1)
    expect(ctl.get().revoked).toBe(true)
  })

  it('keeps reconnecting when only the network dropped (REST still 200)', async () => {
    sock.close()
    await new Promise((r) => setTimeout(r, 10))
    expect(probes).toBe(1)
    expect(ctl.get().revoked).toBe(false)
  })

  it('does not probe REST for disconnects after a welcome', async () => {
    sock.text(welcome([info(1)]))
    sock.close()
    await new Promise((r) => setTimeout(r, 10))
    expect(probes).toBe(0)
  })
})

// UT-signout-1: sign out this device (AC-1.22, ADR-0048).
describe('UT-signout-1 sign out this device', () => {
  beforeEach(() => {
    sock.text(welcome([info(1)]))
  })

  it('asks first, from settings; cancel sends nothing', () => {
    ctl.openSettings()
    ctl.requestSignOut()
    expect(ctl.get().signingOut).toBe(true)
    expect(ctl.get().settingsOpen).toBe(false)
    ctl.cancelSignOut()
    expect(ctl.get().signingOut).toBe(false)
    expect(signOuts).toBe(0)
  })

  it('confirming revokes on the server, stops the connection, clears webterm.* storage and ends signed out', async () => {
    localStorage.setItem('webterm.theme', 'dark')
    localStorage.setItem('webterm.fontSize', '16')
    localStorage.setItem('unrelated', 'keep')
    ctl.requestSignOut()
    await ctl.confirmSignOut()
    expect(signOuts).toBe(1)
    expect(ctl.get().signedOut).toBe(true)
    expect(ctl.get().conn).toBe('closed')
    expect(localStorage.getItem('webterm.theme')).toBeNull()
    expect(localStorage.getItem('webterm.fontSize')).toBeNull()
    expect(localStorage.getItem('unrelated'), 'only our own keys are removed').toBe('keep')
    const n = sockets.length
    await new Promise((r) => setTimeout(r, 50))
    expect(sockets.length, 'no reconnect after signing out').toBe(n)
  })

  it('a 401 counts as signed out: the device is not authorized either way', async () => {
    signOutResult = 401
    ctl.requestSignOut()
    await ctl.confirmSignOut()
    expect(ctl.get().signedOut).toBe(true)
  })

  it('a failed request keeps the device signed in and says so', async () => {
    for (const result of [500, new Error('network down')]) {
      signOutResult = result
      ctl.requestSignOut()
      await ctl.confirmSignOut()
      expect(ctl.get().signedOut).toBe(false)
      expect(ctl.get().conn).toBe('online')
      expect(ctl.get().toast?.kind).toBe('error')
      expect(ctl.get().toast?.text).toMatch(/still signed in/)
    }
  })

  it('offline: only a notice, nothing sent (a local-only sign-out would leave a valid token)', () => {
    sock.close()
    ctl.requestSignOut()
    expect(ctl.get().signingOut).toBe(false)
    expect(ctl.get().connNote?.text).toMatch(/Can't sign out until reconnected/)
    expect(signOuts).toBe(0)
  })

  it('the revocation that follows its own sign-out does not show "revoked"', async () => {
    ctl.requestSignOut()
    const done = ctl.confirmSignOut()
    // The revocation scan can reach this tab before the logout response does
    sock.text({ t: 'error', code: 'unauthorized', message: 'device revoked' })
    await done
    expect(ctl.get().revoked).toBe(false)
    expect(ctl.get().signedOut).toBe(true)
  })
})

describe('welcome.home', () => {
  it('records the home directory for CWD abbreviation, null if absent', () => {
    sock.text(welcome([info(1)], { home: '/home/sun' }))
    expect(ctl.get().home).toBe('/home/sun')
  })
  it('handles older agents that omit home', () => {
    sock.text(welcome([info(1)]))
    expect(ctl.get().home).toBeNull()
  })
})

describe('exit line waits for head_seq from session.updated', () => {
  it('with status=exited and head_seq ahead of outSeq, waits for the last OUTPUT and writes the line after it', async () => {
    const enc = (x: string) => new TextEncoder().encode(x)
    sock.text(welcome([info(1)]))
    sock.frame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: enc('abc\r\n') })
    sock.text({ t: 'session.updated', sid: 1, status: 'exited', exit_code: 0, head_seq: 14 })
    const t = (ctl as unknown as { store: { termOf(sid: number): { term: Parameters<typeof flush>[0] } } }).store.termOf(1)!.term
    const w = window as unknown as { __webterm: { text(): string } }
    await flush(t)
    await flush(t)
    expect(w.__webterm.text()).not.toContain('[Exited')
    sock.frame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 5n, payload: enc('LAST-LINE') })
    await flush(t)
    await flush(t)
    const text = w.__webterm.text()
    expect(text).toContain('[Exited (code 0) · Enter to close]')
    expect(text.indexOf('LAST-LINE')).toBeLessThan(text.indexOf('[Exited'))
  })
})

describe('UT-prefs-1 font size and theme (AC-5.3, ADR-0037)', () => {
  const store = () =>
    (ctl as unknown as { store: { termOf(sid: number): { term: { options: { fontSize?: number; theme?: { background?: string } } } } | undefined } })
      .store

  it('font size updates every instance and persists, sends a resize even if the container is unchanged, and applies to new sessions', async () => {
    sock.text(welcome([info(1), info(2)]))
    await new Promise((r) => setTimeout(r, 250))
    const before = sock.msgs('resize').length
    ctl.setFontSize(16)
    expect(ctl.get().fontSize).toBe(16)
    expect(localStorage.getItem('webterm.fontSize')).toBe('16')
    expect(store().termOf(1)!.term.options.fontSize).toBe(16)
    expect(store().termOf(2)!.term.options.fontSize, 'unmounted instances change too').toBe(16)
    await new Promise((r) => setTimeout(r, 250))
    expect(sock.msgs('resize').length, 'cell size changed but the container did not: still send a resize').toBe(before + 1)
    sock.text({ t: 'session.created', session: info(3) })
    expect(store().termOf(3)!.term.options.fontSize).toBe(16)
  })

  it('ignores invalid or unchanged font sizes', async () => {
    sock.text(welcome([info(1)]))
    await new Promise((r) => setTimeout(r, 250))
    const before = sock.msgs('resize').length
    for (const n of [9, 25, 15.5, 14]) ctl.setFontSize(n)
    expect(ctl.get().fontSize).toBe(14)
    expect(localStorage.getItem('webterm.fontSize')).toBeNull()
    await new Promise((r) => setTimeout(r, 250))
    expect(sock.msgs('resize').length).toBe(before)
  })

  it('theme sets data-theme, persists, and re-reads the xterm theme', () => {
    sock.text(welcome([info(1)]))
    const t = store().termOf(1)!.term
    t.options.theme = { background: '#123456' }
    ctl.setTheme('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem('webterm.theme')).toBe('dark')
    expect(ctl.get().theme).toBe('dark')
    expect(t.options.theme?.background, 're-read from CSS variables, not the old object').not.toBe('#123456')
    ctl.setTheme('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
    expect(localStorage.getItem('webterm.theme')).toBe('system')
  })

  it('opening settings from the drawer closes the drawer; closing returns focus to the terminal on non-touch devices', () => {
    sock.text(welcome([info(1)]))
    ctl.openSessions()
    ctl.openSettings()
    expect(ctl.get().sessionsOpen).toBe(false)
    expect(ctl.get().settingsOpen).toBe(true)
    ;(document.activeElement as HTMLElement | null)?.blur()
    ctl.closeSettings()
    expect(ctl.get().settingsOpen).toBe(false)
    expect(area.contains(document.activeElement), 'coarse = false in jsdom: focus returns to the terminal').toBe(true)
  })
})

describe('UT-close-1 close confirmation (AC-4.11, ADR-0038)', () => {
  it('running: enters closing without sending session.close until confirmed', () => {
    sock.text(welcome([info(1), info(2)]))
    ctl.requestClose(2)
    expect(ctl.get().closing).toBe(2)
    expect(sock.msgs('session.close')).toHaveLength(0)
    ctl.confirmClose()
    expect(ctl.get().closing).toBeNull()
    expect(sock.msgs('session.close')).toMatchObject([{ sid: 2 }])
  })

  it('cancel sends nothing', () => {
    sock.text(welcome([info(1), info(2)]))
    ctl.requestClose(2)
    ctl.cancelClose()
    expect(ctl.get().closing).toBeNull()
    expect(sock.msgs('session.close')).toHaveLength(0)
  })

  it('exited: sends immediately without confirmation', () => {
    sock.text(welcome([info(1), info(2, { status: 'exited', exit_code: 0 })]))
    ctl.requestClose(2)
    expect(ctl.get().closing).toBeNull()
    expect(sock.msgs('session.close')).toMatchObject([{ sid: 2 }])
  })

  it('restores focus before sending, so focus follows to the neighbor\'s terminal after closing the active session', () => {
    sock.text(welcome([info(1), info(2)]))
    area.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!.focus()
    ctl.requestClose(1)
    // The sheet took focus
    const btn = document.createElement('button')
    document.body.appendChild(btn)
    btn.focus()
    expect(area.contains(document.activeElement)).toBe(false)
    ctl.confirmClose()
    expect(area.contains(document.activeElement), 'focus is back in the terminal before session.close is sent').toBe(true)
    sock.text({ t: 'session.closed', sid: 1, exit_code: 0 })
    expect(term().sid()).toBe(2)
    expect(area.contains(document.activeElement), 'after switching to the neighbor, focus is in its terminal').toBe(true)
  })

  it('clears closing when the session disappears while confirming, so a new session with the same sid is not closed by mistake', () => {
    sock.text(welcome([info(1), info(2)]))
    ctl.requestClose(2)
    sock.text({ t: 'session.closed', sid: 2, exit_code: 0 })
    expect(ctl.get().closing).toBeNull()
    sock.text({ t: 'session.created', session: info(2, { name: 'new-2' }) })
    ctl.confirmClose()
    expect(sock.msgs('session.close')).toHaveLength(0)
  })
})

describe('UT-close-1 while closing (ADR-0038 §5)', () => {
  it('after session.close, sends no input (focus reports included) or resize, and suppresses its unknown_session', async () => {
    sock.text(welcome([info(1), info(2)]))
    ctl.requestClose(1)
    ctl.confirmClose()
    const before = sock.inputs().length
    xterm(1).input('\x1b[I', false) // focus report
    inside('keydown', () => xterm(1).input('x', true))
    expect(sock.inputs().length, 'a closing session takes no more input').toBe(before)
    sock.text({ t: 'error', sid: 1, code: 'unknown_session', message: 'session not found' })
    expect(ctl.get().toast, 'closing: expected, no toast').toBeNull()
    sock.text({ t: 'session.closed', sid: 1, exit_code: 0 })
    sock.text({ t: 'error', sid: 1, code: 'unknown_session', message: 'session not found' })
    expect(ctl.get().toast, 'already gone locally: no toast either').toBeNull()
    sock.text({ t: 'error', sid: 2, code: 'unknown_session', message: 'session not found' })
    expect(ctl.get().toast?.text, 'still here and not closing: genuinely out of sync, so toast').toBe('session not found')
  })
})

describe('UT-order-1 drag to reorder (ADR-0040)', () => {
  it('uses welcome order for display; moveSession moves locally and sends session.move; session.order replaces the order', () => {
    sock.text(welcome([info(3), info(1), info(2)]))
    expect(ctl.get().sessions.map((s) => s.sid)).toEqual([3, 1, 2])
    ctl.moveSession(2, 3)
    expect(ctl.get().sessions.map((s) => s.sid)).toEqual([2, 3, 1])
    expect(sock.msgs('session.move')).toMatchObject([{ sid: 2, before: 3 }])
    sock.text({ t: 'session.order', sids: [1, 2, 3] })
    expect(ctl.get().sessions.map((s) => `${s.index}:${s.sid}`)).toEqual(['1:1', '2:2', '3:3'])
  })
})

describe('UT-close-1 close that never landed', () => {
  it('offline close shows a notice without marking closing (works normally after reconnect); a second close while confirming is ignored', async () => {
    sock.text(welcome([info(1), info(2)]))
    ctl.requestClose(1)
    ctl.requestClose(2)
    expect(ctl.get().closing, 'confirmation open: second close ignored').toBe(1)
    ctl.cancelClose()
    sock.close()
    ctl.requestClose(1)
    ctl.confirmClose()
    expect(ctl.get().connNote?.text).toBe("Can't close the session until reconnected")
    await new Promise((r) => setTimeout(r, 900))
    const s2 = sockets[sockets.length - 1]!
    s2.open()
    s2.text(welcome([info(1), info(2)], { resumed: [{ sid: 1, status: 'ok', from_seq: 0, in_ack: 0 }] }))
    inside('keydown', () => xterm(1).input('x', true))
    expect(s2.inputs(), 'the session that failed to close still takes input').toContain('x')
  })

  it('no longer counts as closing when the welcome after reconnect still lists it', async () => {
    sock.text(welcome([info(1), info(2)]))
    ctl.requestClose(1)
    ctl.confirmClose()
    expect(sock.msgs('session.close')).toHaveLength(1)
    sock.close()
    await new Promise((r) => setTimeout(r, 900))
    const s2 = sockets[sockets.length - 1]!
    s2.open()
    s2.text(welcome([info(1), info(2)], { resumed: [{ sid: 1, status: 'ok', from_seq: 0, in_ack: 0 }] }))
    inside('keydown', () => xterm(1).input('y', true))
    expect(s2.inputs()).toContain('y')
  })
})

// UT-claim-1: the size follows the client in use (AC-4.14, ADR-0050 §5)
describe('UT-claim-1 size claims', () => {
  const sessionSize = (sid: number) => {
    const i = (ctl as unknown as { store: { info(sid: number): { cols: number; rows: number } | undefined } }).store.info(sid)!
    return [i.cols, i.rows]
  }
  /** The kinds of what went out, in order: 'resize' for resize messages, 'input' for INPUT frames. */
  const order = (s: FakeSocket) =>
    s.sent
      .map((x) => (typeof x === 'string' ? JSON.parse(x).t : 'input'))
      .filter((t: string) => t === 'resize' || t === 'input')

  beforeEach(() => {
    sock.text(welcome([info(1)]))
    sock.sent = []
  })

  it('session.updated{cols, rows} updates the session size', () => {
    sock.text({ t: 'session.updated', sid: 1, cols: 120, rows: 40 })
    expect(sessionSize(1)).toEqual([120, 40])
  })

  it('user input to a session with another size sends resize before the input, once', () => {
    inside('keydown', () => xterm(1).input('a', true))
    expect(order(sock), 'same size: no resize').toEqual(['input'])

    sock.text({ t: 'session.updated', sid: 1, cols: 120, rows: 40 }) // another client took it
    sock.sent = []
    inside('keydown', () => xterm(1).input('b', true))
    inside('keydown', () => xterm(1).input('c', true))
    expect(order(sock)).toEqual(['resize', 'input', 'input'])
    expect(sock.msgs('resize')[0]).toMatchObject({ sid: 1, cols: 80, rows: 24 })
    expect(sessionSize(1)).toEqual([80, 24])
  })

  it('extra keys and the text page claim too', () => {
    sock.text({ t: 'session.updated', sid: 1, cols: 120, rows: 40 })
    sock.sent = []
    inside('pointerup', () => ctl.pressKey('ArrowUp'))
    expect(order(sock)).toEqual(['resize', 'input'])
    sock.text({ t: 'session.updated', sid: 1, cols: 120, rows: 40 })
    sock.sent = []
    inside('keydown', () => ctl.sendText({ kind: 'submit', text: 'ls' }))
    expect(order(sock)).toEqual(['resize', 'input', 'input'])
  })

  it('automatic terminal replies never claim', () => {
    sock.text({ t: 'session.updated', sid: 1, cols: 120, rows: 40 })
    sock.sent = []
    xterm(1).input('\x1b[I', false) // not inside a user input event: xterm answering or reporting
    expect(order(sock)).toEqual(['input'])
  })

  it('gaining focus or coming back into view claims', () => {
    sock.text({ t: 'session.updated', sid: 1, cols: 120, rows: 40 })
    window.dispatchEvent(new Event('focus'))
    expect(sock.msgs('resize')).toMatchObject([{ sid: 1, cols: 80, rows: 24 }])
    window.dispatchEvent(new Event('focus'))
    expect(sock.msgs('resize'), 'already holds the size').toHaveLength(1)

    sock.text({ t: 'session.updated', sid: 1, cols: 100, rows: 30 })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(sock.msgs('resize')).toHaveLength(2)
  })

  it('an exited session is never claimed', () => {
    sock.text({ t: 'session.updated', sid: 1, cols: 120, rows: 40, status: 'exited', exit_code: 0 })
    window.dispatchEvent(new Event('focus'))
    expect(sock.msgs('resize')).toHaveLength(0)
  })

  it('a size change sends resize only while focused', async () => {
    focused = false
    ctl.setFontSize(16)
    await new Promise((r) => setTimeout(r, 250))
    expect(sock.msgs('resize'), 'unfocused: keeps its layout to itself').toHaveLength(0)
    focused = true
    ctl.setFontSize(18)
    await new Promise((r) => setTimeout(r, 250))
    expect(sock.msgs('resize')).toHaveLength(1)
  })

  it('after a reconnect, claims only while focused', async () => {
    for (const hasFocus of [false, true]) {
      focused = hasFocus
      const s = sockets[sockets.length - 1]!
      s.close()
      await new Promise((r) => setTimeout(r, 900)) // backoff 0.5s ±20%
      const s2 = sockets[sockets.length - 1]!
      s2.open()
      s2.text(welcome([info(1, { cols: 120, rows: 40 })], { resumed: [{ sid: 1, status: 'ok', from_seq: 0, in_ack: 0 }] }))
      expect(s2.msgs('resize'), `focused=${hasFocus}`).toHaveLength(hasFocus ? 1 : 0)
    }
  })
})

describe('UT-upload-2 sending files (ADR-0051, input.md §Sending files)', () => {
  const file = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })
  /** INPUT payloads for one session (sock.inputs() mixes sessions). */
  const inputsOf = (sid: number) =>
    sock.sent
      .filter((s): s is Uint8Array => s instanceof Uint8Array)
      .map((b) => decodeFrame(b))
      .filter((f) => f.sid === sid)
      .map((f) => new TextDecoder().decode(f.payload))
  /** Lets the controller's promise chain move on. */
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const toast = () => ctl.get().toast?.text
  let input: HTMLInputElement
  const pick = (...files: File[]) => {
    ctl.pickFiles()
    Object.defineProperty(input, 'files', { value: files, configurable: true })
    ctl.onFilesPicked()
  }

  beforeEach(() => {
    sock.text(welcome([info(1), info(2)]))
    input = document.createElement('input')
    input.type = 'file'
    ctl.registerFileInput(input)
  })

  it('uploads one at a time, in order, and pastes each path alone into the session current at pick time', async () => {
    ctl.select(1)
    pick(file('a.png'), file('b.png'))
    expect(ctl.get().uploading).toBe(true)
    await tick()
    expect(pendingUploads.map((u) => u.file.name), 'the second waits for the first').toEqual(['a.png'])
    ctl.select(2) // switching meanwhile doesn't redirect the upload
    pendingUploads[0]!.done({ ok: true, path: '/tmp/webterm-1000/uploads/a-111111.png' })
    await tick()
    await tick()
    expect(pendingUploads.map((u) => u.file.name)).toEqual(['a.png', 'b.png'])
    pendingUploads[1]!.done({ ok: true, path: '/tmp/webterm-1000/uploads/b-222222.png' })
    await tick()
    await tick()
    expect(inputsOf(1), 'one paste per file, no Enter').toEqual(['/tmp/webterm-1000/uploads/a-111111.png', '/tmp/webterm-1000/uploads/b-222222.png'])
    expect(inputsOf(2)).toEqual([])
    expect(ctl.get().uploading).toBe(false)
  })

  it('is bracketed when the program enabled bracketed paste, and leaves sticky modifiers alone', async () => {
    sock.frame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: new TextEncoder().encode('\x1b[?2004h') })
    await new Promise((r) => setTimeout(r, 30))
    ctl.sticky.tap('ctrl')
    pick(file('a.png'))
    await tick()
    pendingUploads[0]!.done({ ok: true, path: '/u/a-1.png' })
    await tick()
    await tick()
    expect(inputsOf(1).join('')).toBe('\x1b[200~/u/a-1.png\x1b[201~')
    expect(ctl.sticky.state('ctrl'), 'still armed for the next key').toBe('armed')
  })

  it('a failed upload pastes nothing, says why, and the next file still goes', async () => {
    pick(file('big.mov'), file('ok.png'))
    await tick()
    pendingUploads[0]!.done({ ok: false, status: 413 })
    await tick()
    await tick()
    expect(toast()).toBe('big.mov is too large (max 20 MB)')
    pendingUploads[1]!.done({ ok: true, path: '/u/ok-1.png' })
    await tick()
    await tick()
    expect(inputsOf(1)).toEqual(['/u/ok-1.png'])
  })

  it('a network failure says so', async () => {
    pick(file('a.png'))
    await tick()
    pendingUploads[0]!.done({ ok: false, status: 0 })
    await tick()
    await tick()
    expect(toast()).toBe('Upload failed: a.png')
    expect(ctl.get().uploading).toBe(false)
  })

  it('the session closed meanwhile: nothing is pasted anywhere, a toast says so', async () => {
    pick(file('a.png'))
    await tick()
    sock.text({ t: 'session.closed', sid: 1 })
    pendingUploads[0]!.done({ ok: true, path: '/u/a-1.png' })
    await tick()
    await tick()
    expect(sock.inputs()).toEqual([])
    expect(toast()).toBe('Session ended; a.png not inserted')
  })

  it('a session with the same sid after an agent restart is not the target', async () => {
    pick(file('a.png'))
    await tick()
    sock.text(welcome([info(1)], { instance_id: 'i2' })) // agent restarted, sid 1 reused
    pendingUploads[0]!.done({ ok: true, path: '/u/a-1.png' })
    await tick()
    await tick()
    expect(sock.inputs()).toEqual([])
  })

  it('401 means the device was revoked', async () => {
    pick(file('a.png'))
    await tick()
    pendingUploads[0]!.done({ ok: false, status: 401 })
    await tick()
    await tick()
    expect(ctl.get().revoked).toBe(true)
  })

  it('a paste of files into the terminal uploads them and stops the event; a text paste is left to xterm', async () => {
    const helper = area.querySelector('.xterm-helper-textarea')!
    const paste = (data: object) => {
      const e = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(e, 'clipboardData', { value: data })
      helper.dispatchEvent(e)
      return e
    }
    const shot = file('image.png')
    const e1 = paste({ getData: () => '', files: [shot], types: ['Files'] })
    expect(e1.defaultPrevented).toBe(true)
    await tick()
    expect(pendingUploads.map((u) => u.file)).toEqual([shot])
    const e2 = paste({ getData: (t: string) => (t === 'text/plain' ? 'echo hi' : ''), files: [], types: ['text/plain'] })
    expect(e2.defaultPrevented, 'xterm handles text pastes itself').toBe(false)
    expect(pendingUploads.length).toBe(1)
  })

  it('a drag of files outlines the terminal; the drop uploads them and keeps the page', async () => {
    const drag = (type: string, files: File[]) => {
      const e = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(e, 'dataTransfer', { value: { files, types: files.length ? ['Files'] : ['text/plain'], dropEffect: 'none' } })
      area.dispatchEvent(e)
      return e
    }
    expect(drag('dragover', []).defaultPrevented, 'text drags are left alone').toBe(false)
    expect(drag('dragover', [file('a.png')]).defaultPrevented).toBe(true)
    expect(ctl.get().dropping).toBe(true)
    const drop = drag('drop', [file('a.png')])
    expect(drop.defaultPrevented, 'otherwise the browser opens the file in place of the page').toBe(true)
    expect(ctl.get().dropping).toBe(false)
    await tick()
    expect(pendingUploads.map((u) => u.file.name)).toEqual(['a.png'])
  })
})
