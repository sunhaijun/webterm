/**
 * 终端上的触屏手势（ADR-0025 §5，input.md §点按终端，AC-3.20）。
 *
 * m8 只有「点一下」：
 *   - 前台程序开了鼠标跟踪 → 什么都不做，交给 xterm（浏览器把触摸合成为鼠标事件，
 *     xterm 按程序要的协议上报点击）；
 *   - 没开 → 切换软键盘：终端有焦点就 blur，没有就 focus。focus 必须发生在这次触摸
 *     的处理函数里（iOS 只允许在用户手势里弹键盘），所以在 touchend 里做。
 *
 * 纵向拖是 xterm 自带的触摸滚动；横向拖不做任何事。
 */

/** 「点一下」= 位移 < 10px 且时长 < 300ms。 */
export const TAP_MAX_MOVE = 10
export const TAP_MAX_MS = 300

export interface TouchPoint {
  x: number
  y: number
  t: number
}

/** 一次触摸是不是「点」。`maxMove` 是整个过程里离起点最远的距离。 */
export function isTap(start: TouchPoint, end: TouchPoint, maxMove: number): boolean {
  return maxMove < TAP_MAX_MOVE && end.t - start.t < TAP_MAX_MS
}

export interface TapTarget {
  /** 前台程序开了鼠标跟踪。 */
  mouseTracking(): boolean
  /** 终端此刻有没有焦点（xterm 的 helper textarea）。 */
  focused(): boolean
  focus(): void
  blur(): void
}

/** 在终端容器上装「点一下切软键盘」。`target()` 返回当前会话的终端，没有就 null。 */
export function installTapToggle(el: HTMLElement, target: () => TapTarget | null): () => void {
  let start: TouchPoint | null = null
  let maxMove = 0

  const onStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) {
      start = null
      return
    }
    const p = e.touches[0]!
    start = { x: p.clientX, y: p.clientY, t: e.timeStamp }
    maxMove = 0
  }
  const onMove = (e: TouchEvent) => {
    if (!start) return
    if (e.touches.length !== 1) {
      start = null
      return
    }
    const p = e.touches[0]!
    maxMove = Math.max(maxMove, Math.hypot(p.clientX - start.x, p.clientY - start.y))
  }
  const onEnd = (e: TouchEvent) => {
    const s = start
    start = null
    if (!s || e.changedTouches.length !== 1) return
    const p = e.changedTouches[0]!
    const end = { x: p.clientX, y: p.clientY, t: e.timeStamp }
    const move = Math.max(maxMove, Math.hypot(end.x - s.x, end.y - s.y))
    if (!isTap(s, end, move)) return
    const t = target()
    if (!t || t.mouseTracking()) return // 交给 xterm：合成的 mousedown 会上报点击
    // 不让浏览器再合成 mousedown / click：xterm 的 mousedown 会无条件 focus()，
    // 刚收起的键盘又会被弹出来
    if (e.cancelable) e.preventDefault()
    if (t.focused()) t.blur()
    else t.focus()
  }
  const onCancel = () => {
    start = null
  }

  el.addEventListener('touchstart', onStart, { passive: true })
  el.addEventListener('touchmove', onMove, { passive: true })
  el.addEventListener('touchend', onEnd, { passive: false })
  el.addEventListener('touchcancel', onCancel)
  return () => {
    el.removeEventListener('touchstart', onStart)
    el.removeEventListener('touchmove', onMove)
    el.removeEventListener('touchend', onEnd)
    el.removeEventListener('touchcancel', onCancel)
  }
}
