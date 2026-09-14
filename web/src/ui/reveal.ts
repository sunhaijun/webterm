/**
 * 把选中的会话滚进可视区（AC-4.9）。
 *
 * 会话上限 20，侧栏放不下这么多行，而 `Ctrl+Shift+↑/↓`、横滑、关掉当前会话后
 * 自动切到相邻会话这三条路都可能把选中项换成视区外的一行 —— 指针不在列表上，
 * 用户唯一的反馈就是"列表里没有高亮"。
 */

/** 最近的可滚动祖先（桌面是 `.sidebar`，浮层里是抽屉的滚动区）。 */
export function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY
    if (oy === 'auto' || oy === 'scroll') return p
  }
  return null
}

export function revealActive(item: HTMLElement | null | undefined): void {
  if (!item || typeof item.scrollIntoView !== 'function') return
  const box = scrollParent(item)
  if (box) {
    const r = item.getBoundingClientRect()
    const c = box.getBoundingClientRect()
    // 整条已经看得见就什么都不做 —— 每次切会话都滚一下会抖
    if (r.top >= c.top && r.bottom <= c.bottom) return
  }
  // 【不用 smooth】：它和列表自身的滚动打架，也不尊重 reduced-motion
  item.scrollIntoView({ block: 'nearest' })
}
