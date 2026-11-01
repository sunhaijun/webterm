/**
 * Swipe down to close a bottom sheet (native-style gesture).
 *
 * Attach to the sheet container. A downward pull counts as a close gesture only when the
 * inner scroll area is already at the top (otherwise it fights list scrolling). Releasing
 * past the threshold closes; anything less snaps back. Touch only.
 * `enabled`: whether to take the gesture right now (centered dialogs don't, ADR-0037 §4).
 */
export function installSwipeDismiss(host: HTMLElement, onDismiss: () => void, enabled: () => boolean): () => void {
  /** Releasing after pulling this many px closes the sheet. */
  const threshold = 90
  let startX = 0
  let startY = 0
  let dy = 0
  let dragging = false
  /** Whether direction has been decided; if mostly horizontal (row swipe, ADR-0039), ignore the whole gesture. */
  let decided = false

  /** Whether the inner scroll area (the Drawer body) is at the top. */
  const atTop = () => (host.querySelector<HTMLElement>('.drawer-body')?.scrollTop ?? 0) <= 0
  const onStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) return
    startX = e.touches[0]!.clientX
    startY = e.touches[0]!.clientY
    dy = 0
    decided = false
    // A press on the drag handle reorders; it doesn't close the sheet (ADR-0040)
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
      // Moving up: leave it to list scrolling
      dragging = false
      host.style.transform = ''
      host.style.transition = ''
      return
    }
    // Pulling down: don't take over if the content is no longer at the top (the user scrolled first)
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
