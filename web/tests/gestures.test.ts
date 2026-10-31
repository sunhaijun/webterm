/**
 * AC-3.20 点按终端：没开鼠标跟踪时切换软键盘；开了交给 xterm；拖动不算点。
 * UT-touch-1（AC-3.21）：开了鼠标跟踪时纵向拖转成滚轮。
 */
import { describe, expect, it } from 'vitest'

import {
  DragWheel,
  TAP_MAX_MOVE,
  detectShift,
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

/** 假终端：wheel(calibrate) 之后进入「标定中」，测试里手动给出标定结果。 */
function wheelTarget(tracking = true) {
  const wheels: { up: boolean; x: number; y: number; calibrate: boolean }[] = []
  const t = {
    tracking,
    step: 3,
    cal: false,
    ok: false,
    mouseTracking: () => t.tracking,
    rowHeight: () => ROW,
    wheelStep: () => t.step,
    calibrating: () => t.cal,
    calibrated: () => t.ok,
    wheel: (up: boolean, x: number, y: number, calibrate: boolean) => {
      wheels.push({ up, x, y, calibrate })
      if (calibrate) {
        t.cal = true
        t.ok = false
      }
    },
    /** 程序重画回来了：量到 step。 */
    measured(step: number) {
      t.step = step
      t.cal = false
      t.ok = true
    },
    /** 等到超时也没认出位移（tmux 第一下只是进 copy-mode；到顶了）。 */
    failed() {
      t.cal = false
      t.ok = false
    },
  }
  return { t: t as typeof t & WheelTarget, wheels }
}

describe('UT-touch-1 DragWheel：按单位距离累计', () => {
  it('上限是 3', () => {
    expect(WHEEL_MAX_PER_MOVE).toBe(3)
  })

  it('满一个单位发一次，零头留到下一帧；手指向下为正（滚轮向上）', () => {
    const d = new DragWheel()
    expect(d.feed(10, ROW)).toBe(0)
    expect(d.feed(10, ROW), '10 + 10 = 20，满一行，余 3').toBe(1)
    expect(d.feed(ROW * 2, ROW)).toBe(2)
    expect(d.feed(-20, ROW), '3 − 20 = −17，正好一行向下').toBe(-1)
    expect(d.feed(-16, ROW)).toBe(0)
  })

  it('一次最多 3 次，超出的丢掉、不攒到下一帧', () => {
    const d = new DragWheel()
    expect(d.feed(ROW * 8 + 5, ROW)).toBe(3)
    expect(d.feed(ROW - 6, ROW), '零头 5 + 11 = 16，不满一行；丢掉的 5 行没攒着').toBe(0)
    expect(d.feed(-ROW * 10, ROW)).toBe(-3)
  })

  it('hold 只攒不发；reset 清掉零头', () => {
    const d = new DragWheel()
    d.hold(ROW * 2)
    expect(d.feed(0, ROW)).toBe(2)
    d.feed(16, ROW)
    d.reset()
    expect(d.feed(1, ROW)).toBe(0)
  })
})

describe('UT-touch-1 detectShift：程序一次滚了几行', () => {
  const lines = (from: number, n: number) => Array.from({ length: n }, (_, i) => `L${String(from + i).padStart(3, '0')}`)

  it('向上滚：内容整体下移 k 行', () => {
    expect(detectShift(lines(100, 20), lines(95, 20), true)).toBe(5)
    expect(detectShift(lines(100, 20), lines(99, 20), true)).toBe(1)
  })

  it('向下滚：内容整体上移 k 行', () => {
    expect(detectShift(lines(100, 20), lines(103, 20), false)).toBe(3)
  })

  it('静止的标题、状态栏、重复的分隔线不干扰', () => {
    const frame = (from: number) => ['header', '────', ...lines(from, 16), '────', 'status [0/300]']
    const after = [...frame(96)]
    after[19] = 'status [4/300]'
    expect(detectShift(frame(100), after, true)).toBe(4)
  })

  it('认不出来就是 0：没动、内容全换了、只有一行对得上、方向反了', () => {
    expect(detectShift(lines(100, 20), lines(100, 20), true)).toBe(0)
    expect(detectShift(lines(100, 20), lines(500, 20), true)).toBe(0)
    const one = lines(500, 20)
    one[10] = 'L105'
    expect(detectShift(lines(100, 20), one, true)).toBe(0)
    expect(detectShift(lines(100, 20), lines(95, 20), false)).toBe(0)
  })
})

describe('UT-touch-1 installDragWheel（AC-3.21）', () => {
  it('跟手：第一下立刻发并标定，标定期间攒着；之后按「步长 × 行高」发，第一下那一步扣掉', () => {
    const el = document.createElement('div')
    const { t, wheels } = wheelTarget()
    installDragWheel(el, () => t)
    const unit = ROW * 5
    finger(el, 'touchstart', 50, 100)
    const small = finger(el, 'touchmove', 50, 105)
    expect(wheels, '不到 10px：可能还是点').toEqual([])
    expect(small.defaultPrevented).toBe(false)
    const first = finger(el, 'touchmove', 52, 112)
    expect(first.defaultPrevented, '转换期间不让浏览器再滚一次').toBe(true)
    expect(wheels).toEqual([{ up: true, x: 52, y: 112, calibrate: true }])
    finger(el, 'touchmove', 52, 130)
    finger(el, 'touchmove', 52, 150)
    expect(wheels.length, '标定期间只攒不发').toBe(1)
    t.measured(5)
    // 起点到这里 182px = 2.14 个单位：第一下算一个，再发一个
    finger(el, 'touchmove', 52, 100 + 182)
    expect(wheels[0]!.calibrate && !wheels[1]!.calibrate, '量到了就不再量').toBe(true)
    expect(wheels.length).toBe(2)
    expect(wheels[1]).toEqual({ up: true, x: 52, y: 282, calibrate: false })
    // 拖到 5 个单位整：一共 5 次 —— 内容走 25 行，手指走 25 行
    finger(el, 'touchmove', 52, 100 + unit * 5)
    expect(wheels.length).toBe(5)
    expect(wheels.every((w) => w.up)).toBe(true)
    // 往回拖 2 个单位：2 次向下
    finger(el, 'touchmove', 52, 100 + unit * 4)
    finger(el, 'touchmove', 52, 100 + unit * 3)
    expect(wheels.slice(5).map((w) => w.up)).toEqual([false, false])
    finger(el, 'touchend', 52, 100 + unit * 3)
  })

  it('每次拖动都重新标定', () => {
    const el = document.createElement('div')
    const { t, wheels } = wheelTarget()
    installDragWheel(el, () => t)
    finger(el, 'touchstart', 50, 100)
    finger(el, 'touchmove', 50, 120)
    t.measured(1)
    finger(el, 'touchend', 50, 120)
    finger(el, 'touchstart', 50, 300)
    finger(el, 'touchmove', 50, 280)
    expect(wheels.map((w) => [w.up, w.calibrate])).toEqual([
      [true, true],
      [false, true],
    ])
  })

  it('第一下量不到（tmux 只是进了 copy-mode）：它不算挪了一步，下一下再量', () => {
    const el = document.createElement('div')
    const { t, wheels } = wheelTarget()
    installDragWheel(el, () => t)
    const unit = ROW * 5
    finger(el, 'touchstart', 50, 100)
    finger(el, 'touchmove', 50, 112)
    finger(el, 'touchmove', 50, 140)
    t.failed()
    finger(el, 'touchmove', 50, 150)
    expect(wheels.map((w) => w.calibrate), '再量一次').toEqual([true, true])
    t.measured(5)
    // 起点到这里 = 2 个单位：第一下没挪，第二下算一个，再发一个
    finger(el, 'touchmove', 50, 100 + unit * 2)
    expect(wheels.map((w) => w.calibrate)).toEqual([true, true, false])
  })

  it('一次拖动最多量 2 次：都量不到就按已知步长走，不再等', () => {
    const el = document.createElement('div')
    const { t, wheels } = wheelTarget()
    t.step = 1
    installDragWheel(el, () => t)
    finger(el, 'touchstart', 50, 100)
    finger(el, 'touchmove', 50, 112)
    t.failed()
    finger(el, 'touchmove', 50, 113)
    t.failed()
    // 两次都没挪：之后每移动一行高（步长 1）发一次，攒着的 13px 也算数
    finger(el, 'touchmove', 50, 100 + ROW * 2.5)
    finger(el, 'touchmove', 50, 100 + ROW * 4)
    expect(wheels.map((w) => w.calibrate)).toEqual([true, true, false, false, false, false])
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
