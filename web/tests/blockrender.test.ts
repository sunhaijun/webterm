/**
 * plainText：运行中块与尾块的纯文本渲染。
 *
 * 之前一个测试都没有，于是 CRLF 把整块内容吃空了都没人发现 ——
 * 完成态的块走离屏 xterm，只有 live-tail 暴露这条路径。
 */
import { describe, expect, it } from 'vitest'

import { plainText } from '../src/commands/blockrender'

const enc = (s: string) => new TextEncoder().encode(s)

describe('plainText', () => {
  it('PTY 的 CRLF 行尾不能把内容吃掉', () => {
    expect(plainText(enc('AAA\r\nBBB\r\n'))).toBe('AAA\nBBB\n')
  })

  it('行内 \\r 是覆盖写：保留最后一次重画', () => {
    expect(plainText(enc('10%\r50%\r100%\n'))).toBe('100%\n')
  })

  it('进度条刚回到行首、还没重画时，显示上一帧而不是空白', () => {
    expect(plainText(enc('downloading 42%\r'))).toBe('downloading 42%')
  })

  it('剥掉 SGR / CSI / OSC 转义', () => {
    expect(plainText(enc('\x1b[32mok\x1b[0m \x1b]0;title\x07done\x1b[K\n'))).toBe('ok done\n')
  })

  it('纯 LF 的输出原样', () => {
    expect(plainText(enc('a\nb\nc'))).toBe('a\nb\nc')
  })

  it('空输入', () => {
    expect(plainText(new Uint8Array(0))).toBe('')
  })
})
