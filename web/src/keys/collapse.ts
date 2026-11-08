/**
 * Gestures on the extra keys and collapsing them (input.md §Collapsing the extra keys,
 * ADR-0056). Pure decisions; the component and the controller do the DOM.
 */
import type { KeyPage } from './textpage'

/** A control acts only when the finger moved no more than this (the terminal's tap rule). */
export const TAP_PX = 10
/** A swipe needs more travel than this, mostly in one direction. */
export const SWIPE_PX = 40
/** Restore swipes can't start this close to a screen edge: the system owns edge swipes. */
export const EDGE_PX = 24
/** The band at the bottom of the terminal where a collapsed bar can be swiped back. */
export const BAND_PX = 80

export type KeyGesture = 'tap' | 'collapse' | 'toText' | 'toKeys' | 'none'

/**
 * What a release on the extra keys means. dx / dy is the travel from press to release,
 * maxMove the farthest the finger got from where it went down; textAtTop says whether the
 * text box was scrolled to its top when the touch began.
 */
export function keyGesture(dx: number, dy: number, maxMove: number, page: KeyPage, textAtTop: boolean): KeyGesture {
  if (maxMove <= TAP_PX) return 'tap'
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (ax > SWIPE_PX && ax > ay) return dx > 0 ? 'collapse' : 'none'
  if (ay > SWIPE_PX && ay > ax) {
    if (dy < 0 && page === 'keys') return 'toText'
    if (dy > 0 && page === 'text' && textAtTop) return 'toKeys'
  }
  return 'none'
}

/** Whether a touch at (x, y) may start a restore swipe: in the bottom band, away from the edges. */
export function canStartRestore(x: number, y: number, areaBottom: number, viewportWidth: number): boolean {
  return y >= areaBottom - BAND_PX && y <= areaBottom && x >= EDGE_PX && x <= viewportWidth - EDGE_PX
}

/** Whether a drag from the restore band or the restore button brings the bar back. */
export function isRestoreSwipe(dx: number, dy: number): boolean {
  return dx < -SWIPE_PX && Math.abs(dx) > Math.abs(dy)
}

/**
 * Moves the bar with the finger, without relayout (ADR-0021): expanded, it slides right by
 * dx; collapsed (positioned off to the right), it slides in by -dx. null puts it back.
 */
export function previewBar(bar: HTMLElement | null, collapsed: boolean, dx: number | null): void {
  if (!bar) return
  if (dx === null) {
    bar.style.transform = ''
    bar.style.visibility = ''
    return
  }
  if (collapsed) {
    bar.style.visibility = 'visible'
    bar.style.transform = `translateX(calc(100% + ${Math.min(0, dx)}px))`
  } else {
    bar.style.transform = `translateX(${Math.max(0, dx)}px)`
  }
}
