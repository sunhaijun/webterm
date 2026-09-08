/**
 * 命令块的切分。
 *
 * 这个模块唯一的职责是【按 out_seq 把字节流切成块】，所以测试全都围绕
 * 边界：起止对齐、跨 chunk、还在跑、reset 回放、保留窗口滚掉之后。
 */
import { describe, expect, it } from 'vitest'

import { BlockStore } from '../src/commands/blocks'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** 按顺序写入若干段，自动维护 out_seq。 */
function feed(s: BlockStore, sid: number, parts: string[], from = 0): number {
  let seq = from
  for (const p of parts) {
    const b = enc.encode(p)
    s.write(sid, b, false, seq)
    seq += b.length
  }
  return seq
}

const start = (cmd_id: number, out_seq: number, text = 'cmd' + cmd_id) => ({
  cmd_id, text, cwd: '/home/sun', at: 1_700_000_000_000, out_seq,
})
const end = (cmd_id: number, out_seq: number, exit_code: number | null = 0) => ({
  cmd_id, exit_code, duration_ms: 120, out_seq,
})

describe('BlockStore', () => {
  it('把一条命令的输出按 out_seq 切出来', () => {
    const s = new BlockStore()
    let seq = 0
    s.cmdStart(1, start(1, seq))
    seq = feed(s, 1, ['hello\n'], seq)
    s.cmdEnd(1, end(1, seq))

    const b = s.blocks(1)[0]!
    expect(b.text).toBe('cmd1')
    expect(b.exitCode).toBe(0)
    expect(dec.decode(s.bytesOf(1, b)!.bytes)).toBe('hello\n')
    expect(s.bytesOf(1, b)!.truncated).toBe(false)
  })

  it('相邻两条命令不会串味', () => {
    const s = new BlockStore()
    let seq = 0
    s.cmdStart(1, start(1, seq)); seq = feed(s, 1, ['AAA'], seq); s.cmdEnd(1, end(1, seq))
    s.cmdStart(1, start(2, seq)); seq = feed(s, 1, ['BBB'], seq); s.cmdEnd(1, end(2, seq, 1))

    const b1 = s.blocks(1)[0]!
    const b2 = s.blocks(1)[1]!
    expect(dec.decode(s.bytesOf(1, b1)!.bytes)).toBe('AAA')
    expect(dec.decode(s.bytesOf(1, b2)!.bytes)).toBe('BBB')
    expect(b2.exitCode).toBe(1)
  })

  it('输出跨多个帧也要拼完整', () => {
    const s = new BlockStore()
    let seq = 0
    s.cmdStart(1, start(1, seq))
    seq = feed(s, 1, ['line1\n', 'line2\n', 'line3\n'], seq)
    s.cmdEnd(1, end(1, seq))
    expect(dec.decode(s.bytesOf(1, s.blocks(1)[0]!)!.bytes)).toBe('line1\nline2\nline3\n')
  })

  it('还在跑的块取到目前为止的输出', () => {
    const s = new BlockStore()
    s.cmdStart(1, start(1, 0))
    feed(s, 1, ['partial'], 0)
    const b = s.blocks(1)[0]!
    expect(b.endSeq).toBeNull()
    expect(dec.decode(s.bytesOf(1, b)!.bytes)).toBe('partial')
  })

  it('cmd_start 重复到达不建重复的块（重连会重放）', () => {
    const s = new BlockStore()
    s.cmdStart(1, start(1, 0))
    s.cmdStart(1, start(1, 0))
    expect(s.blocks(1)).toHaveLength(1)
  })

  it('配不上 cmd_start 的 cmd_end 直接丢掉', () => {
    const s = new BlockStore()
    s.cmdEnd(1, end(99, 10))
    expect(s.blocks(1)).toHaveLength(0)
  })

  it('滚出保留窗口的部分要标 truncated，而不是假装完整', () => {
    const s = new BlockStore(16) // 16 字节的小窗口，方便触发
    let seq = 0
    s.cmdStart(1, start(1, seq))
    seq = feed(s, 1, ['0123456789', 'abcdefghij', 'ABCDEFGHIJ'], seq)
    s.cmdEnd(1, end(1, seq))

    const got = s.bytesOf(1, s.blocks(1)[0]!)!
    expect(got.truncated).toBe(true)
    // 最旧的那段被丢了，剩下的必须是原文的后缀
    expect('0123456789abcdefghijABCDEFGHIJ'.endsWith(dec.decode(got.bytes))).toBe(true)
    expect(got.bytes.length).toBeLessThan(30)
  })

  it('整段都滚没了就给空 + truncated', () => {
    const s = new BlockStore(8)
    let seq = 0
    s.cmdStart(1, start(1, seq)); seq = feed(s, 1, ['12345678'], seq); s.cmdEnd(1, end(1, seq))
    feed(s, 1, ['abcdefgh', 'ABCDEFGH'], seq)
    const got = s.bytesOf(1, s.blocks(1)[0]!)!
    expect(got.truncated).toBe(true)
    expect(got.bytes.length).toBe(0)
  })

  it('reset 回放丢掉字节但保留块本身', () => {
    const s = new BlockStore()
    let seq = 0
    s.cmdStart(1, start(1, seq)); seq = feed(s, 1, ['old'], seq); s.cmdEnd(1, end(1, seq))

    // reset：前 4 字节是 SGR reset，不计入 seq
    const payload = new Uint8Array([0x1b, 0x5b, 0x30, 0x6d, ...enc.encode('fresh')])
    s.write(1, payload, true, 1000)

    expect(s.blocks(1)).toHaveLength(1) // 命令发生过，别抹掉
    expect(s.bytesOf(1, s.blocks(1)[0]!)!.bytes.length).toBe(0)

    // 【记账不能被那 4 个字节带偏】：新块从 1000 起，写了 5 字节
    s.cmdStart(1, start(2, 1000))
    s.cmdEnd(1, end(2, 1005))
    expect(dec.decode(s.bytesOf(1, s.blocks(1)[1]!)!.bytes)).toBe('fresh')
  })

  it('保留窗口真的把内存压住了', () => {
    const s = new BlockStore(1024)
    feed(s, 1, Array.from({ length: 100 }, () => 'x'.repeat(100)))
    expect(s.retained(1)).toBeLessThanOrEqual(1024 + 100) // 整块丢，允许一块的余量
  })

  it('forget 之后不再持有这个会话', () => {
    const s = new BlockStore()
    s.cmdStart(1, start(1, 0)); feed(s, 1, ['x'], 0)
    s.forget(1)
    expect(s.blocks(1)).toHaveLength(0)
    expect(s.retained(1)).toBe(0)
  })
})

  // 读视图的降级形态：没有任何块认领的输出落在尾块里。
  describe('尾块（降级）', () => {
    it('没有块时，全部输出都是尾块', () => {
      const s = new BlockStore()
      feed(s, 1, ['raw shell output\n'])
      expect(dec.decode(s.tailBytes(1)!.bytes)).toBe('raw shell output\n')
    })

    it('最后一个块结束之后的输出是尾块；块在跑时尾块为空', () => {
      const s = new BlockStore()
      let seq = 0
      s.cmdStart(1, start(1, seq)); seq = feed(s, 1, ['out\n'], seq)
      expect(s.hasRunning(1)).toBe(true)
      expect(s.tailBytes(1)!.bytes.length).toBe(0) // 归运行中的块
      s.cmdEnd(1, end(1, seq))
      seq = feed(s, 1, ['$ '], seq) // 新 prompt：谁都不认领
      expect(s.hasRunning(1)).toBe(false)
      expect(dec.decode(s.tailBytes(1)!.bytes)).toBe('$ ')
    })

    it('ssh 出去之后的输出全进尾块，回来后新块从标记处重新切', () => {
      const s = new BlockStore()
      let seq = 0
      s.cmdStart(1, start(1, seq, 'ssh host')); seq = feed(s, 1, ['remote$ ls\nfile\n'], seq)
      // ssh 还在跑：这些都是 ssh 那个块的输出
      expect(dec.decode(s.bytesOf(1, s.blocks(1)[0]!)!.bytes)).toBe('remote$ ls\nfile\n')
      s.cmdEnd(1, end(1, seq)) // exit 回来，外层 133;D
      seq = feed(s, 1, ['$ '], seq)
      s.cmdStart(1, start(2, seq, 'echo back')); seq = feed(s, 1, ['back\n'], seq); s.cmdEnd(1, end(2, seq))
      expect(dec.decode(s.bytesOf(1, s.blocks(1)[1]!)!.bytes)).toBe('back\n')
    })
  })
