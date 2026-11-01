import { describe, expect, it } from 'vitest'

import { formatPairDigits, normalizePairDigits } from '../src/ui/paircode'

describe('numeric pairing code display and normalization (ADR-0017)', () => {
  it('groups by 4 with - separators', () => {
    expect(formatPairDigits('4821093755661204')).toBe('4821-0937-5566-1204')
    expect(formatPairDigits('48210937')).toBe('4821-0937')
    expect(formatPairDigits('482')).toBe('482')
    expect(formatPairDigits('')).toBe('')
  })
  it('groups while typing without doubling existing separators', () => {
    expect(formatPairDigits('4821-0937-5')).toBe('4821-0937-5')
    expect(formatPairDigits('4821 0937 5566 1204')).toBe('4821-0937-5566-1204')
  })
  it('truncates past 16 digits and strips non-digits', () => {
    expect(formatPairDigits('4821093755661204999')).toBe('4821-0937-5566-1204')
    expect(normalizePairDigits(' 4821–0937—5566 1204 ')).toBe('4821093755661204')
    expect(normalizePairDigits('abc')).toBe('')
  })
})
