/**
 * 手机抽屉一行的左滑（AC-4.12，ADR-0039）：纯状态机，组件只负责把 offset 写到 transform 上。
 */

/** 三个按钮的总宽（各 72px）。 */
export const ROW_ACTIONS_PX = 216
/** 横向位移超过这么多、且横向占优，才算左滑（否则是点、长按或纵向滚动）。 */
export const ROW_SWIPE_SLOP_PX = 10

export class RowSwipe {
  private x0 = 0
  private y0 = 0
  private base = 0
  private offset = 0
  /** null = 还没判方向；true = 横向，接管了；false = 纵向，不管了。 */
  private horizontal: boolean | null = null

  /** 按下。`open`：这一行此刻是不是开着。 */
  start(x: number, y: number, open: boolean): void {
    this.x0 = x
    this.y0 = y
    this.base = open ? -ROW_ACTIONS_PX : 0
    this.offset = this.base
    this.horizontal = null
  }

  /** 移动：接管了就返回此刻的位移（0 到 −216），否则 null。 */
  move(x: number, y: number): number | null {
    const dx = x - this.x0
    const dy = y - this.y0
    if (this.horizontal === null) {
      if (Math.abs(dx) <= ROW_SWIPE_SLOP_PX && Math.abs(dy) <= ROW_SWIPE_SLOP_PX) return null
      this.horizontal = Math.abs(dx) > Math.abs(dy)
    }
    if (!this.horizontal) return null
    this.offset = Math.max(-ROW_ACTIONS_PX, Math.min(0, this.base + dx))
    return this.offset
  }

  /** 是否接管了这次手势（接管了，抬手后的 click 要吞掉）。 */
  get tracking(): boolean {
    return this.horizontal === true
  }

  /** 抬手：接管过就返回停在开还是关（过半算开），没接管返回 null。 */
  end(): 'open' | 'closed' | null {
    const took = this.horizontal === true
    this.horizontal = null
    if (!took) return null
    return this.offset < -ROW_ACTIONS_PX / 2 ? 'open' : 'closed'
  }
}
