/**
 * UT-keygesture-1 and UT-restore-1 (AC-3.18, AC-3.19, AC-3.26, ADR-0056): what a release on
 * the extra keys means, and where a swipe may restore them.
 */
import { describe, expect, it } from 'vitest'

import { BAND_PX, EDGE_PX, SWIPE_PX, TAP_PX, canStartRestore, isRestoreSwipe, keyGesture } from '../src/keys/collapse'

describe('UT-keygesture-1 keyGesture', () => {
  it('is a tap only when the finger never moved more than 10px', () => {
    expect(TAP_PX).toBe(10)
    expect(keyGesture(0, 0, 0, 'keys', true)).toBe('tap')
    expect(keyGesture(6, -6, 9, 'keys', true)).toBe('tap')
    expect(keyGesture(2, 0, 30, 'keys', true), 'moved away and came back: not a tap').toBe('none')
    expect(keyGesture(0, 25, 25, 'keys', true), 'a short drag is nothing').toBe('none')
  })

  it('collapses on a swipe right from either page', () => {
    expect(SWIPE_PX).toBe(40)
    expect(keyGesture(80, 10, 81, 'keys', true)).toBe('collapse')
    expect(keyGesture(80, -30, 85, 'text', false)).toBe('collapse')
    expect(keyGesture(40, 0, 40, 'keys', true), 'exactly 40 does not count').toBe('none')
    expect(keyGesture(50, 60, 78, 'keys', true), 'mostly vertical is not a collapse').toBe('none')
  })

  it('does nothing on a swipe left', () => {
    expect(keyGesture(-80, 0, 80, 'keys', true)).toBe('none')
    expect(keyGesture(-80, 0, 80, 'text', true)).toBe('none')
  })

  it('goes up to the text page and down back to the keys, the latter only with the box at its top', () => {
    expect(keyGesture(5, -80, 80, 'keys', true)).toBe('toText')
    expect(keyGesture(0, -80, 80, 'text', true), 'already on the text page').toBe('none')
    expect(keyGesture(0, 80, 80, 'text', true)).toBe('toKeys')
    expect(keyGesture(0, 80, 80, 'text', false), 'the box was scrolled: the drag scrolled it').toBe('none')
    expect(keyGesture(0, 80, 80, 'keys', true), 'down on the keys page').toBe('none')
  })
})

describe('UT-restore-1 restoring with a swipe', () => {
  const area = { bottom: 700 }
  const vw = 393

  it('starts only in the bottom band, away from both screen edges', () => {
    expect(BAND_PX).toBe(80)
    expect(EDGE_PX).toBe(24)
    expect(canStartRestore(200, 680, area.bottom, vw)).toBe(true)
    expect(canStartRestore(200, 620, area.bottom, vw), 'exactly 80px up still counts').toBe(true)
    expect(canStartRestore(200, 600, area.bottom, vw), 'above the band').toBe(false)
    expect(canStartRestore(10, 680, area.bottom, vw), 'from the left edge').toBe(false)
    expect(canStartRestore(vw - 10, 680, area.bottom, vw), 'from the right edge (Android Back)').toBe(false)
    expect(canStartRestore(24, 680, area.bottom, vw)).toBe(true)
  })

  it('needs more than 40px to the left, mostly horizontal', () => {
    expect(isRestoreSwipe(-80, 10)).toBe(true)
    expect(isRestoreSwipe(-40, 0)).toBe(false)
    expect(isRestoreSwipe(80, 0), 'right').toBe(false)
    expect(isRestoreSwipe(-50, -60), 'mostly vertical').toBe(false)
  })
})
