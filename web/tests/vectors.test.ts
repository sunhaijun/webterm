/**
 * 协议向量：与 Go 侧共用【同一份】fixture（协议 §9）。
 *
 * 两侧都跑它，是防止 internal/protocol 与 web/src/protocol 实现漂移的
 * 唯一机械化手段（ADR-0009）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  FLAG_MORE,
  MAX_PAYLOAD,
  PROTOCOL_VERSION,
  TYPE_INPUT,
  TYPE_OUTPUT,
  TYPE_SNAPSHOT,
  dataLen,
  decodeFrame,
  encodeFrame,
  hasMore,
} from '../src/protocol/frame'
import { decodeMessage } from '../src/protocol/messages'

// 直接读 Go 侧的那一份，不做拷贝 —— 有拷贝就会有漂移
const vectorsPath = resolve(process.cwd(), '../internal/protocol/testdata/vectors.json')
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8')) as {
  binary_frames: {
    name: string
    hex: string
    decoded: { type: number; flags: number; sid: number; seq: string | number; payload_hex: string }
    data_len: number
  }[]
  invalid_frames: { name: string; hex: string; expect_error: string }[]
  control_messages: { name: string; json: Record<string, unknown> }[]
  unknown_messages: { name: string; json: Record<string, unknown> }[]
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

describe('二进制帧向量', () => {
  for (const tc of vectors.binary_frames) {
    it(tc.name, () => {
      const f = decodeFrame(fromHex(tc.hex))
      expect(f.type).toBe(tc.decoded.type)
      expect(f.flags).toBe(tc.decoded.flags)
      expect(f.sid).toBe(tc.decoded.sid)
      // seq 是 uint64，fixture 里是字符串，按 BigInt 比
      expect(f.seq).toBe(BigInt(tc.decoded.seq))
      expect(toHex(f.payload)).toBe(tc.decoded.payload_hex)
      // 计入 seq 的字节数：快照是 0
      expect(dataLen(f)).toBe(tc.data_len)
      // 往返：重新编码必须逐字节还原
      expect(toHex(encodeFrame(f))).toBe(tc.hex)
    })
  }

  it('fixture 里有 v2 的 SNAPSHOT 帧（带 MORE 的一帧）', () => {
    const snaps = vectors.binary_frames.filter((tc) => tc.decoded.type === TYPE_SNAPSHOT)
    expect(snaps.length, 'vectors.json 还没按协议 §9 更新到 v2').toBeGreaterThan(0)
    expect(snaps.some((tc) => (tc.decoded.flags & FLAG_MORE) !== 0)).toBe(true)
  })
})

describe('非法帧向量', () => {
  for (const tc of vectors.invalid_frames) {
    it(tc.name, () => {
      expect(() => decodeFrame(fromHex(tc.hex))).toThrow(tc.expect_error === 'frame_too_large' ? /too large/i : undefined)
    })
  }
})

describe('控制消息向量', () => {
  for (const tc of vectors.control_messages) {
    it(tc.name, () => {
      const msg = decodeMessage(JSON.stringify(tc.json))
      expect(msg).not.toBeNull()
      // 每个字段都要能原样读回来
      expect(msg).toMatchObject(tc.json)
    })
  }

  it('hello 里的 protocol 是当前版本 2', () => {
    expect(PROTOCOL_VERSION).toBe(2)
    const hellos = vectors.control_messages.filter((tc) => tc.json.t === 'hello')
    for (const h of hellos) expect(h.json.protocol).toBe(PROTOCOL_VERSION)
  })
})

describe('未知消息', () => {
  for (const tc of vectors.unknown_messages) {
    it(`${tc.name} 必须被忽略而不是报错`, () => {
      // 返回 null = 调用方忽略它。前向兼容靠的就是这条。
      expect(decodeMessage(JSON.stringify(tc.json))).toBeNull()
    })
  }

  it('v2 删掉的消息也一律忽略（reset / redraw / cwd / prompt / command.*）', () => {
    for (const t of ['reset', 'redraw', 'cwd', 'prompt', 'command.start', 'command.end']) {
      expect(decodeMessage(JSON.stringify({ t, sid: 1 })), t).toBeNull()
    }
  })
})

describe('帧边界', () => {
  it('三种类型都能解：OUTPUT / INPUT / SNAPSHOT（方向由收的一侧判）', () => {
    for (const type of [TYPE_OUTPUT, TYPE_INPUT, TYPE_SNAPSHOT]) {
      const f = decodeFrame(encodeFrame({ type, flags: 0, sid: 1, seq: 5n, payload: new Uint8Array([0x41]) }))
      expect(f.type).toBe(type)
    }
  })
  it('拒绝未知类型 0x04', () => {
    expect(() => decodeFrame(fromHex('0400000100000000000000e86869'))).toThrow()
  })
  it('拒绝空 payload', () => {
    expect(() => decodeFrame(fromHex('0100000100000000000000e8'))).toThrow()
  })
  it('拒绝超大帧', () => {
    const payload = new Uint8Array(MAX_PAYLOAD + 1)
    const big = encodeFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload })
    expect(() => decodeFrame(big)).toThrow(/too large/i)
  })
  it('seq 走到 uint64 上界仍然正确', () => {
    const max = 18446744073709551615n
    const f = { type: TYPE_OUTPUT, flags: 0, sid: 65535, seq: max, payload: new Uint8Array([0x41]) }
    expect(decodeFrame(encodeFrame(f)).seq).toBe(max)
  })
  it('MORE 只对 SNAPSHOT 有意义；OUTPUT 上的 bit0 是保留位，接收方忽略', () => {
    const p = new Uint8Array([0x41])
    expect(hasMore({ type: TYPE_SNAPSHOT, flags: FLAG_MORE, sid: 1, seq: 0n, payload: p })).toBe(true)
    expect(hasMore({ type: TYPE_SNAPSHOT, flags: 0, sid: 1, seq: 0n, payload: p })).toBe(false)
    expect(hasMore({ type: TYPE_OUTPUT, flags: FLAG_MORE, sid: 1, seq: 0n, payload: p })).toBe(false)
    expect(() => decodeFrame(encodeFrame({ type: TYPE_OUTPUT, flags: 0xff, sid: 1, seq: 0n, payload: p }))).not.toThrow()
  })
})
