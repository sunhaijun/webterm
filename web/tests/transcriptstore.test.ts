import { describe, expect, it } from 'vitest'

import { TranscriptStore, aiSourceOf } from '../src/commands/transcriptstore'
import type { TranscriptItem } from '../src/protocol/messages'

const it1 = (id: string, text = id): TranscriptItem => ({ id, role: 'assistant', kind: 'text', text, at: 1 })

/** UT-transcriptstore：reset 清空、按 id 去重、HTTP 回放替换、命令结束标记不活跃。 */
describe('TranscriptStore', () => {
  it('增量追加、去重、reset 清空', () => {
    const s = new TranscriptStore()
    expect(s.apply({ t: 'transcript', sid: 1, source: 'claude', items: [], reset: true })).toBe(true)
    expect(s.get(1)?.items).toEqual([])
    expect(s.apply({ t: 'transcript', sid: 1, source: 'claude', items: [it1('a'), it1('b')] })).toBe(true)
    expect(s.apply({ t: 'transcript', sid: 1, source: 'claude', items: [it1('b'), it1('c')] })).toBe(true)
    expect(s.get(1)?.items.map((x) => x.id)).toEqual(['a', 'b', 'c'])
    expect(s.apply({ t: 'transcript', sid: 1, source: 'claude', items: [it1('c')] }), '全是重复 → 没变化').toBe(false)
    s.apply({ t: 'transcript', sid: 1, source: 'codex', items: [it1('z')], reset: true })
    expect(s.get(1)?.items.map((x) => x.id)).toEqual(['z'])
    expect(s.get(1)?.source).toBe('codex')
  })
  it('HTTP 回放整份替换；finish 标记不活跃；clear 删掉', () => {
    const s = new TranscriptStore()
    s.apply({ t: 'transcript', sid: 2, source: 'claude', items: [it1('a')], reset: true })
    s.replace({ sid: 2, source: 'claude', active: true, items: [it1('a'), it1('b'), it1('b')] })
    expect(s.get(2)?.items.map((x) => x.id)).toEqual(['a', 'b'])
    s.finish(2)
    expect(s.get(2)?.active).toBe(false)
    s.clear(2)
    expect(s.get(2)).toBeUndefined()
  })
  it('aiSourceOf 只认 claude / codex', () => {
    expect(aiSourceOf('claude')).toBe('claude')
    expect(aiSourceOf('codex')).toBe('codex')
    expect(aiSourceOf('vim')).toBeNull()
    expect(aiSourceOf(null)).toBeNull()
  })
})
