/** AC-3.20 点按终端：没开鼠标跟踪时切换软键盘；开了交给 xterm；拖动不算点。 */
import { describe, expect, it } from 'vitest'

import { TAP_MAX_MOVE, TAP_MAX_MS, installTapToggle, isTap, type TapTarget } from '../src/term/gestures'

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
