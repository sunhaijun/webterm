/** UT-sidebar-1：侧栏宽度的夹紧 / 吸附 / 收起 / 持久化（AC-5.12）。 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  SIDEBAR_DEFAULT,
  STEP,
  STEP_BIG,
  clampSidebarWidth,
  readSidebarOpen,
  readSidebarWidth,
  settleSidebarWidth,
  sidebarMax,
  sidebarMin,
  stepSidebarWidth,
  writeSidebarOpen,
  writeSidebarWidth,
} from '../src/ui/sidebar'

beforeEach(() => localStorage.clear())

describe('上下限', () => {
  it('触屏的最小宽更大 —— 三个 44px 图标就占 132px', () => {
    expect(sidebarMin(false)).toBe(200)
    expect(sidebarMin(true)).toBe(260)
  })

  it('上限 = min(480, 窗口宽 40%)', () => {
    expect(sidebarMax(1440, false)).toBe(480) // 576 → 撞 480 的硬上限
    expect(sidebarMax(1024, false)).toBe(410) // 40% 更小，听它的
  })

  it('窄窗口上限不会掉到最小宽以下 —— 否则夹紧区间是空的', () => {
    // 1024 的 40% 是 410，触屏最小 260，还撑得住；再窄就靠这条兜底
    expect(sidebarMax(600, true)).toBe(260)
    expect(clampSidebarWidth(999, 600, true)).toBe(260)
  })

  it('越界与非数都被夹回去', () => {
    expect(clampSidebarWidth(50, 1440, false)).toBe(200)
    expect(clampSidebarWidth(9999, 1440, false)).toBe(480)
    expect(clampSidebarWidth(NaN, 1440, false)).toBe(SIDEBAR_DEFAULT)
    expect(clampSidebarWidth(320.4, 1440, false)).toBe(320)
  })
})

describe('松手结算', () => {
  it('离默认宽 ≤12px 吸附回 240', () => {
    expect(settleSidebarWidth(233, 240, 1440, false)).toEqual({ width: 240, open: true })
    expect(settleSidebarWidth(252, 240, 1440, false)).toEqual({ width: 240, open: true })
    expect(settleSidebarWidth(253, 240, 1440, false)).toEqual({ width: 253, open: true })
  })

  it('拖到最小宽六成以下 = 收起，且宽度保持拖动前的值', () => {
    // 200 × 0.6 = 120
    expect(settleSidebarWidth(119, 320, 1440, false)).toEqual({ width: 320, open: false })
    expect(settleSidebarWidth(-40, 320, 1440, false)).toEqual({ width: 320, open: false })
    // 刚好在门槛上 → 不收起，夹到最小宽
    expect(settleSidebarWidth(120, 320, 1440, false)).toEqual({ width: 200, open: true })
  })

  it('从收起态拖出来：过了门槛就展开到拖到的宽度', () => {
    expect(settleSidebarWidth(320, 240, 1440, false)).toEqual({ width: 320, open: true })
  })

  it('触屏的收起门槛跟着最小宽抬高', () => {
    // 260 × 0.6 = 156
    expect(settleSidebarWidth(150, 300, 1440, true).open).toBe(false)
    expect(settleSidebarWidth(160, 300, 1440, true).open).toBe(true)
  })

  it('吸附之后仍受上限约束', () => {
    // 窗口窄到上限 200（500×40%）以下时，240 也要被夹回去
    expect(settleSidebarWidth(236, 240, 500, false)).toEqual({ width: 200, open: true })
  })
})

describe('键盘步进', () => {
  it('方向键 16px、Shift 64px，到边界就停住', () => {
    expect(stepSidebarWidth(240, STEP, 1440, false)).toBe(256)
    expect(stepSidebarWidth(240, -STEP, 1440, false)).toBe(224)
    expect(stepSidebarWidth(240, STEP_BIG, 1440, false)).toBe(304)
    expect(stepSidebarWidth(205, -STEP, 1440, false)).toBe(200)
    expect(stepSidebarWidth(475, STEP, 1440, false)).toBe(480)
  })
})

describe('持久化', () => {
  it('往返一趟', () => {
    writeSidebarWidth(321.6)
    expect(readSidebarWidth()).toBe(322)
    writeSidebarOpen(false)
    expect(readSidebarOpen()).toBe(false)
    writeSidebarOpen(true)
    expect(readSidebarOpen()).toBe(true)
  })

  it('没存过 = 默认宽 + 展开（桌面本来就是常驻侧栏）', () => {
    expect(readSidebarWidth()).toBe(SIDEBAR_DEFAULT)
    expect(readSidebarOpen()).toBe(true)
  })

  it('存进去的垃圾值不生效', () => {
    localStorage.setItem('webterm.sidebar.w', 'wide')
    expect(readSidebarWidth()).toBe(SIDEBAR_DEFAULT)
    localStorage.setItem('webterm.sidebar.w', '-30')
    expect(readSidebarWidth()).toBe(SIDEBAR_DEFAULT)
  })

  it('存的是裸像素值，上下限读的时候再夹 —— 换个窗口/设备不该把存储写坏', () => {
    writeSidebarWidth(460)
    // 小窗口下读出来仍是 460，由调用方按当时的窗口夹
    expect(readSidebarWidth()).toBe(460)
    expect(clampSidebarWidth(readSidebarWidth(), 1024, false)).toBe(410)
    // 夹紧不回写：换回大窗口还是 460
    expect(readSidebarWidth()).toBe(460)
  })

  it('localStorage 抛异常时读写都不能崩', () => {
    const orig = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError')
      },
    })
    expect(() => writeSidebarWidth(300)).not.toThrow()
    expect(() => writeSidebarOpen(false)).not.toThrow()
    expect(readSidebarWidth()).toBe(SIDEBAR_DEFAULT)
    expect(readSidebarOpen()).toBe(true)
    if (orig) Object.defineProperty(window, 'localStorage', orig)
  })
})
