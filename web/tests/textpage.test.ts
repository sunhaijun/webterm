/** UT-textinput-1: Enter semantics on the text page and the page-flip swipe (AC-3.19, input.md). */
import { describe, expect, it } from 'vitest'

import { PAGE_SWIPE_PX, TextPages, isPageSwipe, textEnter } from '../src/keys/textpage'

const key = (isComposing = false, keyCode = 13) => ({ isComposing, keyCode })

describe('UT-textinput-1 Enter sends and submits (ADR-0027)', () => {
  it('sends the text and Enter when non-empty', () => {
    expect(textEnter('echo TEXT-ONE', key())).toEqual({ kind: 'submit', text: 'echo TEXT-ONE' })
    expect(textEnter('你好', key())).toEqual({ kind: 'submit', text: '你好' })
  })

  it('hands multi-line text (only possible via paste) over whole for the caller to term.paste', () => {
    expect(textEnter('echo L1\necho L2', key())).toEqual({ kind: 'submit', text: 'echo L1\necho L2' })
  })

  it('sends just Enter when empty', () => {
    expect(textEnter('', key())).toEqual({ kind: 'submit', text: '' })
  })

  it('does nothing mid-composition, leaving it to the IME (isComposing or keyCode 229)', () => {
    expect(textEnter('ni', key(true))).toEqual({ kind: 'none' })
    expect(textEnter('ni', key(false, 229))).toEqual({ kind: 'none' })
    expect(textEnter('', key(true)), 'no \\r while composing, even when empty').toEqual({ kind: 'none' })
  })

  it('treats whitespace-only text as content (sent as is)', () => {
    expect(textEnter('  ', key())).toEqual({ kind: 'submit', text: '  ' })
  })
})

describe('swiping across the keys flips pages', () => {
  it('requires > 40px of mostly horizontal movement', () => {
    expect(PAGE_SWIPE_PX).toBe(40)
    expect(isPageSwipe(80, 0)).toBe(true)
    expect(isPageSwipe(-80, 10)).toBe(true)
    expect(isPageSwipe(40, 0), 'exactly 40 does not count').toBe(false)
    expect(isPageSwipe(50, 60), 'mostly vertical does not count').toBe(false)
    expect(isPageSwipe(0, 0), 'a tap does not count').toBe(false)
  })
})

describe('UT-textinput-2 page and draft per session (ADR-0036)', () => {
  it('defaults unknown sessions to the key page and an empty draft', () => {
    const p = new TextPages()
    expect(p.page(1)).toBe('keys')
    expect(p.draft(1)).toBe('')
  })

  it('tracks page and draft separately per session', () => {
    const p = new TextPages()
    p.setPage(1, 'text')
    p.setDraft(1, 'echo A')
    p.setDraft(2, 'echo B')
    expect([p.page(1), p.draft(1)]).toEqual(['text', 'echo A'])
    expect([p.page(2), p.draft(2)], 'a session with only a draft stays on the key page').toEqual(['keys', 'echo B'])
  })

  it('tracks the no-session (null) entry too, and retain never drops it', () => {
    const p = new TextPages()
    p.setPage(null, 'text')
    p.retain(() => false)
    expect(p.page(null)).toBe('text')
  })

  it('retain forgets closed sessions, so a reused sid starts fresh', () => {
    const p = new TextPages()
    p.setPage(1, 'text')
    p.setDraft(1, 'x')
    p.setPage(2, 'text')
    p.retain((sid) => sid === 2)
    expect([p.page(1), p.draft(1)]).toEqual(['keys', ''])
    expect(p.page(2)).toBe('text')
  })
})
