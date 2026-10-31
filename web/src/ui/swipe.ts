/**
 * 底部 sheet 的下滑关闭（原生手势）。
 *
 * 贴到 sheet 容器上。规则：手指从内部滚动区【已经到顶】时再往下拉，才当成关闭手势
 * （否则会和列表滚动打架）；拉过阈值松手即关，没到就弹回。只在触屏生效。
 */
export interface SwipeDismissOptions {
  /** 拉过这么多像素松手就关。 */
  threshold?: number
  /** 找内部滚动区：返回它的 scrollTop，用来判断「是否已到顶」。默认找 Drawer 的 .drawer-body。 */
  scroller?: (host: HTMLElement) => HTMLElement | null
  /** 此刻接不接这个手势（居中浮窗不接，ADR-0037 §4）。默认一直接。 */
  enabled?: () => boolean
}

export function installSwipeDismiss(host: HTMLElement, onDismiss: () => void, opts: SwipeDismissOptions = {}): () => void {
  const threshold = opts.threshold ?? 90
  const findScroller = opts.scroller ?? ((h) => h.querySelector<HTMLElement>('.drawer-body'))
  let startY = 0
  let dy = 0
  let dragging = false

  const atTop = () => {
    const sc = findScroller(host)
    return !sc || sc.scrollTop <= 0
  }
  const onStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) return
    startY = e.touches[0]!.clientY
    dy = 0
    dragging = (opts.enabled?.() ?? true) && atTop()
  }
  const onMove = (e: TouchEvent) => {
    if (!dragging || e.touches.length !== 1) return
    dy = e.touches[0]!.clientY - startY
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
