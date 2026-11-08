/**
 * The restore button of collapsed extra keys (input.md §Collapsing the extra keys, ADR-0056
 * §3): bottom-right, translucent until pressed. A tap restores the bar; so does dragging the
 * button to the left, the bar sliding in with the finger. It carries the waiting-for-you dot,
 * since the session button is hidden with the bar.
 */
import { useRef } from 'preact/hooks'

import { TAP_PX, isRestoreSwipe } from '../keys/collapse'
import { KeyboardIcon } from '../ui/icons'
import { capturePointer } from '../ui/pointer'

export function KeysRestore(p: { attention: boolean; onRestore(): void; onPreview(dx: number | null): void }) {
  const drag = useRef<{ x: number; y: number; maxMove: number } | null>(null)
  const down = (e: PointerEvent) => {
    e.preventDefault() // keep focus where it is
    capturePointer(e.currentTarget as Element, e.pointerId)
    ;(e.currentTarget as HTMLElement).dataset.pressed = 'true'
    drag.current = { x: e.clientX, y: e.clientY, maxMove: 0 }
  }
  const move = (e: PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    d.maxMove = Math.max(d.maxMove, Math.hypot(dx, dy))
    if (d.maxMove > TAP_PX) p.onPreview(dx < 0 && Math.abs(dx) > Math.abs(dy) ? dx : null)
  }
  const up = (e: PointerEvent) => {
    const d = drag.current
    drag.current = null
    delete (e.currentTarget as HTMLElement).dataset.pressed
    if (!d) return
    p.onPreview(null)
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (Math.max(d.maxMove, Math.hypot(dx, dy)) <= TAP_PX || isRestoreSwipe(dx, dy)) p.onRestore()
  }
  const cancel = (e: PointerEvent) => {
    drag.current = null
    delete (e.currentTarget as HTMLElement).dataset.pressed
    p.onPreview(null)
  }
  return (
    <button
      type="button"
      class="keys-restore"
      data-testid="keys-restore"
      data-attention={p.attention ? 'true' : 'false'}
      aria-label={p.attention ? 'Show the extra keys (a session is waiting for you)' : 'Show the extra keys'}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={cancel}
    >
      <KeyboardIcon />
    </button>
  )
}
