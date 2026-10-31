/**
 * 终端上的触屏手势（ADR-0025 §5，input.md §点按终端，AC-3.20）。
 *
 * m8 只有「点一下」：
 *   - 前台程序开了鼠标跟踪 → 什么都不做，交给 xterm（浏览器把触摸合成为鼠标事件，
 *     xterm 按程序要的协议上报点击）；
 *   - 没开 → 切换软键盘：终端有焦点就 blur，没有就 focus。focus 必须发生在这次触摸
 *     的处理函数里（iOS 只允许在用户手势里弹键盘），所以在 touchend 里做。
 *
 * 纵向拖：没开鼠标跟踪时是 xterm 自带的触摸滚动；开了就由 installDragWheel 转成滚轮
 * （ADR-0029 / 0032）—— xterm 5.5 在鼠标跟踪时不处理触摸。横向拖不做任何事。
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

// ---------- 纵向拖转滚轮（ADR-0029 / ADR-0032，input.md §纵向拖，AC-3.21） ----------

/** 一次 touchmove 最多发几次滚轮。浏览器把 touchmove 合并到每帧一个，约等于每帧上限。 */
export const WHEEL_MAX_PER_MOVE = 3

/** 按行高累计手指的纵向位移，换成滚轮次数。 */
export class DragWheel {
  private rest = 0

  /**
   * 喂入这一帧的纵向位移（px，手指向下为正），返回要发几次滚轮：正 = 向上滚（看更早的）。
   * 超过上限的整行直接丢掉，不攒到下一帧 —— 否则松手后还在往外吐。
   */
  feed(dy: number, rowPx: number): number {
    this.rest += dy
    const n = Math.trunc(this.rest / rowPx) || 0 // 不满一行的负位移 trunc 出 -0
    this.rest -= n * rowPx
    return Math.max(-WHEEL_MAX_PER_MOVE, Math.min(WHEEL_MAX_PER_MOVE, n))
  }

  reset(): void {
    this.rest = 0
  }
}

export interface WheelTarget {
  /** 前台程序开了鼠标跟踪。 */
  mouseTracking(): boolean
  /** 一行的高度（px）。 */
  rowHeight(): number
  /** 在视口坐标 (x, y) 处发一次滚轮；up = 向上滚。 */
  wheel(up: boolean, x: number, y: number): void
}

/**
 * 在终端容器上装「鼠标跟踪时纵向拖 = 滚轮」：手指每移动一行高发一次（ADR-0032）。
 * 程序一次滚几行由程序定（tmux 5 行），不标定、不等往返。位移满 10px（点的门槛）且纵向
 * 占优才算拖，从起点开始累计；转换期间 preventDefault，免得浏览器再原生滚一次。
 * 没开鼠标跟踪时什么都不做，交给 xterm 的触摸滚动。
 */
export function installDragWheel(el: HTMLElement, target: () => WheelTarget | null): () => void {
  let start: { x: number; y: number } | null = null
  let lastY = 0
  let dragging = false
  const acc = new DragWheel()

  const onStart = (e: TouchEvent) => {
    start = null
    if (e.touches.length !== 1) return
    const p = e.touches[0]!
    start = { x: p.clientX, y: p.clientY }
    lastY = p.clientY
    dragging = false
    acc.reset()
  }
  const onMove = (e: TouchEvent) => {
    if (!start) return
    if (e.touches.length !== 1) {
      start = null
      return
    }
    const t = target()
    if (!t || !t.mouseTracking()) return
    const p = e.touches[0]!
    if (!dragging) {
      const dx = p.clientX - start.x
      const dy = p.clientY - start.y
      if (Math.hypot(dx, dy) < TAP_MAX_MOVE) return // 可能还是点
      if (Math.abs(dy) <= Math.abs(dx)) {
        start = null // 横向拖：不做任何事
        return
      }
      dragging = true
    }
    if (e.cancelable) e.preventDefault()
    const n = acc.feed(p.clientY - lastY, t.rowHeight())
    lastY = p.clientY
    for (let i = 0; i < Math.abs(n); i++) t.wheel(n > 0, p.clientX, p.clientY)
  }
  const onEnd = () => {
    start = null
  }

  el.addEventListener('touchstart', onStart, { passive: true })
  el.addEventListener('touchmove', onMove, { passive: false })
  el.addEventListener('touchend', onEnd)
  el.addEventListener('touchcancel', onEnd)
  return () => {
    el.removeEventListener('touchstart', onStart)
    el.removeEventListener('touchmove', onMove)
    el.removeEventListener('touchend', onEnd)
    el.removeEventListener('touchcancel', onEnd)
  }
}
