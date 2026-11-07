/**
 * "Waiting for you" (session-ux.md, ADR-0052): the agent holds one attention flag per
 * session; the page that has the session in front of the user clears it with session.seen.
 */

export interface SeenState {
  /** The current session, or null. */
  active: number | null
  /** The session being considered. */
  sid: number
  /** Its attention flag as last reported by the agent. */
  attention: boolean
  /** `document.visibilityState === 'visible'`. */
  visible: boolean
  /** `document.hasFocus()`. */
  focused: boolean
}

/** Whether the page should send session.seen for `sid` now (ADR-0052 §2). */
export function shouldSendSeen(s: SeenState): boolean {
  return s.active !== null && s.active === s.sid && s.attention && s.visible && s.focused
}
