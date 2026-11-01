/** Captures the pointer so later move / up events go to this element. Throws for synthetic events with no active pointer; failing is harmless. */
export function capturePointer(el: Element, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId)
  } catch {
    /* Synthetic event without an active pointer */
  }
}
