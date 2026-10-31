/**
 * 会话层（session-ux.md）：列表与编号、未读、订阅、相邻会话、进程结束提示行、
 * 已退出会话里的输入路由。
 */
import { beforeAll, describe, expect, it } from 'vitest'

import {
  SessionStore,
  displayName,
  routeInput,
  shortCwd,
  shouldShowExitLine,
  type ConnLike,
} from '../src/sessions/store'
import { flush, info, lines } from './helpers'

// jsdom 没有 matchMedia；term.open() 要用它量 devicePixelRatio
beforeAll(() => {
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
})

class FakeConn implements ConnLike {
  calls: string[] = []
  out = new Map<number, number>()
  head = new Map<number, number>()
  subscribe(sid: number, cols?: number, rows?: number) {
    this.calls.push(cols ? `sub:${sid}:${cols}x${rows}` : `sub:${sid}`)
  }
  unsubscribe(sid: number) {
    this.calls.push(`unsub:${sid}`)
  }
  forget(sid: number) {
    this.calls.push(`forget:${sid}`)
  }
  outSeqOf(sid: number) {
    return this.out.get(sid) ?? 0
  }
  headSeqOf(sid: number) {
    return this.head.get(sid) ?? 0
  }
  isUnread(sid: number) {
    return this.headSeqOf(sid) > this.outSeqOf(sid)
  }
}

function make() {
  const conn = new FakeConn()
  let changes = 0
  const store = new SessionStore(conn, {
    onChange: () => changes++,
    onData() {},
    allowKey: () => true,
    theme: () => undefined,
    fontSize: () => 14,
  })
  const area = document.createElement('div')
  document.body.appendChild(area)
  return { conn, store, area, changes: () => changes }
}

const enc = (s: string) => new TextEncoder().encode(s)

describe('列表', () => {
  it('UT-order-1 按 agent 给的顺序排（不看 created_at），新来的排最后；编号 [n] 从 1 开始，关掉中间的后面顺延', () => {
    const { store } = make()
    store.upsert(info(5, { created_at: 300 }))
    store.upsert(info(2, { created_at: 100 }))
    store.upsert(info(9, { created_at: 200 }))
    const view = () => store.list().map((s) => `${s.index}:${s.sid}`)
    expect(view(), '没给顺序：按到达顺序').toEqual(['1:5', '2:2', '3:9'])
    store.setOrder([9, 5, 2])
    expect(view()).toEqual(['1:9', '2:5', '3:2'])
    store.remove(5)
    expect(view()).toEqual(['1:9', '2:2'])
    store.upsert(info(7))
    expect(view(), '新建的排最后').toEqual(['1:9', '2:2', '3:7'])
  })

  it('UT-order-1 session.order：不认识的 sid 忽略，没列出的已知会话按原相对顺序接在后面；本地先挪', () => {
    const { store } = make()
    for (const sid of [1, 2, 3, 4]) store.upsert(info(sid))
    store.setOrder([3, 99, 1])
    expect(store.list().map((s) => s.sid)).toEqual([3, 1, 2, 4])
    store.move(4, 3)
    expect(store.list().map((s) => s.sid)).toEqual([4, 3, 1, 2])
    store.move(4, null)
    expect(store.list().map((s) => s.sid)).toEqual([3, 1, 2, 4])
    expect(store.step(1), '没有当前会话：从头走').toBe(3)
  })

  it('未读 = 非当前会话且 head > out；当前会话不显示未读', () => {
    const { store, conn, area } = make()
    store.upsert(info(1))
    store.upsert(info(2))
    conn.head.set(1, 10)
    conn.head.set(2, 10)
    store.activate(1, area)
    const v = store.list()
    expect(v.find((s) => s.sid === 1)!.unread).toBe(false)
    expect(v.find((s) => s.sid === 2)!.unread).toBe(true)
    expect(v.find((s) => s.sid === 1)!.active).toBe(true)
  })

  it('upsert 已有的会话是合并，不重建终端', () => {
    const { store } = make()
    store.upsert(info(1, { name: 'a' }))
    const term = store.termOf(1)
    store.upsert(info(1, { name: 'b' }))
    expect(store.termOf(1)).toBe(term)
    expect(store.list()[0]!.name).toBe('b')
  })
})

describe('订阅（只订阅当前可见的 + 保持接收的）', () => {
  it('切换：先退订上一个，再挂载、订阅新的，尺寸在 subscribe 里', () => {
    const { store, conn, area } = make()
    store.upsert(info(1))
    store.upsert(info(2))
    store.activate(1, area)
    store.activate(2, area)
    const t1 = store.termOf(1)!.term
    const t2 = store.termOf(2)!.term
    expect(conn.calls).toEqual([`sub:1:${t1.cols}x${t1.rows}`, 'unsub:1', `sub:2:${t2.cols}x${t2.rows}`])
    expect(area.querySelectorAll('.term-host')).toHaveLength(1)
    expect(store.active).toBe(2)
  })

  it('切到当前会话什么都不做（不重复订阅）', () => {
    const { store, conn, area } = make()
    store.upsert(info(1))
    store.activate(1, area)
    store.activate(1, area)
    expect(conn.calls.filter((c) => c.startsWith('sub'))).toHaveLength(1)
  })

  it('保持接收：切走也不退订；在后台开关它立刻订阅 / 退订', () => {
    const { store, conn, area } = make()
    store.upsert(info(1))
    store.upsert(info(2))
    store.activate(1, area)
    store.togglePinned(1) // 当前会话：本来就订着
    store.activate(2, area)
    expect(conn.calls).not.toContain('unsub:1')
    store.togglePinned(1) // 在后台关掉
    expect(conn.calls[conn.calls.length - 1]).toBe('unsub:1')
    store.togglePinned(1)
    expect(conn.calls[conn.calls.length - 1]).toBe('sub:1')
    expect(store.list().find((s) => s.sid === 1)!.pinned).toBe(true)
  })

  it('remove：销毁终端、忘掉记账；是当前会话就清掉 active', () => {
    const { store, conn, area } = make()
    store.upsert(info(1))
    store.activate(1, area)
    store.remove(1)
    expect(conn.calls).toContain('forget:1')
    expect(store.active).toBeNull()
    expect(area.querySelectorAll('.term-host')).toHaveLength(0)
  })
})

describe('相邻会话', () => {
  it('关闭后优先切到后一个，没有就前一个', () => {
    const { store } = make()
    for (const sid of [1, 2, 3]) store.upsert(info(sid))
    expect(store.neighbourOf(2)).toBe(3)
    expect(store.neighbourOf(3)).toBe(2)
    expect(store.neighbourOf(1)).toBe(2)
  })

  it('Ctrl+Shift+↑/↓ 到头回绕', () => {
    const { store, area } = make()
    for (const sid of [1, 2, 3]) store.upsert(info(sid))
    store.activate(3, area)
    expect(store.step(1)).toBe(1)
    expect(store.step(-1)).toBe(2)
    store.activate(1, area)
    expect(store.step(-1)).toBe(3)
  })
})

describe('进程结束提示行（AC-4.5）', () => {
  it('判据：已退出且输出已追平', () => {
    expect(shouldShowExitLine('running', 10, 10)).toBe(false)
    expect(shouldShowExitLine('exited', 5, 10)).toBe(false)
    expect(shouldShowExitLine('exited', 10, 10)).toBe(true)
  })

  it('退出时还没追平：等补课的字节写完再写，提示行排在最后', async () => {
    const { store, conn } = make()
    store.upsert(info(1))
    conn.head.set(1, 10)
    conn.out.set(1, 0)
    store.patch(1, { status: 'exited', exit_code: 1 })
    const t = store.termOf(1)!.term
    await flush(t)
    expect(lines(t)).toEqual([])
    conn.out.set(1, 10)
    store.output(1, enc('LAST-LINE\r\n'), true)
    await flush(t)
    await flush(t)
    expect(lines(t)).toEqual(['LAST-LINE', '[进程已结束（退出码 1）· 按 Enter 关闭]'])
  })

  it('只写一次；收到快照（会清屏）后再写一次 —— 刷新、重连之后始终只有一行', async () => {
    const { store, conn } = make()
    store.upsert(info(1, { status: 'exited', exit_code: 0 }))
    const t = store.termOf(1)!.term
    store.patch(1, { name: 'x' })
    store.output(1, enc(''), false)
    await flush(t)
    await flush(t)
    expect(lines(t).filter((l) => l.includes('进程已结束'))).toHaveLength(1)

    conn.out.set(1, 50)
    conn.head.set(1, 50)
    store.snapshot(1, enc('restored\r\n'))
    await flush(t)
    await flush(t)
    expect(lines(t)).toEqual(['restored', '[进程已结束（退出码 0）· 按 Enter 关闭]'])
  })

  it('提示行不改变 outSeq（它是本地写入，不在 agent 的模拟器里）', () => {
    const { store, conn } = make()
    conn.out.set(1, 7)
    conn.head.set(1, 7)
    store.upsert(info(1, { status: 'exited', exit_code: 2 }))
    expect(conn.outSeqOf(1)).toBe(7)
  })
})

describe('输入路由与显示', () => {
  it('已退出的会话里：\\r 关闭，其余丢弃；在跑的会话照发', () => {
    expect(routeInput('running', '\r')).toBe('send')
    expect(routeInput('running', 'ls')).toBe('send')
    expect(routeInput('exited', '\r')).toBe('close')
    expect(routeInput('exited', 'q')).toBe('drop')
    expect(routeInput('exited', 'echo hi')).toBe('drop')
  })

  it('家目录（welcome.home）缩成 ~：等于它或在它之下才缩', () => {
    const home = '/home/sun'
    expect(shortCwd('/home/sun/github/webterm', home)).toBe('~/github/webterm')
    expect(shortCwd('/home/sun', home)).toBe('~')
    expect(shortCwd('/home/sunny/x', home), '只是前缀相同不算').toBe('/home/sunny/x')
    expect(shortCwd('/srv/api', home)).toBe('/srv/api')
    expect(shortCwd('/root/x', '/root')).toBe('~/x')
    expect(shortCwd('/home/sun/x', '/home/sun/'), 'home 带尾斜杠也认').toBe('~/x')
  })

  it('welcome 里没有 home：不缩写，也不猜 /home/<user>', () => {
    expect(shortCwd('/home/sun/github', null)).toBe('/home/sun/github')
    expect(shortCwd('/root', undefined)).toBe('/root')
    expect(shortCwd('/etc', '/'), 'home 是 / 时不缩写').toBe('/etc')
  })

  it('名字为空时兜底成 shell', () => {
    expect(displayName({ name: '' })).toBe('shell')
    expect(displayName({ name: 'api' })).toBe('api')
  })
})
