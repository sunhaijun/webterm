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

export interface SignOutConfirmProps {
  onOk(): void
  onCancel(): void
}

/** Sign-out confirmation (AC-1.22, ADR-0048): same sheet as closing a session. */
export function SignOutConfirm(p: SignOutConfirmProps) {
  const okRef = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => okRef.current?.focus({ preventScroll: true }), [])
  return (
    <Drawer
      title="Sign out this device?"
      testid="sign-out-confirm"
      backdropTestid="sign-out-confirm-backdrop"
      variant="confirm"
      onClose={p.onCancel}
      foot={
        <div class="drawer-actions">
          <button type="button" class="drawer-btn" data-testid="sign-out-cancel" onClick={p.onCancel}>
            Cancel
          </button>
          <button type="button" class="drawer-btn danger" data-testid="sign-out-ok" ref={okRef} onClick={p.onOk}>
            Sign out
          </button>
        </div>
      }
    >
      <p class="confirm-text">Sessions keep running. Using this device again takes a new pairing code.</p>
    </Drawer>
  )
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
