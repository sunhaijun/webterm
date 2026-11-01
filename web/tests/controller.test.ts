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

  it('wide 上 Ctrl+Shift+B 不做任何事', () => {
    sock.text(welcome([info(1)]))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'B', ctrlKey: true, shiftKey: true }))
    expect(ctl.get().sessionsOpen).toBe(ctl.get().form === 'compact')
  })

  it('关掉当前会话后切到后一个', () => {
    sock.text(welcome([info(1), info(2), info(3)]))
    ctl.select(2)
    sock.text({ t: 'session.closed', sid: 2, exit_code: 0 })
    expect(term().sid()).toBe(3)
    expect(ctl.get().sessions.map((s) => s.index)).toEqual([1, 2])
  })
})

describe('UT-textinput-2 文本页跟着会话走（AC-3.22 / AC-4.8，ADR-0036）', () => {
  /** 附加键组件交上来的两块 DOM（jsdom 不算样式，`data-page` 只看值）。 */
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

  it('切会话换页与草稿，焦点落到新会话的输入处；切回原样恢复', () => {
    sock.text(welcome([info(1), info(2)]))
    const { slot, ta } = textPage()
    expect([ctl.get().page, slot.dataset.page]).toEqual(['keys', 'keys'])

    ctl.togglePage()
    expect([ctl.get().page, slot.dataset.page]).toEqual(['text', 'text'])
    expect(document.activeElement).toBe(ta)
    ta.value = 'echo DRAFT-1'

    // 在 1 的文本框里 → 切到停在键位页的 2：焦点进 2 的终端，框里不是 1 的草稿
    ctl.select(2)
    expect(term().sid()).toBe(2)
    expect([ctl.get().page, slot.dataset.page, ta.value]).toEqual(['keys', 'keys', ''])
    expect(inTerm(), '新会话停在键位页：焦点给终端').toBe(true)

    ctl.togglePage()
    ta.value = 'echo DRAFT-2'
    ctl.togglePage() // 2 回键位页，草稿留着
    expect(inTerm(), '切回键位页时焦点从文本框还给终端').toBe(true)

    // 在 2 的终端里 → 切到停在文本页的 1：焦点进文本框，里面是 1 的草稿
    ctl.select(1)
    expect([ctl.get().page, slot.dataset.page, ta.value]).toEqual(['text', 'text', 'echo DRAFT-1'])
    expect(document.activeElement).toBe(ta)

    ctl.select(2)
    expect([ctl.get().page, ta.value]).toEqual(['keys', 'echo DRAFT-2'])
    expect(inTerm()).toBe(true)
  })

  it('点当前会话不挪焦点：文本页开着、人在终端里打字，焦点留在终端', () => {
    sock.text(welcome([info(1)]))
    const { ta } = textPage()
    ctl.togglePage()
    ctl.focusTerm()
    ctl.select(1)
    expect(inTerm()).toBe(true)
    expect(document.activeElement).not.toBe(ta)
  })

  it('新会话：键位页、空草稿，焦点进它的终端；原会话的草稿还在', () => {
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

  it('会话关掉草稿就丢；同一个 sid 再出现时从头开始', () => {
    sock.text(welcome([info(1), info(2)]))
    const { ta } = textPage()
    ctl.select(2)
    ctl.togglePage()
    ta.value = 'gone'
    sock.text({ t: 'session.closed', sid: 2, exit_code: 0 })
    expect(term().sid()).toBe(1)
    expect([ctl.get().page, ta.value]).toEqual(['keys', ''])
    expect(document.activeElement, '原来在文本框里打字：焦点给 1 的输入处（键位页 → 终端）').not.toBe(ta)
    expect(inTerm()).toBe(true)

    sock.text({ t: 'session.created', session: info(2) })
    ctl.select(2)
    expect([ctl.get().page, ta.value]).toEqual(['keys', ''])
  })

  it('组字中切换：先失焦让输入法把字提交进去，再存草稿、换内容', () => {
    sock.text(welcome([info(1), info(2)]))
    const { ta } = textPage()
    ctl.togglePage()
    ta.value = '你'
    ta.dispatchEvent(new CompositionEvent('compositionstart'))
    const atBlur: string[] = []
    // 输入法在失焦时把组到一半的字提交进去
    ta.addEventListener('blur', () => {
      ta.value += '好'
      atBlur.push(ta.value)
    })
    ctl.select(2)
    expect(atBlur, '换内容之前先失焦').toEqual(['你好'])
    expect(ta.value).toBe('')
    ctl.select(1)
    expect(ta.value, '提交进去的字算在 1 的草稿里').toBe('你好')
  })

  it('没在组字就不失焦（iPad 上点标签切会话，文本框一直有焦点）', () => {
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

describe('UT-prefs-1 改字号与主题（AC-5.3，ADR-0037）', () => {
  const store = () =>
    (ctl as unknown as { store: { termOf(sid: number): { term: { options: { fontSize?: number; theme?: { background?: string } } } } | undefined } })
      .store

  it('改字号：所有实例一起换、记住；容器没变也补发 resize；新建的会话用新字号', async () => {
    sock.text(welcome([info(1), info(2)]))
    await new Promise((r) => setTimeout(r, 250))
    const before = sock.msgs('resize').length
    ctl.setFontSize(16)
    expect(ctl.get().fontSize).toBe(16)
    expect(localStorage.getItem('webterm.fontSize')).toBe('16')
    expect(store().termOf(1)!.term.options.fontSize).toBe(16)
    expect(store().termOf(2)!.term.options.fontSize, '没挂着的实例也换').toBe(16)
    await new Promise((r) => setTimeout(r, 250))
    expect(sock.msgs('resize').length, '字符格变了而容器没变：也要补一条 resize').toBe(before + 1)
    sock.text({ t: 'session.created', session: info(3) })
    expect(store().termOf(3)!.term.options.fontSize).toBe(16)
  })

  it('不合法或没变的字号什么都不做', async () => {
    sock.text(welcome([info(1)]))
    await new Promise((r) => setTimeout(r, 250))
    const before = sock.msgs('resize').length
    for (const n of [9, 25, 15.5, 14]) ctl.setFontSize(n)
    expect(ctl.get().fontSize).toBe(14)
    expect(localStorage.getItem('webterm.fontSize')).toBeNull()
    await new Promise((r) => setTimeout(r, 250))
    expect(sock.msgs('resize').length).toBe(before)
  })

  it('改主题：打上 data-theme、记住，xterm 的主题重读一遍', () => {
    sock.text(welcome([info(1)]))
    const t = store().termOf(1)!.term
    t.options.theme = { background: '#123456' }
    ctl.setTheme('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem('webterm.theme')).toBe('dark')
    expect(ctl.get().theme).toBe('dark')
    expect(t.options.theme?.background, '重读过 CSS 变量，不再是旧对象').not.toBe('#123456')
    ctl.setTheme('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
    expect(localStorage.getItem('webterm.theme')).toBe('system')
  })

  it('设置开关：从会话抽屉打开会关掉抽屉；非触摸设备关掉后焦点回终端', () => {
    sock.text(welcome([info(1)]))
    ctl.openSessions()
    ctl.openSettings()
    expect(ctl.get().sessionsOpen).toBe(false)
    expect(ctl.get().settingsOpen).toBe(true)
    ;(document.activeElement as HTMLElement | null)?.blur()
    ctl.closeSettings()
    expect(ctl.get().settingsOpen).toBe(false)
    expect(area.contains(document.activeElement), 'jsdom 里 coarse = false：焦点还给终端').toBe(true)
  })
})

describe('UT-close-1 关闭确认（AC-4.11，ADR-0038）', () => {
  it('running：先进 closing，不发 session.close；确认才发', () => {
    sock.text(welcome([info(1), info(2)]))
    ctl.requestClose(2)
    expect(ctl.get().closing).toBe(2)
    expect(sock.msgs('session.close')).toHaveLength(0)
    ctl.confirmClose()
    expect(ctl.get().closing).toBeNull()
    expect(sock.msgs('session.close')).toMatchObject([{ sid: 2 }])
  })

  it('取消：不发', () => {
    sock.text(welcome([info(1), info(2)]))
    ctl.requestClose(2)
    ctl.cancelClose()
    expect(ctl.get().closing).toBeNull()
    expect(sock.msgs('session.close')).toHaveLength(0)
  })

  it('exited：直接发，不确认', () => {
    sock.text(welcome([info(1), info(2, { status: 'exited', exit_code: 0 })]))
    ctl.requestClose(2)
    expect(ctl.get().closing).toBeNull()
    expect(sock.msgs('session.close')).toMatchObject([{ sid: 2 }])
  })

  it('确认时先还焦点再发：关掉当前会话后，焦点跟到相邻会话的终端', () => {
    sock.text(welcome([info(1), info(2)]))
    area.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')!.focus()
    ctl.requestClose(1)
    // 浮层拿走了焦点
    const btn = document.createElement('button')
    document.body.appendChild(btn)
    btn.focus()
    expect(area.contains(document.activeElement)).toBe(false)
    ctl.confirmClose()
    expect(area.contains(document.activeElement), '发 session.close 之前焦点已经回到终端').toBe(true)
    sock.text({ t: 'session.closed', sid: 1, exit_code: 0 })
    expect(term().sid()).toBe(2)
    expect(area.contains(document.activeElement), '切到相邻会话后焦点在它的终端里').toBe(true)
  })

  it('确认浮层开着时会话没了：closing 清掉，之后同号的新会话不会被误关', () => {
    sock.text(welcome([info(1), info(2)]))
    ctl.requestClose(2)
    sock.text({ t: 'session.closed', sid: 2, exit_code: 0 })
    expect(ctl.get().closing).toBeNull()
    sock.text({ t: 'session.created', session: info(2, { name: 'new-2' }) })
    ctl.confirmClose()
    expect(sock.msgs('session.close')).toHaveLength(0)
  })
})

describe('UT-close-1 关闭中（ADR-0038 §5）', () => {
  it('发了 session.close 之后：输入（含焦点上报）与 resize 都不发，它的 unknown_session 不弹', async () => {
    sock.text(welcome([info(1), info(2)]))
    ctl.requestClose(1)
    ctl.confirmClose()
    const before = sock.inputs().length
    xterm(1).input('\x1b[I', false) // 焦点上报
    inside('keydown', () => xterm(1).input('x', true))
    expect(sock.inputs().length, '关闭中的会话不再收输入').toBe(before)
    sock.text({ t: 'error', sid: 1, code: 'unknown_session', message: '会话不存在' })
    expect(ctl.get().toast, '关闭中：意料之中，不弹').toBeNull()
    sock.text({ t: 'session.closed', sid: 1, exit_code: 0 })
    sock.text({ t: 'error', sid: 1, code: 'unknown_session', message: '会话不存在' })
    expect(ctl.get().toast, '本地已经没有了：也不弹').toBeNull()
    sock.text({ t: 'error', sid: 2, code: 'unknown_session', message: '会话不存在' })
    expect(ctl.get().toast?.text, '本地还在、也没在关：真的不同步了，照弹').toBe('会话不存在')
  })
})

describe('UT-order-1 拖动排序（ADR-0040）', () => {
  it('welcome 的顺序就是显示顺序；moveSession 本地先挪并发 session.move；session.order 整个替换', () => {
    sock.text(welcome([info(3), info(1), info(2)]))
    expect(ctl.get().sessions.map((s) => s.sid)).toEqual([3, 1, 2])
    ctl.moveSession(2, 3)
    expect(ctl.get().sessions.map((s) => s.sid)).toEqual([2, 3, 1])
    expect(sock.msgs('session.move')).toMatchObject([{ sid: 2, before: 3 }])
    sock.text({ t: 'session.order', sids: [1, 2, 3] })
    expect(ctl.get().sessions.map((s) => `${s.index}:${s.sid}`)).toEqual(['1:1', '2:2', '3:3'])
  })
})

describe('UT-close-1 关闭没落地', () => {
  it('离线时关闭：提示，不标成关闭中（重连后照常收发）；确认浮层开着时再按关闭不覆盖', async () => {
    sock.text(welcome([info(1), info(2)]))
    ctl.requestClose(1)
    ctl.requestClose(2)
    expect(ctl.get().closing, '确认开着：第二次关闭忽略').toBe(1)
    ctl.cancelClose()
    sock.close()
    ctl.requestClose(1)
    ctl.confirmClose()
    expect(ctl.get().toast?.text).toBe('未连接，稍后再关闭会话')
    await new Promise((r) => setTimeout(r, 900))
    const s2 = sockets[sockets.length - 1]!
    s2.open()
    s2.text(welcome([info(1), info(2)], { resumed: [{ sid: 1, status: 'ok', from_seq: 0, in_ack: 0 }] }))
    inside('keydown', () => xterm(1).input('x', true))
    expect(s2.inputs(), '没关成的会话照常收输入').toContain('x')
  })

  it('发出去了但重连后 welcome 里它还在：不再算关闭中', async () => {
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
