/**
 * UT-attention-1 (AC-4.3, ADR-0052 §2): when the page sends session.seen. Only for the
 * session in front of the user: the current one, on a visible page that has focus, and only
 * when it has attention (otherwise there's nothing to clear).
 */
import { describe, expect, it } from 'vitest'

import { shouldSendSeen } from '../src/sessions/attention'

const base = { active: 2, sid: 2, attention: true, visible: true, focused: true }

describe('shouldSendSeen', () => {
  it('sends for the current session with attention on a visible, focused page', () => {
    expect(shouldSendSeen(base)).toBe(true)
  })
  it('not for another session', () => {
    expect(shouldSendSeen({ ...base, sid: 3 })).toBe(false)
  })
  it('not without a current session', () => {
    expect(shouldSendSeen({ ...base, active: null })).toBe(false)
  })
  it('not when there is nothing to clear', () => {
    expect(shouldSendSeen({ ...base, attention: false })).toBe(false)
  })
  it('not while the page is hidden (phone locked, app in the background)', () => {
    expect(shouldSendSeen({ ...base, visible: false })).toBe(false)
  })
  it('not while the page lacks focus (desktop window behind another app)', () => {
    expect(shouldSendSeen({ ...base, focused: false })).toBe(false)
  })
})
