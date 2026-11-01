/**
 * 底部 sheet 的下滑关闭（原生手势）。
 *
 * 贴到 sheet 容器上。规则：手指从内部滚动区【已经到顶】时再往下拉，才当成关闭手势
 * （否则会和列表滚动打架）；拉过阈值松手即关，没到就弹回。只在触屏生效。
 * `enabled`：此刻接不接这个手势（居中浮窗不接，ADR-0037 §4）。
 */
export function installSwipeDismiss(host: HTMLElement, onDismiss: () => void, enabled: () => boolean): () => void {
  /** 拉过这么多像素松手就关。 */
  const threshold = 90
  let startX = 0
  let startY = 0
  let dy = 0
  let dragging = false
  /** 方向判定过没有：横向占优（左滑一行，ADR-0039）就整次不接管。 */
  let decided = false

  /** 内部滚动区（Drawer 的正文）到顶了没有。 */
  const atTop = () => (host.querySelector<HTMLElement>('.drawer-body')?.scrollTop ?? 0) <= 0
  const onStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) return
    startX = e.touches[0]!.clientX
    startY = e.touches[0]!.clientY
    dy = 0
    decided = false
    // 拖动柄上的按下是排序，不是关 sheet（ADR-0040）
    dragging = enabled() && atTop() && !(e.target as Element).closest?.('.row-grip')
  }
  const onMove = (e: TouchEvent) => {
    if (!dragging || e.touches.length !== 1) return
    dy = e.touches[0]!.clientY - startY
    if (!decided) {
      const dx = e.touches[0]!.clientX - startX
      if (Math.abs(dx) + Math.abs(dy) < 6) return
      decided = true
      if (Math.abs(dx) > Math.abs(dy)) {
        dragging = false
        return
      }
    }
    if (dy <= 0) {
      // 往上了：交还给列表滚动
      dragging = false
      host.style.transform = ''
      host.style.transition = ''
      return
    }
    // 下拉：如果这时内部已经不在顶（用户先滚了再拉）就不接管
    if (!atTop()) {
      dragging = false
      host.style.transform = ''
      return
    }
    host.style.transition = 'none'
    host.style.transform = `translateY(${dy}px)`
    e.preventDefault()
  }
  const onEnd = () => {
    if (!dragging) return
    dragging = false
    host.style.transition = 'transform 160ms ease'
    if (dy > threshold) {
      host.style.transform = `translateY(100%)`
      setTimeout(onDismiss, 140)
    } else {
      host.style.transform = ''
    }
  }

  host.addEventListener('touchstart', onStart, { passive: true })
  host.addEventListener('touchmove', onMove, { passive: false })
  host.addEventListener('touchend', onEnd)
  host.addEventListener('touchcancel', onEnd)
  return () => {
    host.removeEventListener('touchstart', onStart)
    host.removeEventListener('touchmove', onMove)
    host.removeEventListener('touchend', onEnd)
    host.removeEventListener('touchcancel', onEnd)
  }
}
