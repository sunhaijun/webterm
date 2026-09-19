import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installPinch, type Pinch } from '../src/term/pinch'

/**
 * UT-scroll-1：单指纵向拖的落地节奏（AC-5.15）。
 *
 * 【为什么要在单测里量】：E2E 里 `.xterm-viewport.scrollTop` 不只有我们写 ——
 * xterm 自己的 `syncScrollArea` 也会写（把视口对齐到行边界），数出来的次数里
 * 混着它的。这里没有 xterm，数到的每一次都是我们的，"每帧至多一次"才钉得死。
 *
 * jsdom 没有布局，`scrollTop` 读永远是 0、写是空操作，所以自己接管这个属性 ——
 * 顺带也就成了写入计数器。
 */
interface Harness {
  host: HTMLElement
  pinch: Pinch
  /** scrollTop 被写了几次。 */
  sets(): number
  top(): number
  start(y: number): void
  move(y: number): void
  end(): void
}

function mount(initialTop = 500): Harness {
  const host = document.createElement('div')
  host.className = 'term'
  const page = document.createElement('div')
  page.className = 'term-host'
  const vp = document.createElement('div')
  vp.className = 'xterm-viewport'
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  page.append(vp, screen)
  host.append(page)
  document.body.append(host)

  let top = initialTop
  let sets = 0
  Object.defineProperty(vp, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      sets++
      top = v
    },
  })

  const fire = (type: string, touches: { clientX: number; clientY: number }[]) => {
    const ev = new Event(type, { cancelable: true, bubbles: true })
    Object.defineProperty(ev, 'touches', { value: touches })
    host.dispatchEvent(ev)
  }
  const one = (y: number) => [{ clientX: 100, clientY: y }]

  return {
    host,
    pinch: installPinch(host),
    sets: () => sets,
    top: () => top,
    start: (y) => fire('touchstart', one(y)),
    move: (y) => fire('touchmove', one(y)),
    // 抬起时 touches 是空的 —— 手势结束的整条路都挂在这上面
    end: () => fire('touchend', []),
  }
}

describe('单指纵向拖：每帧至多落一次 scrollTop（AC-5.15 / UT-scroll-1）', () => {
  let h: Harness
  beforeEach(() => {
    // 【performance 也要假】：惯性滑行按 performance.now() 的时间差算位移，
    // 真时钟下 advanceTimersByTime 推不动它，dt 永远是 0 —— 滑行第一帧就会被
    // "位置没变 = 撞到边界"判停，测出来像是没有惯性
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame'] })
    h = mount()
  })
  afterEach(() => {
    h.pinch.dispose()
    h.host.remove()
    vi.useRealTimers()
  })

  it('一帧里来三个 touchmove，只落一次；落的是三段位移的【总和】', () => {
    h.start(300)
    h.move(312) // dy=12，够 LOCK_PX，轴锁定为纵向
    h.move(324)
    h.move(336)
    expect(h.sets(), 'touchmove 里一次都不该写').toBe(0)

    vi.advanceTimersByTime(20) // 下一帧
    expect(h.sets(), '每帧至多一次').toBe(1)
    expect(h.top(), '手指向下拖 36px = 往回滚 36px').toBe(500 - 36)
  })

  it('连着三帧，每帧一次，共三次 —— 不是每个事件一次', () => {
    h.start(300)
    for (let f = 0; f < 3; f++) {
      const base = 300 + f * 36
      h.move(base + 12)
      h.move(base + 24)
      h.move(base + 36)
      vi.advanceTimersByTime(20)
    }
    expect(h.sets(), '9 个事件 / 3 帧 → 3 次写入').toBe(3)
    expect(h.top()).toBe(500 - 108)
  })

  it('松手时把还没落地的那一段补上，不丢位移', () => {
    h.start(300)
    h.move(312)
    h.move(324)
    // 还没到下一帧就抬手
    h.end()
    expect(h.sets(), '抬手时补落一次').toBe(1)
    expect(h.top()).toBe(500 - 24)
  })

  it('横向手势不碰 scrollTop（轴锁把两条路分开）', () => {
    const fireX = (type: string, x: number) => {
      const ev = new Event(type, { cancelable: true, bubbles: true })
      Object.defineProperty(ev, 'touches', { value: [{ clientX: x, clientY: 300 }] })
      h.host.dispatchEvent(ev)
    }
    h.start(300)
    fireX('touchmove', 140) // 只动 x：轴锁选横向
    fireX('touchmove', 180)
    vi.advanceTimersByTime(20)
    expect(h.sets(), '横滑切会话不该动 scrollTop').toBe(0)
  })

  it('真手指节奏（帧与帧之间有时间）松手后有惯性，且滑一会儿就停', () => {
    h.start(300)
    let y = 300
    for (let f = 0; f < 5; f++) {
      y += 12
      h.move(y)
      vi.advanceTimersByTime(16) // 一帧 16ms，速度 = 0.75 px/ms
    }
    const atRelease = h.top()
    const setsAtRelease = h.sets()
    h.end()

    vi.advanceTimersByTime(100)
    expect(h.sets(), '松手后还在落地 = 有惯性').toBeGreaterThan(setsAtRelease)
    expect(h.top(), '继续往回滚').toBeLessThan(atRelease)

    vi.advanceTimersByTime(1000)
    const settled = h.sets()
    vi.advanceTimersByTime(500)
    expect(h.sets(), '1 秒多以后必须已经停了，不能一直空转').toBe(settled)
  })

  it('滑行中再触摸：立刻停', () => {
    h.start(300)
    let y = 300
    for (let f = 0; f < 5; f++) {
      y += 12
      h.move(y)
      vi.advanceTimersByTime(16)
    }
    h.end()
    vi.advanceTimersByTime(50)
    h.start(200) // 手指又落下
    const stopped = h.top()
    vi.advanceTimersByTime(300)
    expect(h.top(), '手指落下就该停住').toBe(stopped)
  })

  it('合成手势（同一 tick 发完）不会甩飞：采不到速度就没有惯性', () => {
    h.start(300)
    h.move(312)
    h.move(324)
    h.move(336)
    h.end()
    const afterRelease = h.sets()
    vi.advanceTimersByTime(600) // 给足惯性滑行的时间
    expect(h.sets(), '没有速度信息就不该有惯性').toBe(afterRelease)
  })
})
