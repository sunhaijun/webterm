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
 * 布局视口高度 —— 判断"键盘是否占屏"的参照。
 *
 * 【不能用 window.innerHeight】：Safari（iOS）的 innerHeight 报的是【可视视口】高度
 * （随捏合缩放、随软键盘一起变矮），Chrome 的才是布局视口。拿 innerHeight 做参照，
 * 在 iPhone 上键盘一弹它也跟着矮下去，"可视比布局矮一大截"永远不成立 → 不补偿 →
 * Safari 把可视区上推去露输入框，整个 .app 却留在布局顶部、被推出可视区
 * （表现："一点输入，输入框就没影了"）。documentElement.clientHeight 在所有浏览器
 * 里都是布局视口高度，不随键盘 / 缩放变。
 */
export function layoutViewportHeight(): number {
  return document.documentElement.clientHeight || window.innerHeight
}

/** 键盘占屏的最小高度：地址栏滑入滑出（≈50–100px 但布局视口同步变）、回弹都到不了。 */
export const KEYBOARD_MIN_PX = 80

/**
 * 键盘是否弹起 = 可视视口比布局视口矮一大截。只有这时才追 offsetTop 做 translateY 补偿；
 * 普通滚动 / 回弹（offsetTop 动、高度不动）一律不追 —— 否则拖一下抖一会儿（见 app.tsx）。
 */
export function isKeyboardUp(visualHeight: number, layoutHeight: number): boolean {
  return visualHeight < layoutHeight - KEYBOARD_MIN_PX
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
