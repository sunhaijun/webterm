/**
 * Close confirmation (AC-4.11, ADR-0038), instead of the browser's `confirm()`. Same
 * shapes as settings: a bottom sheet on `compact`, a centered dialog on `wide`; it can
 * stack on top of the session drawer.
 *
 * Focus starts on Close, so `Enter` confirms and `Esc` cancels, just like `confirm()`.
 */
import { useLayoutEffect, useRef } from 'preact/hooks'

import { Drawer } from '../ui/drawer'

export interface CloseConfirmProps {
  name: string
  onOk(): void
  onCancel(): void
}

export function CloseConfirm(p: CloseConfirmProps) {
  const okRef = useRef<HTMLButtonElement>(null)
  // Drawer's own layout effect runs first (children before parents) and pulls focus into the sheet; then move it to Close
  useLayoutEffect(() => okRef.current?.focus({ preventScroll: true }), [])
  return (
    <Drawer
      title={`Close "${p.name}"?`}
      testid="close-confirm"
      backdropTestid="close-confirm-backdrop"
      variant="confirm"
      onClose={p.onCancel}
      foot={
        <div class="drawer-actions">
          <button type="button" class="drawer-btn" data-testid="close-cancel" onClick={p.onCancel}>
            Cancel
          </button>
          <button type="button" class="drawer-btn danger" data-testid="close-ok" ref={okRef} onClick={p.onOk}>
            Close
          </button>
        </div>
      }
    >
      <p class="confirm-text">Programs running in it will be terminated.</p>
    </Drawer>
  )
}
