/**
 * On-screen keyboard and the visual viewport (docs/40-frontend/layout.md, AC-3.8).
 *
 * visualViewport is the only source of truth for height, not 100vh: on iOS Safari 100vh
 * ignores the keyboard, so a layout based on it ends up under the keyboard.
 */

export interface ViewportState {
  height: number
  /** iOS pushes the visual viewport up when the keyboard opens; follow it with translateY. */
  offsetTop: number
}

export function readViewport(): ViewportState {
  const vv = window.visualViewport
  if (!vv) return { height: window.innerHeight, offsetTop: 0 }
  return { height: vv.height, offsetTop: vv.offsetTop }
}

/**
 * Layout viewport height, the reference for "is the keyboard taking up the screen".
 *
 * Not window.innerHeight: Safari reports the visual viewport height there (it shrinks
 * with pinch zoom and with the keyboard). Using it as the reference, the gate on iPhone
 * never opens when the keyboard appears, nothing is compensated, and the whole .app is
 * pushed out of view. documentElement.clientHeight is the layout viewport height in every
 * browser.
 */
export function layoutViewportHeight(): number {
  return document.documentElement.clientHeight || window.innerHeight
}

/** Minimum keyboard height. Address bar slide-in/out (the layout viewport changes with it) and overscroll bounce never reach it. */
export const KEYBOARD_MIN_PX = 80

/** The keyboard is up when the visual viewport is much shorter than the layout viewport. */
export function isKeyboardUp(visualHeight: number, layoutHeight: number): boolean {
  return visualHeight < layoutHeight - KEYBOARD_MIN_PX
}

/** What to apply to `.app`: height, upward shift, and whether to zero the bottom safe-area inset. */
export interface AppFit {
  height: number
  translateY: number
  keyboardUp: boolean
}

/**
 * The gate looks at just two numbers (layout.md, translateY compensation with the
 * keyboard up): follow `offsetTop` only while the keyboard is up. Address bar slides and
 * edge bounce (offsetTop changes, height doesn't) are ignored, or every drag would jitter.
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
 * Makes `.app` track the visual viewport: height = visualViewport.height; with the keyboard
 * up, translateY(offsetTop) and `--sa-bottom` set to 0 (the keyboard already covers the
 * home indicator). Coalesced with rAF to at most one write per frame.
 *
 * No fit() here; layout hasn't settled yet. The ResizeObserver on the terminal container
 * recomputes rows and columns.
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

/** Debounce; resize control messages are debounced by 100ms (AC-3.11). */
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

/** Touch capability. Orthogonal to form factor: it only decides whether wide shows extra keys and which sheet shape to use. */
export function isCoarsePointer(): boolean {
  return window.matchMedia?.(COARSE).matches ?? false
}

/** Touch capability changed (a mouse plugged into or out of a tablet). */
export function watchCoarse(fn: (coarse: boolean) => void): () => void {
  const mq = window.matchMedia?.(COARSE)
  if (!mq) return () => {}
  const on = () => fn(mq.matches)
  mq.addEventListener('change', on)
  return () => mq.removeEventListener('change', on)
}

// ---------- Small geometry helpers ----------

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * Whether the selected item must be scrolled into view (AC-4.9). If fully visible, do
 * nothing; otherwise the caller uses `scrollIntoView({ block: 'nearest', inline: 'nearest' })`,
 * without smooth scrolling.
 */
export function needsReveal(item: Box, view: Box): boolean {
  return item.left < view.left || item.right > view.right || item.top < view.top || item.bottom > view.bottom
}

/** A small menu anchored at the trigger point: below-right of it if it fits, pulled back otherwise, always 8px from the edges. */
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
