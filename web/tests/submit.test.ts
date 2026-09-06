/** UT-input-1：Composer 的提交格式（AC-3.2）。 */
import { describe, expect, it } from 'vitest'

import { encodeSubmission } from '../src/ui/app'

const dec = (b: Uint8Array) => new TextDecoder().decode(b)

describe('UT-input-1 提交格式', () => {
  it('单行不包 bracketed paste', () => {
    // ESC[200~ 只有对端开着 bracketed paste 时才会被吞掉。集成失效被强制
    // Composer 时对端可能是 cat / python REPL / bash < 4.4 —— 单行本来就
    // 不需要它，不包就没有留下字面量的风险。
    expect(dec(encodeSubmission('echo hi'))).toBe('echo hi\r')
  })

  it('多行包 bracketed paste，否则会被逐行当成独立命令执行', () => {
    const got = dec(encodeSubmission('echo one\necho two'))
    expect(got).toBe('\x1b[200~echo one\necho two\x1b[201~\r')
  })

  it('空输入只发 CR，让用户能按回车重画 prompt', () => {
    expect(dec(encodeSubmission(''))).toBe('\r')
    expect(dec(encodeSubmission('   '))).toBe('\r')
  })

  it('结尾是 CR 而不是 LF —— PTY 的行规程期望回车键的真实字节', () => {
    const got = dec(encodeSubmission('ls'))
    expect(got.endsWith('\r')).toBe(true)
    expect(got.includes('\n')).toBe(false)
  })
})
