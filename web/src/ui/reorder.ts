/**
 * 拖动排序（AC-4.13，ADR-0040）：纯函数 + 一个只管 DOM 位移的小控制器。
 * 标签栏横着拖（x），手机抽屉竖着拖（y）。
 */

/**
 * 把 `sid` 挪到 `before` 前面（协议 §4.1 session.move）：`before` 为 null 或不在列表里 → 放到最后；
 * 等于 `sid` → 原地不动（和 agent 一致）。
 */
export function moveBefore(order: readonly number[], sid: number, before: number | null): number[] {
  if (!order.includes(sid) || before === sid) return [...order]
  const rest = order.filter((x) => x !== sid)
  const i = before === null ? -1 : rest.indexOf(before)
  if (i < 0) return [...rest, sid]
  return [...rest.slice(0, i), sid, ...rest.slice(i)]
}

/** 把下标 `from` 的项挪到下标 `to`（挪完之后它所在的下标）之后，它应该排在谁前面（null = 最后）。 */
export function beforeAt(order: readonly number[], from: number, to: number): number | null {
  const rest = order.filter((_, i) => i !== from)
  return rest[to] ?? null
}

/**
 * 插入下标：被拖项的中心在轴上的位置 `center`，其余各项（按原顺序，含被拖项自己）的中线 `mids`。
 * 越过谁的中线就排到谁的另一边。返回被拖项挪完之后的下标。
 */
export function dropIndex(mids: readonly number[], from: number, center: number): number {
  let to = from
  for (let i = from - 1; i >= 0 && center < mids[i]!; i--) to = i
  for (let i = from + 1; i < mids.length && center > mids[i]!; i++) to = i
  return to
}

/** 指针离可滚动区边缘多近开始自动滚（px）。 */
export const EDGE_PX = 32
/** 自动滚的速度：每帧最多这么多 px，越靠边越快。 */
export const EDGE_SPEED = 12

/** 指针在 [lo, hi] 区间里的位置 → 这一帧该滚多少（负 = 往起点方向）。 */
export function edgeScroll(pos: number, lo: number, hi: number): number {
  if (pos < lo + EDGE_PX) return -Math.ceil(EDGE_SPEED * Math.min(1, (lo + EDGE_PX - pos) / EDGE_PX))
  if (pos > hi - EDGE_PX) return Math.ceil(EDGE_SPEED * Math.min(1, (pos - (hi - EDGE_PX)) / EDGE_PX))
  return 0
}

export interface DragOptions {
  axis: 'x' | 'y'
  /** 可滚动的容器（标签条 / 抽屉正文）。 */
  scroller: HTMLElement
  /** 参与排序的各项，按当前顺序。 */
  items: HTMLElement[]
  /** 开始拖时各项的 sid，与 items 一一对应（拖动中列表变了也按这份算）。 */
  order: readonly number[]
  /** 被拖的那一项在 items 里的下标。 */
  from: number
  /** 按下时指针在轴上的位置（client 坐标）。 */
  start: number
}

/**
 * 一次拖动：被拖项跟着指针，其余项让位（都只改 transform，不动 DOM），靠边自动滚。
 * `finish()` 清掉所有位移，位置变了就返回该发的 session.move，否则 null。
 */
export class DragReorder {
  private readonly o: DragOptions
  private readonly size: number
  private readonly mids: number[]
  private readonly scroll0: number
  private pos: number
  private to: number
  private raf = 0

  constructor(o: DragOptions) {
    this.o = o
    const r = (el: HTMLElement) => el.getBoundingClientRect()
    const lo = (b: DOMRect) => (o.axis === 'x' ? b.left : b.top)
    const len = (b: DOMRect) => (o.axis === 'x' ? b.width : b.height)
    const rects = o.items.map(r)
    this.mids = rects.map((b) => lo(b) + len(b) / 2)
    // 让位距离 = 被拖项的尺寸（项之间没有空隙）
    this.size = len(rects[o.from]!)
    this.scroll0 = this.scrollPos()
    this.pos = o.start
    this.to = o.from
    o.items[o.from]!.dataset.dragging = 'true'
    o.scroller.dataset.reordering = 'true'
  }

  private scrollPos(): number {
    return this.o.axis === 'x' ? this.o.scroller.scrollLeft : this.o.scroller.scrollTop
  }

  move(pos: number): void {
    this.pos = pos
    this.layout()
    if (!this.raf) this.raf = requestAnimationFrame(() => this.tick())
  }

  private tick(): void {
    this.raf = 0
    const b = this.o.scroller.getBoundingClientRect()
    const [lo, hi] = this.o.axis === 'x' ? [b.left, b.right] : [b.top, b.bottom]
    const d = edgeScroll(this.pos, lo, hi)
    if (d === 0) return
    const before = this.scrollPos()
    if (this.o.axis === 'x') this.o.scroller.scrollLeft += d
    else this.o.scroller.scrollTop += d
    if (this.scrollPos() !== before) this.layout()
    this.raf = requestAnimationFrame(() => this.tick())
  }

  private layout(): void {
    const { axis, items, from } = this.o
    const scrolled = this.scrollPos() - this.scroll0
    const delta = this.pos - this.o.start + scrolled
    this.to = dropIndex(this.mids, from, this.mids[from]! + delta)
    const t = (px: number) => (px === 0 ? '' : axis === 'x' ? `translateX(${px}px)` : `translateY(${px}px)`)
    items.forEach((el, i) => {
      if (i === from) el.style.transform = t(delta)
      else if (from < i && i <= this.to) el.style.transform = t(-this.size)
      else if (this.to <= i && i < from) el.style.transform = t(this.size)
      else el.style.transform = ''
    })
  }

  /** 松手（或取消）：清掉位移；位置变了返回 `{sid, before}`（给 session.move），否则 null。 */
  finish(cancel = false): { sid: number; before: number | null } | null {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    for (const el of this.o.items) el.style.transform = ''
    delete this.o.items[this.o.from]!.dataset.dragging
    delete this.o.scroller.dataset.reordering
    const { order, from } = this.o
    if (cancel || this.to === from) return null
    return { sid: order[from]!, before: beforeAt(order, from, this.to) }
  }
}
