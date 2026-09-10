/**
 * 双指缩放读（ADR-0013）。
 *
 * 终端固定 43 列。读方案文 / 长输出时想凑近看，这里给终端一个【纯视觉】的双指放大：
 * 只对 `.xterm-screen` 施加 CSS transform（scale + translate），**不动 PTY 尺寸**
 * （不 fit、不发 resize），所以放大只是把当前屏看得更清，程序的折行位置不变。
 *
 * 放大【锚在双指中点】：手指按住哪儿就放大哪儿，捏合时那一点不跑；放大后单指可平移；
 * 双击在点下处放大到 2×，再双击复位；缩回 1× 也复位。隐藏 textarea 不在变换内，打字照常。
 */

/** 缩放上下限。1× = 原样；3× 已经很大了。 */
export const MIN_SCALE = 1
export const MAX_SCALE = 3
/** 双击放大到的倍数。 */
export const TAP_SCALE = 2

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

/**
 * 锚定平移：手势开始时锚点（屏内坐标）`startMid` 下压着的那个内容点，缩放到 `scale`
 * 后仍要压在当前锚点 `mid` 下。transform-origin 在左上角，屏坐标 = 内容坐标 * scale + t。
 * 手势起点：`startMid` 下的内容点 p0 = (startMid − startT) / startScale；要 p0*scale + t = mid，
 * 于是 t = mid − p0*scale。`mid` 随双指中点漂移 → 顺带实现了「捏着拖」。
 */
export function anchorTranslate(mid: number, startMid: number, startT: number, startScale: number, scale: number): number {
  const p0 = (startMid - startT) / startScale
  return mid - p0 * scale
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
  let startMidX = 0
  let startMidY = 0
  // 单指平移
  let panX = 0
  let panY = 0
  let lastTap = 0

  const screen = () => host.querySelector<HTMLElement>('.xterm-screen')
  // 屏内（相对 host 左上角）坐标
  const localX = (clientX: number) => clientX - host.getBoundingClientRect().left
  const localY = (clientY: number) => clientY - host.getBoundingClientRect().top

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
    tx = clampPan(tx, scale, host.clientWidth)
    ty = clampPan(ty, scale, host.clientHeight)
    el.style.transformOrigin = '0 0'
    el.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`
    host.setAttribute('data-zoom', scale.toFixed(2))
  }

  const beginPinch = (a: Touch, b: Touch) => {
    startDist = dist(a.clientX, a.clientY, b.clientX, b.clientY)
    startScale = scale
    startTx = tx
    startTy = ty
    startMidX = localX((a.clientX + b.clientX) / 2)
    startMidY = localY((a.clientY + b.clientY) / 2)
  }

  const onStart = (e: TouchEvent) => {
    if (e.touches.length === 2) {
      beginPinch(e.touches[0]!, e.touches[1]!)
      e.preventDefault()
    } else if (e.touches.length === 1) {
      const now = Date.now()
      const t = e.touches[0]!
      if (now - lastTap < 300) {
        // 双击：1× → 在点下处放大到 2×；已放大 → 复位
        if (scale > 1) reset()
        else zoomAt(localX(t.clientX), localY(t.clientY), TAP_SCALE)
        lastTap = 0
        return
      }
      lastTap = now
      if (scale > 1) {
        panX = t.clientX
        panY = t.clientY
      }
    }
  }

  const onMove = (e: TouchEvent) => {
    if (e.touches.length === 2 && startDist > 0) {
      const [a, b] = [e.touches[0]!, e.touches[1]!]
      scale = clampScale(startScale * (dist(a.clientX, a.clientY, b.clientX, b.clientY) / startDist))
      // 锚点：当前双指中点；把手势起点锚下的内容点保持在它下面（并随中点漂移平移）
      const midX = localX((a.clientX + b.clientX) / 2)
      const midY = localY((a.clientY + b.clientY) / 2)
      tx = anchorTranslate(midX, startMidX, startTx, startScale, scale)
      ty = anchorTranslate(midY, startMidY, startTy, startScale, scale)
      apply()
      e.preventDefault()
    } else if (e.touches.length === 1 && scale > 1) {
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

  function zoomAt(mx: number, my: number, to: number) {
    // 从当前状态放大到 to，保持 (mx,my) 下的内容点不动
    tx = anchorTranslate(mx, mx, tx, scale, to)
    ty = anchorTranslate(my, my, ty, scale, to)
    scale = clampScale(to)
    apply()
  }

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
