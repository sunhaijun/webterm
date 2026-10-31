/**
 * 装配层（app/controller.ts）：连接 ⇄ 会话 ⇄ 输入。只测几条把各模块串起来的路：
 * 建会话后自己订阅、附加键与粘滞修饰走 onData 出口、文本页、已退出会话里 Enter 关闭、
 * 焦点跟着会话走、agent 重启。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { AppController } from '../src/app/controller'
import type { WebSocketLike } from '../src/conn/connection'
import { decodeFrame, encodeFrame, TYPE_OUTPUT, TYPE_SNAPSHOT } from '../src/protocol/frame'
import { flush, info } from './helpers'

beforeAll(() => {
  // jsdom 缺的几样
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

/** 在一次用户输入事件的派发里做事（附加键是 pointerup，键盘是 keydown）。 */
function inside(type: string, fn: () => void) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  el.addEventListener(type, fn)
  el.dispatchEvent(new Event(type))
  el.remove()
}

const term = () => (window as unknown as { __webterm: { sid(): number | null } }).__webterm
/** 会话的 xterm 实例：模拟软键盘 / 实体键盘的输入（`term.input(data, true)`，走 onData）。 */
const xterm = (sid: number) =>
  (ctl as unknown as { store: { termOf(sid: number): { term: { input(data: string, wasUserInput: boolean): void } } | undefined } }).store.termOf(sid)!.term

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  probeStatus = 200
  probes = 0
  setup()
})
afterEach(() => {
  unmount()
  document.body.innerHTML = ''
})

describe('建会话与订阅', () => {
  it('没有会话：首次 welcome 自动建一个；session.created 之后客户端自己发 subscribe{out_seq: 0, cols, rows}', () => {
    sock.text(welcome([]))
    const create = sock.msgs('session.create')
    expect(create).toHaveLength(1)
    sock.text({ t: 'session.created', req_id: create[0].req_id, session: info(1) })
    const sub = sock.msgs('subscribe')
    expect(sub).toHaveLength(1)
    expect(sub[0]).toMatchObject({ sid: 1, out_seq: 0 })
    expect(sub[0].cols).toBeGreaterThan(0)
    expect(term().sid()).toBe(1)
    expect(sock.msgs('resize'), '订阅时不单发 resize').toHaveLength(0)
  })

  it('别的标签页建的会话不抢当前会话', () => {
    sock.text(welcome([info(1)]))
    sock.text({ t: 'session.created', session: info(2) })
    expect(term().sid()).toBe(1)
    expect(ctl.get().sessions.map((s) => s.sid)).toEqual([1, 2])
  })

  it('agent 重启过（instance_id 变了）：旧会话全部作废，提示「会话已结束」', async () => {
    sock.text(welcome([info(1, { name: 'old-1' }), info(2, { name: 'old-2' })]))
    expect(term().sid()).toBe(1)
    sock.close()
    expect(ctl.get().conn).toBe('reconnecting')
    await new Promise((r) => setTimeout(r, 900)) // 退避 0.5s ±20%
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
    expect(ctl.get().toast?.text).toBe('会话已结束（agent 可能已重启）')
    expect(term().sid(), '新的 sid 1 是另一个会话，重新订阅从 0 开始').toBe(1)
    expect(s2.msgs('subscribe')).toMatchObject([{ sid: 1, out_seq: 0 }])
  })
})

describe('输入出口', () => {
  beforeEach(() => {
    sock.text(welcome([info(1)]))
  })

  it('附加键：按当前修饰与 DECCKM 算字节，走 onData 出口发出去', async () => {
    inside('pointerup', () => ctl.pressKey('ArrowUp'))
    sock.frame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: new TextEncoder().encode('\x1b[?1h') })
    await new Promise((r) => setTimeout(r, 30))
    inside('pointerup', () => ctl.pressKey('ArrowUp'))
    expect(sock.inputs()).toEqual(['\x1b[A', '\x1bOA'])
  })

  it('粘滞 CTRL：软键盘的下一个字符也吃修饰；附加键自己算过的不再套一次', () => {
    ctl.sticky.tap('ctrl')
    inside('pointerup', () => ctl.pressKey('ArrowLeft'))
    ctl.sticky.hold('ctrl')
    inside('pointerup', () => ctl.pressKey('Escape'))
    inside('keydown', () => xterm(1).input('c', true)) // 软键盘打出来的 c
    expect(sock.inputs()).toEqual(['\x1b[1;5D', '\x1b', '\x03'])
  })

  it('文本页：有内容 = 内容再单独一个 \\r；空回车只发 \\r（ADR-0027）', () => {
    inside('keydown', () => ctl.sendText({ kind: 'submit', text: 'echo TEXT-ONE' }))
    inside('keydown', () => ctl.sendText({ kind: 'submit', text: '' }))
    expect(sock.inputs()).toEqual(['echo TEXT-ONE', '\r', '\r'])
  })

  it('文本页：对端开了括号粘贴就整块包起来，回车落在结束标记之后', async () => {
    sock.frame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: new TextEncoder().encode('\x1b[?2004h') })
    await new Promise((r) => setTimeout(r, 30))
    inside('keydown', () => ctl.sendText({ kind: 'submit', text: '长段 prompt\n第二行' }))
    expect(sock.inputs().join('')).toBe('\x1b[200~长段 prompt\r第二行\x1b[201~\r')
  })

  it('文本页不吃粘滞修饰：ALT 激活时回车仍是 \\r（ESC \\r 在 claude 里是换行），激活也不消耗', () => {
    ctl.sticky.tap('alt')
    ctl.sticky.hold('ctrl')
    inside('keydown', () => ctl.sendText({ kind: 'submit', text: 'y' }))
    expect(sock.inputs()).toEqual(['y', '\r'])
    expect(ctl.sticky.state('alt')).toBe('armed')
    expect(ctl.sticky.state('ctrl')).toBe('locked')
  })

  it('已退出的会话：Enter 直接关闭（不确认），其余输入丢弃', () => {
    sock.text({ t: 'session.updated', sid: 1, status: 'exited', exit_code: 1 })
    inside('keydown', () => xterm(1).input('ls', true))
    expect(sock.inputs()).toEqual([])
    expect(sock.msgs('session.close')).toEqual([])
    inside('keydown', () => xterm(1).input('\r', true))
    expect(sock.msgs('session.close')).toMatchObject([{ sid: 1 }])
  })

  it('已退出的会话：文本页回车 = 内容丢弃、跟着的 \\r 关闭会话', () => {
    sock.text({ t: 'session.updated', sid: 1, status: 'exited', exit_code: 1 })
    inside('keydown', () => ctl.sendText({ kind: 'submit', text: 'ls' }))
    expect(sock.inputs()).toEqual([])
    expect(sock.msgs('session.close')).toMatchObject([{ sid: 1 }])
  })
})

describe('快照与提示行', () => {
  it('SNAPSHOT 交给会话层清屏重画；会话已退出时提示行跟在后面', async () => {
    sock.text(welcome([info(1, { status: 'exited', exit_code: 3, head_seq: 10 })]))
    sock.frame({ type: TYPE_SNAPSHOT, flags: 0, sid: 1, seq: 10n, payload: new TextEncoder().encode('restored\r\n') })
    const w = window as unknown as { __webterm: { text(): string; outSeq(): number; frames(): { kind: string }[] } }
    const t = (ctl as unknown as { store: { termOf(sid: number): { term: Parameters<typeof flush>[0] } } }).store.termOf(1)!.term
    await flush(t)
    await flush(t)
    expect(w.__webterm.text()).toContain('restored')
    expect(w.__webterm.text()).toContain('[进程已结束（退出码 3）· 按 Enter 关闭]')
    expect(w.__webterm.outSeq()).toBe(10)
    expect(w.__webterm.frames().map((f) => f.kind)).toEqual(['SNAPSHOT'])
  })
})

describe('切换会话', () => {
  it('Ctrl+Shift+↓：焦点原本在终端里就还给新会话的终端', () => {
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

  it('wide 上 Ctrl+Shift+B 不做任何事；Ctrl+Shift+, 开关设置', () => {
    sock.text(welcome([info(1)]))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'B', ctrlKey: true, shiftKey: true }))
    expect(ctl.get().sessionsOpen).toBe(ctl.get().form === 'compact')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '<', ctrlKey: true, shiftKey: true }))
    expect(ctl.get().settingsOpen).toBe(true)
  })

  it('关掉当前会话后切到后一个', () => {
    sock.text(welcome([info(1), info(2), info(3)]))
    ctl.select(2)
    sock.text({ t: 'session.closed', sid: 2, exit_code: 0 })
    expect(term().sid()).toBe(3)
    expect(ctl.get().sessions.map((s) => s.index)).toEqual([1, 2])
  })
})

describe('设备被吊销（AC-1.11 / E2E-15）', () => {
  it('notice + error{unauthorized}：停止重连，revoked 置位（闸门据此换成配对引导页）', async () => {
    sock.text(welcome([info(1)]))
    sock.text({ t: 'notice', level: 'error', message: '此设备已被吊销' })
    sock.text({ t: 'error', code: 'unauthorized', message: 'device revoked' })
    expect(ctl.get().revoked).toBe(true)
    expect(ctl.get().fatal).toBe('此设备已被吊销')
    sock.close() // agent 随后关连接
    await new Promise((r) => setTimeout(r, 900))
    expect(sockets, '不再重连').toHaveLength(1)
  })

  it('升级被拒（没收到 welcome 就断了）：问一次 REST，401 就是被吊销', async () => {
    probeStatus = 401
    sock.close()
    await new Promise((r) => setTimeout(r, 10))
    expect(probes).toBe(1)
    expect(ctl.get().revoked).toBe(true)
  })

  it('只是网络断了（REST 仍是 200）：照常重连，不判吊销', async () => {
    sock.close()
    await new Promise((r) => setTimeout(r, 10))
    expect(probes).toBe(1)
    expect(ctl.get().revoked).toBe(false)
  })

  it('收到过 welcome 之后的断线不额外探测', async () => {
    sock.text(welcome([info(1)]))
    sock.close()
    await new Promise((r) => setTimeout(r, 10))
    expect(probes).toBe(0)
  })
})

describe('welcome.home', () => {
  it('记下家目录给 CWD 缩写用；没有就是 null（不缩写）', () => {
    sock.text(welcome([info(1)], { home: '/home/sun' }))
    expect(ctl.get().home).toBe('/home/sun')
  })
  it('老 agent 不发 home', () => {
    sock.text(welcome([info(1)]))
    expect(ctl.get().home).toBeNull()
  })
})

describe('进程结束提示行用 session.updated 里的 head_seq 判追平', () => {
  it('status=exited 带的 head_seq 比本地 outSeq 大：先不写，等最后一段 OUTPUT 到了再写在它后面', async () => {
    const enc = (x: string) => new TextEncoder().encode(x)
    sock.text(welcome([info(1)]))
    sock.frame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload: enc('abc\r\n') })
    sock.text({ t: 'session.updated', sid: 1, status: 'exited', exit_code: 0, head_seq: 14 })
    const t = (ctl as unknown as { store: { termOf(sid: number): { term: Parameters<typeof flush>[0] } } }).store.termOf(1)!.term
    const w = window as unknown as { __webterm: { text(): string } }
    await flush(t)
    await flush(t)
    expect(w.__webterm.text()).not.toContain('进程已结束')
    sock.frame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 5n, payload: enc('LAST-LINE') })
    await flush(t)
    await flush(t)
    const text = w.__webterm.text()
    expect(text).toContain('[进程已结束（退出码 0）· 按 Enter 关闭]')
    expect(text.indexOf('LAST-LINE')).toBeLessThan(text.indexOf('[进程已结束'))
  })
})
