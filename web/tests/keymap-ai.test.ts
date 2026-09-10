import { describe, expect, it } from 'vitest'

import { keyBarFor, programOf } from '../src/input/keymap'

/** AI CLI（claude / codex）键条：没有 q，有 ⇧Tab / 斜杠（ADR-0012 α）。 */
describe('keyBarFor: AI CLI 上下文', () => {
  it('claude / codex / gemini / aider 都拿到 ai 套', () => {
    for (const prog of ['claude', 'codex', 'gemini', 'aider']) {
      const keys = keyBarFor({ altScreen: true, program: prog })
      expect(keys.some((k) => k.key === 'ShiftTab' && k.bytes === '\x1b[Z'), `${prog}: ⇧Tab 发 CSI Z`).toBe(true)
      expect(keys.some((k) => k.key === 'ai-slash' && k.bytes === '/')).toBe(true)
      expect(keys.some((k) => k.key === 'tui-q'), `${prog}: 不该有 q`).toBe(false)
    }
  })
  it('不认识的程序仍是通用 TUI 套；不占屏是默认排', () => {
    expect(keyBarFor({ altScreen: true, program: 'foo' }).some((k) => k.key === 'tui-q')).toBe(true)
    expect(keyBarFor({ altScreen: false, program: 'claude' }).some((k) => k.key === 'ShiftTab')).toBe(false)
  })
  it('programOf 取管道 / 分号后最后一段的程序名（shell 函数写法也认）', () => {
    expect(programOf("claude() { printf 'x'; sleep 30; }; claude")).toBe('claude')
    expect(programOf('cd ~/p && codex --model x')).toBe('codex')
  })
})
