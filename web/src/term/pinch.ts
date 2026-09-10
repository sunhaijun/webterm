/**
 * 双指缩放读（ADR-0013）。
 *
 * 终端固定 43 列，长回答里代码会折行。这里给终端一个【纯视觉】的双指放大：
 * 只对 `.xterm-screen` 施加 CSS transform（scale + translate），**不动 PTY 尺寸**
 * （不 fit、不发 resize），所以放大只是把当前屏看得更清，程序的折行位置不变。
 * 放大后单指可平移；缩回 1× 或双击复位。输入用的隐藏 textarea 不在变换内，打字照常。
 */

/** 缩放上下限。1× = 原样；3× 已经很大了。 */
export const MIN_SCALE = 1
export const MAX_SCALE = 3

export function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))
}

/** 两点距离。 */
export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by)
}

/**
 * 平移量夹紧：放大 scale 倍后，内容比容器大 (scale-1)*size，平移不能把内容拖出边。
 * 返回夹紧到 [-(scale-1)*size, 0] 的值（transform-origin 在左上角）。
 */
export function clampPan(t: number, scale: number, size: number): number {
  const min = -(scale - 1) * size
  const r = Math.min(0, Math.max(min, t))
  return r === 0 ? 0 : r // 规避 -0
}

export interface Pinch {
  scale(): number
  reset(): void
  dispose(): void
}

/** 给 `.term` 容器装上双指缩放。host 是 `.term`（xterm 挂在它里面）。 */
export function installPinch(host: HTMLElement): Pinch {
  let scale = 1
  let tx = 0
  let ty = 0
  // 手势起点
  let startDist = 0
  let startScale = 1
  let startTx = 0
  let startTy = 0
  let panX = 0
  let panY = 0
  let lastTap = 0

  const screen = () => host.querySelector<HTMLElement>('.xterm-screen')
  const apply = () => {
    const el = screen()
    if (!el) return
    if (scale <= 1.001) {
      scale = 1
      tx = 0
      ty = 0
      el.style.transform = ''
      el.style.transformOrigin = ''
      host.removeAttribute('data-zoom')
      return
    }
    const w = host.clientWidth
    const h = host.clientHeight
    tx = clampPan(tx, scale, w)
    ty = clampPan(ty, scale, h)
    el.style.transformOrigin = '0 0'
    el.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`
    host.setAttribute('data-zoom', scale.toFixed(2))
  }

  const onStart = (e: TouchEvent) => {
    if (e.touches.length === 2) {
      const [a, b] = [e.touches[0]!, e.touches[1]!]
      startDist = dist(a.clientX, a.clientY, b.clientX, b.clientY)
      startScale = scale
      startTx = tx
      startTy = ty
      e.preventDefault()
    } else if (e.touches.length === 1) {
      // 双击复位
      const now = Date.now()
      if (now - lastTap < 300 && scale > 1) reset()
      lastTap = now
      if (scale > 1) {
        panX = e.touches[0]!.clientX
        panY = e.touches[0]!.clientY
      }
    }
  }
  const onMove = (e: TouchEvent) => {
    if (e.touches.length === 2 && startDist > 0) {
      const [a, b] = [e.touches[0]!, e.touches[1]!]
      scale = clampScale(startScale * (dist(a.clientX, a.clientY, b.clientX, b.clientY) / startDist))
      // 保持双指中点大致不动：按新旧缩放差调整平移
      tx = startTx
      ty = startTy
      apply()
      e.preventDefault()
    } else if (e.touches.length === 1 && scale > 1) {
      // 放大后单指平移；拦住 xterm 自己的滚动
      const t = e.touches[0]!
      tx += t.clientX - panX
      ty += t.clientY - panY
      panX = t.clientX
      panY = t.clientY
      apply()
      e.preventDefault()
    }
  }
  const onEnd = () => {
    startDist = 0
    apply()
  }

  host.addEventListener('touchstart', onStart, { passive: false })
  host.addEventListener('touchmove', onMove, { passive: false })
  host.addEventListener('touchend', onEnd)
  host.addEventListener('touchcancel', onEnd)

  function reset() {
    scale = 1
    tx = 0
    ty = 0
    apply()
  }

  return {
    scale: () => scale,
    reset,
    dispose() {
      host.removeEventListener('touchstart', onStart)
      host.removeEventListener('touchmove', onMove)
      host.removeEventListener('touchend', onEnd)
      host.removeEventListener('touchcancel', onEnd)
      reset()
    },
  }
}
