/** Composer 的历史导航（input-modes.md §历史导航）。 */
import { describe, expect, it } from 'vitest'

import { HistoryCursor, atFirstLineStart, atLastLineEnd } from '../src/input/history'

describe('历史游标', () => {
  const load = (items: string[], draft = '') => {
    const c = new HistoryCursor()
    c.load('', items, draft)
    return c
  }

  it('↑ 从最近往旧走', () => {
    const c = load(['newest', 'middle', 'oldest'])
    expect(c.older().text).toBe('newest')
    expect(c.older().text).toBe('middle')
    expect(c.older().text).toBe('oldest')
  })

  it('走到底就停住，不回绕', () => {
    const c = load(['only'])
    expect(c.older().text).toBe('only')
    expect(c.older().text, '到底之后不该再动').toBeNull()
  })

  it('↓ 走回来，走出历史时恢复暂存的草稿', () => {
    const c = load(['a', 'b'], 'my draft')
    c.older()
    c.older()
    expect(c.newer().text).toBe('a')
    expect(c.newer().text, '走出历史应当回到草稿').toBe('my draft')
    expect(c.browsing).toBe(false)
  })

  it('没进历史时按 ↓ 不动', () => {
    const c = load(['a'], 'draft')
    expect(c.newer().text).toBeNull()
  })

  it('空历史时按 ↑ 不动', () => {
    const c = load([])
    expect(c.older().text).toBeNull()
  })
})

describe('什么时候才翻历史', () => {
  it('光标在首行行首才翻历史', () => {
    // 多行输入里按 ↑ 的意图通常是"上移一行"，不是"翻历史"
    expect(atFirstLineStart('a\nb', 0, 0)).toBe(true)
    expect(atFirstLineStart('a\nb', 1, 1)).toBe(false)
    expect(atFirstLineStart('a\nb', 2, 2)).toBe(false)
  })

  it('有选区时不翻历史', () => {
    expect(atFirstLineStart('abc', 0, 2)).toBe(false)
    expect(atLastLineEnd('abc', 1, 3)).toBe(false)
  })

  it('光标在末行行尾才往回翻', () => {
    expect(atLastLineEnd('a\nb', 3, 3)).toBe(true)
    expect(atLastLineEnd('a\nb', 2, 2)).toBe(false)
  })
})
