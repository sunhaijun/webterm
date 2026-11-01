/**
 * Device form factor (AC-5.18, ADR-0025 §1, layout.md).
 *
 * Decided by the screen's short side, not the viewport. Screen size doesn't change with
 * the on-screen keyboard, rotation, the address bar or split screen, so a device never
 * flips form factor and never reflows the terminal or sends SIGWINCH because of it.
 */

export type Form = 'compact' | 'wide'

/** Phones top out around 440px on the short side and tablets start around 600px (iPad mini: 744px); 600 sits in the gap. */
export const COMPACT_BELOW = 600

export function formOf(screenWidth: number, screenHeight: number): Form {
  return Math.min(screenWidth, screenHeight) < COMPACT_BELOW ? 'compact' : 'wide'
}

/** The current screen's form factor. Called once at page load and never recomputed (see controller.ts mount). */
export function readForm(): Form {
  return formOf(screen.width, screen.height)
}

/** Extra keys: always shown on `compact`, on `wide` only with a touch screen (`pointer: coarse`). */
export function showsExtraKeys(form: Form, coarse: boolean): boolean {
  return form === 'compact' || coarse
}
