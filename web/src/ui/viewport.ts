/**
 * 软键盘适配 —— docs/40-frontend/layout-responsive.md §高度计算。
 *
 * 【高度的唯一真相来源是 visualViewport】，不是 100vh：iOS Safari 上
 * 100vh 不随键盘变化，用它算出来的布局会被键盘盖住。
 */

export interface ViewportState {
  height: number
  /** iOS 键盘弹出时会把整个页面向上"推"，要用 transform 抵消。 */
  offsetTop: number
}

export function readViewport(): ViewportState {
  const vv = window.visualViewport
  if (!vv) return { height: window.innerHeight, offsetTop: 0 }
  return { height: vv.height, offsetTop: vv.offsetTop }
}

/**
 * 订阅 visualViewport 变化。
 *
 * 【不要在这个回调里直接调 fit()】—— 布局还没稳定，会算出错误的行列数。
 * 必须让 ResizeObserver 观察终端容器，由它触发（layout-responsive.md）。
 */
export function watchViewport(onChange: (s: ViewportState) => void): () => void {
  const vv = window.visualViewport
  const fire = () => onChange(readViewport())
  if (!vv) {
    window.addEventListener('resize', fire)
    return () => window.removeEventListener('resize', fire)
  }
  vv.addEventListener('resize', fire)
  vv.addEventListener('scroll', fire)
  return () => {
    vv.removeEventListener('resize', fire)
    vv.removeEventListener('scroll', fire)
  }
}

/** 防抖 —— resize 控制消息要 100ms 防抖（AC-3.11）。 */
export function debounce<T extends unknown[]>(
  fn: (...args: T) => void,
  ms: number,
): ((...args: T) => void) & { cancel(): void } {
  let h: ReturnType<typeof setTimeout> | undefined
  const wrapped = (...args: T) => {
    if (h !== undefined) clearTimeout(h)
    h = setTimeout(() => {
      h = undefined
      fn(...args)
    }, ms)
  }
  wrapped.cancel = () => {
    if (h !== undefined) clearTimeout(h)
    h = undefined
  }
  return wrapped
}

/** 断点 —— 只依据视口宽度，不做 UA 嗅探。 */
export type Breakpoint = 'phone' | 'tablet' | 'desktop'

export function breakpoint(width: number): Breakpoint {
  if (width < 640) return 'phone'
  if (width < 1024) return 'tablet'
  return 'desktop'
}

/** 高度受限（主要针对手机横屏），叠加规则。 */
export function isShort(height: number): boolean {
  return height < 480
}

/** 触摸设备才显示功能键条；接了外接键盘的平板就不显示。 */
export function isCoarsePointer(): boolean {
  return window.matchMedia?.('(pointer: coarse)').matches ?? false
}
