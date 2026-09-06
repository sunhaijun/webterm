/**
 * 协议向量：与 Go 侧共用【同一份】fixture。
 *
 * 两侧都跑它，是防止 internal/protocol 与 web/src/protocol 实现漂移的
 * 唯一机械化手段（协议 §9 / ADR-0009）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  ATTR_PREFIX,
  FLAG_ATTR_PREFIX,
  MAX_PAYLOAD,
  TYPE_OUTPUT,
  dataLen,
  decodeFrame,
  encodeFrame,
} from '../src/protocol/frame'
import { decodeMessage } from '../src/protocol/messages'

// 直接读 Go 侧的那一份，不做拷贝 —— 有拷贝就会有漂移
const vectorsPath = resolve(process.cwd(), '../internal/protocol/testdata/vectors.json')
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8')) as {
  binary_frames: {
    name: string
    hex: string
    decoded: { type: number; flags: number; sid: number; seq: number; payload_hex: string }
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
      // seq 是 uint64，JSON 里超过 2^53 的值要按字符串比
      expect(f.seq.toString()).toBe(BigInt(tc.decoded.seq).toString())
      expect(toHex(f.payload)).toBe(tc.decoded.payload_hex)
      expect(dataLen(f)).toBe(tc.data_len)
      // 往返：重新编码必须逐字节还原
      expect(toHex(encodeFrame(f))).toBe(tc.hex)
    })
  }
})

describe('非法帧向量', () => {
  for (const tc of vectors.invalid_frames) {
    it(tc.name, () => {
      expect(() => decodeFrame(fromHex(tc.hex))).toThrow()
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
})

describe('未知消息', () => {
  for (const tc of vectors.unknown_messages) {
    it(`${tc.name} 必须被忽略而不是报错`, () => {
      // 返回 null = 调用方忽略它。前向兼容靠的就是这条。
      expect(decodeMessage(JSON.stringify(tc.json))).toBeNull()
    })
  }
})

describe('ATTR_PREFIX 的 seq 记账', () => {
  it('前 4 字节不计入 seq —— 算错了两侧会永久错开', () => {
    const data = new TextEncoder().encode('hello')
    const payload = new Uint8Array(ATTR_PREFIX.length + data.length)
    payload.set(ATTR_PREFIX)
    payload.set(data, ATTR_PREFIX.length)

    const f = {
      type: TYPE_OUTPUT,
      flags: FLAG_ATTR_PREFIX,
      sid: 1,
      seq: 1000n,
      payload,
    }
    expect(dataLen(f)).toBe(data.length)
    expect(f.seq + BigInt(dataLen(f))).toBe(1005n)
  })
})

describe('帧边界', () => {
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
    const f = {
      type: TYPE_OUTPUT,
      flags: 0,
      sid: 65535,
      seq: max,
      payload: new Uint8Array([0x41]),
    }
    expect(decodeFrame(encodeFrame(f)).seq).toBe(max)
  })
})
