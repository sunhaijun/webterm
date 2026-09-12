import { describe, expect, it } from 'vitest'

import { formatPairDigits, normalizePairDigits } from '../src/ui/paircode'

describe('数字配对码的显示与规整（ADR-0017）', () => {
  it('4 位一组、- 分隔', () => {
    expect(formatPairDigits('4821093755661204')).toBe('4821-0937-5566-1204')
    expect(formatPairDigits('48210937')).toBe('4821-0937')
    expect(formatPairDigits('482')).toBe('482')
    expect(formatPairDigits('')).toBe('')
  })
  it('边输边分组：输入里已有的分隔符不会叠加', () => {
    expect(formatPairDigits('4821-0937-5')).toBe('4821-0937-5')
    expect(formatPairDigits('4821 0937 5566 1204')).toBe('4821-0937-5566-1204')
  })
  it('超过 16 位截断，非数字剥掉', () => {
    expect(formatPairDigits('4821093755661204999')).toBe('4821-0937-5566-1204')
    expect(normalizePairDigits(' 4821–0937—5566 1204 ')).toBe('4821093755661204')
    expect(normalizePairDigits('abc')).toBe('')
  })
})
