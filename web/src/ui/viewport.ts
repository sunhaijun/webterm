/**
 * 软键盘与可视视口 —— docs/40-frontend/layout.md §高度计算（AC-3.8）。
 *
 * 【高度的唯一真相来源是 visualViewport】，不是 100vh：iOS Safari 上
 * 100vh 不随键盘变化，用它算出来的布局会被键盘盖住。
 */

export interface ViewportState {
  height: number
  /** iOS 键盘弹出时会把可视区上推，要用 translateY 跟过去。 */
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
 * 【不能用 window.innerHeight】：Safari 的 innerHeight 报的是可视视口高度（随捏合缩放、
 * 随软键盘一起变矮），拿它当参照，iPhone 上键盘一弹闸门就永远关着 → 不补偿 →
 * 整个 .app 被推出可视区。documentElement.clientHeight 在所有浏览器里都是布局视口高度。
 */
export function layoutViewportHeight(): number {
  return document.documentElement.clientHeight || window.innerHeight
}

/** 键盘占屏的最小高度：地址栏滑入滑出（布局视口同步变）、回弹都到不了。 */
export const KEYBOARD_MIN_PX = 80

/** 键盘弹起 = 可视视口比布局视口矮一大截。 */
export function isKeyboardUp(visualHeight: number, layoutHeight: number): boolean {
  return visualHeight < layoutHeight - KEYBOARD_MIN_PX
}

/** `.app` 该写成什么样：高度、上推量、safe-area 下边距要不要归零。 */
export interface AppFit {
  height: number
  translateY: number
  keyboardUp: boolean
}

/**
 * 闸门只看两个数（layout.md §键盘弹起时的 translateY 补偿）：键盘弹起才追 `offsetTop`；
 * 地址栏滑入滑出、边缘回弹（offsetTop 变而高度不变）一律不追 —— 否则拖一下抖一会儿。
 */
export function appFit(vp: ViewportState, layoutHeight: number): AppFit {
  const keyboardUp = isKeyboardUp(vp.height, layoutHeight)
  return {
    height: Math.round(vp.height),
    translateY: keyboardUp ? Math.round(vp.offsetTop) : 0,
    keyboardUp,
  }
}

/**
 * 让 `.app` 跟着可视视口走：高度 = visualViewport.height；键盘弹起时 translateY(offsetTop)
 * 并把 `--sa-bottom` 置 0（键盘已经盖住 Home 指示条）。rAF 合帧，一帧最多写一次。
 *
 * 【不在这里 fit()】—— 布局还没稳定。终端容器上的 ResizeObserver 负责重算行列。
 */
export function installAppFit(root: HTMLElement): () => void {
  let raf = 0
  let last: AppFit | null = null
  const apply = () => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      const next = appFit(readViewport(), layoutViewportHeight())
      if (last?.height !== next.height) root.style.height = `${next.height}px`
      if (last?.translateY !== next.translateY) {
        root.style.transform = next.translateY ? `translateY(${next.translateY}px)` : ''
      }
      if (last?.keyboardUp !== next.keyboardUp) {
        if (next.keyboardUp) root.style.setProperty('--sa-bottom', '0px')
        else root.style.removeProperty('--sa-bottom')
      }
      last = next
    })
  }
  apply()
  const vv = window.visualViewport
  vv?.addEventListener('resize', apply)
  vv?.addEventListener('scroll', apply)
  window.addEventListener('resize', apply)
  return () => {
    vv?.removeEventListener('resize', apply)
    vv?.removeEventListener('scroll', apply)
    window.removeEventListener('resize', apply)
    if (raf) cancelAnimationFrame(raf)
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

const COARSE = '(pointer: coarse)'

/** 触摸能力。与形态正交：只决定 wide 上显不显示附加键、浮层是什么形态。 */
export function isCoarsePointer(): boolean {
  return window.matchMedia?.(COARSE).matches ?? false
}

/** 触摸能力变了（给 Pad 接上 / 拔掉鼠标）。 */
export function watchCoarse(fn: (coarse: boolean) => void): () => void {
  const mq = window.matchMedia?.(COARSE)
  if (!mq) return () => {}
  const on = () => fn(mq.matches)
  mq.addEventListener('change', on)
  return () => mq.removeEventListener('change', on)
}

// ---------- 小块几何 ----------

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * 选中项要不要滚进视野（AC-4.9）：已经整个可见就什么都不做；否则调用方
 * `scrollIntoView({ block: 'nearest', inline: 'nearest' })`，不用 smooth。
 */
export function needsReveal(item: Box, view: Box): boolean {
  return item.left < view.left || item.right > view.right || item.top < view.top || item.bottom > view.bottom
}

/** 锚在触发点旁边的小菜单：放得下就放在触发点右下，放不下就往回收，总留 8px 边。 */
export function menuPosition(
  x: number,
  y: number,
  menu: { width: number; height: number },
  vw: number,
  vh: number,
): { left: number; top: number } {
  const m = 8
  return {
    left: Math.max(m, Math.min(x, vw - menu.width - m)),
    top: Math.max(m, Math.min(y, vh - menu.height - m)),
  }
}
