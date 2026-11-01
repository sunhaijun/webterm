/**
 * Protocol vectors: the same fixture file the Go side uses (protocol §9).
 *
 * Running it on both sides is the only mechanical guard against internal/protocol and
 * web/src/protocol drifting apart (ADR-0009).
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

// Read the Go side's copy directly; a copy would drift
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

describe('binary frame vectors', () => {
  for (const tc of vectors.binary_frames) {
    it(tc.name, () => {
      const f = decodeFrame(fromHex(tc.hex))
      expect(f.type).toBe(tc.decoded.type)
      expect(f.flags).toBe(tc.decoded.flags)
      expect(f.sid).toBe(tc.decoded.sid)
      // seq is a uint64 stored as a string in the fixture; compare as BigInt
      expect(f.seq).toBe(BigInt(tc.decoded.seq))
      expect(toHex(f.payload)).toBe(tc.decoded.payload_hex)
      // Bytes counted toward seq: 0 for snapshots
      expect(dataLen(f)).toBe(tc.data_len)
      // Round trip: re-encoding must reproduce every byte
      expect(toHex(encodeFrame(f))).toBe(tc.hex)
    })
  }

  it('includes v2 SNAPSHOT frames (one with MORE)', () => {
    const snaps = vectors.binary_frames.filter((tc) => tc.decoded.type === TYPE_SNAPSHOT)
    expect(snaps.length, 'vectors.json has not been updated to v2 per protocol §9').toBeGreaterThan(0)
    expect(snaps.some((tc) => (tc.decoded.flags & FLAG_MORE) !== 0)).toBe(true)
  })
})

describe('invalid frame vectors', () => {
  for (const tc of vectors.invalid_frames) {
    it(tc.name, () => {
      expect(() => decodeFrame(fromHex(tc.hex))).toThrow(tc.expect_error === 'frame_too_large' ? /too large/i : undefined)
    })
  }
})

describe('control message vectors', () => {
  for (const tc of vectors.control_messages) {
    it(tc.name, () => {
      const msg = decodeMessage(JSON.stringify(tc.json))
      expect(msg).not.toBeNull()
      // Every field must read back unchanged
      expect(msg).toMatchObject(tc.json)
    })
  }

  it('hello carries the current protocol version 2', () => {
    expect(PROTOCOL_VERSION).toBe(2)
    const hellos = vectors.control_messages.filter((tc) => tc.json.t === 'hello')
    for (const h of hellos) expect(h.json.protocol).toBe(PROTOCOL_VERSION)
  })
})

describe('unknown messages', () => {
  for (const tc of vectors.unknown_messages) {
    it(`${tc.name} is ignored, not an error`, () => {
      // null = the caller ignores it. Forward compatibility depends on this.
      expect(decodeMessage(JSON.stringify(tc.json))).toBeNull()
    })
  }

  it('ignores messages removed in v2 (reset / redraw / cwd / prompt / command.*)', () => {
    for (const t of ['reset', 'redraw', 'cwd', 'prompt', 'command.start', 'command.end']) {
      expect(decodeMessage(JSON.stringify({ t, sid: 1 })), t).toBeNull()
    }
  })
})

describe('frame edge cases', () => {
  it('decodes all three types: OUTPUT / INPUT / SNAPSHOT (direction is checked by the receiver)', () => {
    for (const type of [TYPE_OUTPUT, TYPE_INPUT, TYPE_SNAPSHOT]) {
      const f = decodeFrame(encodeFrame({ type, flags: 0, sid: 1, seq: 5n, payload: new Uint8Array([0x41]) }))
      expect(f.type).toBe(type)
    }
  })
  it('rejects unknown type 0x04', () => {
    expect(() => decodeFrame(fromHex('0400000100000000000000e86869'))).toThrow()
  })
  it('rejects an empty payload', () => {
    expect(() => decodeFrame(fromHex('0100000100000000000000e8'))).toThrow()
  })
  it('rejects oversized frames', () => {
    const payload = new Uint8Array(MAX_PAYLOAD + 1)
    const big = encodeFrame({ type: TYPE_OUTPUT, flags: 0, sid: 1, seq: 0n, payload })
    expect(() => decodeFrame(big)).toThrow(/too large/i)
  })
  it('handles seq at the uint64 maximum', () => {
    const max = 18446744073709551615n
    const f = { type: TYPE_OUTPUT, flags: 0, sid: 65535, seq: max, payload: new Uint8Array([0x41]) }
    expect(decodeFrame(encodeFrame(f)).seq).toBe(max)
  })
  it('honors MORE only on SNAPSHOT; bit0 on OUTPUT is reserved and ignored', () => {
    const p = new Uint8Array([0x41])
    expect(hasMore({ type: TYPE_SNAPSHOT, flags: FLAG_MORE, sid: 1, seq: 0n, payload: p })).toBe(true)
    expect(hasMore({ type: TYPE_SNAPSHOT, flags: 0, sid: 1, seq: 0n, payload: p })).toBe(false)
    expect(hasMore({ type: TYPE_OUTPUT, flags: FLAG_MORE, sid: 1, seq: 0n, payload: p })).toBe(false)
    expect(() => decodeFrame(encodeFrame({ type: TYPE_OUTPUT, flags: 0xff, sid: 1, seq: 0n, payload: p }))).not.toThrow()
  })
})
