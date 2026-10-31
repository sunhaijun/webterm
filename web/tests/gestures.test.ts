/**
 * AC-3.20 点按终端：没开鼠标跟踪时切换软键盘；开了交给 xterm；拖动不算点。
 * UT-touch-1（AC-3.21）：开了鼠标跟踪时纵向拖转成滚轮。
 */
import { describe, expect, it } from 'vitest'

import {
  DragWheel,
  TAP_MAX_MOVE,
  WHEEL_MAX_PER_MOVE,
  TAP_MAX_MS,
  installDragWheel,
  installTapToggle,
  isTap,
  type TapTarget,
  type WheelTarget,
} from '../src/term/gestures'

describe('isTap', () => {
  it('位移 < 10px 且时长 < 300ms', () => {
    expect(TAP_MAX_MOVE).toBe(10)
    expect(TAP_MAX_MS).toBe(300)
    const s = { x: 0, y: 0, t: 0 }
    expect(isTap(s, { x: 2, y: 2, t: 100 }, 3)).toBe(true)
    expect(isTap(s, { x: 0, y: 30, t: 100 }, 30), '纵向拖 30px').toBe(false)
    expect(isTap(s, { x: 0, y: 0, t: 400 }, 0), '按太久').toBe(false)
    expect(isTap(s, { x: 0, y: 0, t: 100 }, 12), '中途拖远又回来').toBe(false)
  })
})

function touch(el: HTMLElement, type: string, y: number, timeStamp: number): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  const pts = [{ clientX: 50, clientY: y }]
  Object.defineProperty(ev, 'touches', { value: type === 'touchend' ? [] : pts })
  Object.defineProperty(ev, 'changedTouches', { value: pts })
  Object.defineProperty(ev, 'timeStamp', { value: timeStamp })
  el.dispatchEvent(ev)
  return ev
}

function target(tracking = false) {
  const log: string[] = []
  let focused = false
  const t: TapTarget = {
    mouseTracking: () => tracking,
    focused: () => focused,
    focus: () => {
      focused = true
      log.push('focus')
    },
    blur: () => {
      focused = false
      log.push('blur')
    },
  }
  return { t, log }
}

describe('installTapToggle', () => {
  it('点一下聚焦，再点一下失焦；并 preventDefault 掉合成的鼠标事件', () => {
    const el = document.createElement('div')
    const { t, log } = target()
    installTapToggle(el, () => t)
    touch(el, 'touchstart', 100, 0)
    const end = touch(el, 'touchend', 102, 80)
    expect(end.defaultPrevented).toBe(true)
    touch(el, 'touchstart', 100, 1000)
    touch(el, 'touchend', 100, 1050)
    expect(log).toEqual(['focus', 'blur'])
  })

  it('纵向拖 30px 不改变焦点（那是滚动）', () => {
    const el = document.createElement('div')
    const { t, log } = target()
    installTapToggle(el, () => t)
    touch(el, 'touchstart', 100, 0)
    touch(el, 'touchmove', 130, 50)
    const end = touch(el, 'touchend', 130, 100)
    expect(log).toEqual([])
    expect(end.defaultPrevented).toBe(false)
  })

  it('开了鼠标跟踪：交给 xterm，不切键盘也不拦合成的鼠标事件', () => {
    const el = document.createElement('div')
    const { t, log } = target(true)
    installTapToggle(el, () => t)
    touch(el, 'touchstart', 100, 0)
    const end = touch(el, 'touchend', 100, 50)
    expect(log).toEqual([])
    expect(end.defaultPrevented).toBe(false)
  })

  it('没有当前会话时什么都不做；卸载后不再响应', () => {
    const el = document.createElement('div')
    const { t, log } = target()
    let cur: TapTarget | null = null
    const off = installTapToggle(el, () => cur)
    touch(el, 'touchstart', 100, 0)
    touch(el, 'touchend', 100, 50)
    cur = t
    off()
    touch(el, 'touchstart', 100, 100)
    touch(el, 'touchend', 100, 150)
    expect(log).toEqual([])
  })
})

/** 一根手指在 (x, y)；touchend 时 touches 为空。 */
function finger(el: HTMLElement, type: string, x: number, y: number, fingers = 1): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  const pts = Array.from({ length: fingers }, () => ({ clientX: x, clientY: y }))
  Object.defineProperty(ev, 'touches', { value: type === 'touchend' ? [] : pts })
  Object.defineProperty(ev, 'changedTouches', { value: pts })
  el.dispatchEvent(ev)
  return ev
}

const ROW = 17

function wheelTarget(tracking = true) {
  const wheels: { up: boolean; x: number; y: number }[] = []
  const t: WheelTarget & { tracking: boolean } = {
    tracking,
    mouseTracking: () => t.tracking,
    rowHeight: () => ROW,
    wheel: (up, x, y) => {
      wheels.push({ up, x, y })
    },
  }
  return { t, wheels }
}

describe('UT-touch-1 DragWheel：按行高累计', () => {
  it('上限是 3', () => {
    expect(WHEEL_MAX_PER_MOVE).toBe(3)
  })

  it('满一行发一次，零头留到下一帧；手指向下为正（滚轮向上）', () => {
    const d = new DragWheel()
    expect(d.feed(10, ROW)).toBe(0)
    expect(d.feed(10, ROW), '10 + 10 = 20，满一行，余 3').toBe(1)
    expect(d.feed(ROW * 2, ROW)).toBe(2)
    expect(d.feed(-20, ROW), '3 − 20 = −17，正好一行向下').toBe(-1)
    expect(d.feed(-16, ROW)).toBe(0)
  })

  it('一次最多 3 次，超出的丢掉、不攒到下一帧；reset 清掉零头', () => {
    const d = new DragWheel()
    expect(d.feed(ROW * 8 + 5, ROW)).toBe(3)
    expect(d.feed(ROW - 6, ROW), '零头 5 + 11 = 16，不满一行；丢掉的 5 行没攒着').toBe(0)
    expect(d.feed(-ROW * 10, ROW)).toBe(-3)
    d.feed(16, ROW)
    d.reset()
    expect(d.feed(1, ROW)).toBe(0)
  })
})

describe('UT-touch-1 installDragWheel（AC-3.21，ADR-0032）', () => {
  it('一拖动就发，不等往返；之后手指每移动一行高发一次，从起点累计', () => {
    const el = document.createElement('div')
    const { t, wheels } = wheelTarget()
    installDragWheel(el, () => t)
    finger(el, 'touchstart', 50, 100)
    const small = finger(el, 'touchmove', 50, 105)
    expect(wheels, '不到 10px：可能还是点').toEqual([])
    expect(small.defaultPrevented).toBe(false)
    const first = finger(el, 'touchmove', 52, 100 + ROW + 1)
    expect(first.defaultPrevented, '转换期间不让浏览器再滚一次').toBe(true)
    expect(wheels, '起点到这里满一行：立刻发').toEqual([{ up: true, x: 52, y: 100 + ROW + 1 }])
    finger(el, 'touchmove', 52, 100 + ROW * 4)
    expect(wheels.length, '一共 4 行').toBe(4)
    expect(wheels.every((w) => w.up)).toBe(true)
    // 往回拖 2 行：2 次向下
    finger(el, 'touchmove', 52, 100 + ROW * 2)
    expect(wheels.slice(4).map((w) => w.up)).toEqual([false, false])
    finger(el, 'touchend', 52, 100 + ROW * 2)
  })

  it('每次拖动从零开始累计：上一次的零头不带过来', () => {
    const el = document.createElement('div')
    const { t, wheels } = wheelTarget()
    installDragWheel(el, () => t)
    finger(el, 'touchstart', 50, 100)
    finger(el, 'touchmove', 50, 100 + ROW * 1.9)
    finger(el, 'touchend', 50, 100 + ROW * 1.9)
    expect(wheels.length).toBe(1)
    finger(el, 'touchstart', 50, 300)
    finger(el, 'touchmove', 50, 300 + 12)
    expect(wheels.length, '12px 不满一行').toBe(1)
  })

  it('快速一甩：一次 touchmove 最多 3 次', () => {
    const el = document.createElement('div')
    const { t, wheels } = wheelTarget()
    installDragWheel(el, () => t)
    finger(el, 'touchstart', 50, 100)
    finger(el, 'touchmove', 50, 100 + ROW * 10)
    expect(wheels.length).toBe(3)
  })

  it('横向占优的拖：什么都不做，也不拦', () => {
    const el = document.createElement('div')
    const { t, wheels } = wheelTarget()
    installDragWheel(el, () => t)
    finger(el, 'touchstart', 50, 100)
    const a = finger(el, 'touchmove', 170, 110)
    const b = finger(el, 'touchmove', 170, 100 + ROW * 4)
    expect(wheels).toEqual([])
    expect(a.defaultPrevented || b.defaultPrevented).toBe(false)
  })

  it('没开鼠标跟踪：交给 xterm 的触摸滚动，不发滚轮、不拦', () => {
    const el = document.createElement('div')
    const { t, wheels } = wheelTarget(false)
    installDragWheel(el, () => t)
    finger(el, 'touchstart', 50, 100)
    const mv = finger(el, 'touchmove', 50, 100 + ROW * 5)
    expect(wheels).toEqual([])
    expect(mv.defaultPrevented).toBe(false)
  })

  it('两根手指（捏合）不算拖；没有当前会话时什么都不做；卸载后不再响应', () => {
    const el = document.createElement('div')
    const { t, wheels } = wheelTarget()
    let cur: WheelTarget | null = t
    const off = installDragWheel(el, () => cur)
    finger(el, 'touchstart', 50, 100, 2)
    finger(el, 'touchmove', 50, 100 + ROW * 5, 2)
    expect(wheels).toEqual([])
    cur = null
    finger(el, 'touchstart', 50, 100)
    finger(el, 'touchmove', 50, 100 + ROW * 5)
    expect(wheels).toEqual([])
    cur = t
    off()
    finger(el, 'touchstart', 50, 100)
    finger(el, 'touchmove', 50, 100 + ROW * 5)
    expect(wheels).toEqual([])
  })
})
