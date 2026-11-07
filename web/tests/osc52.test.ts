/**
 * UT-osc52-1 (AC-5.20, ADR-0053 §4): OSC 52 payloads. Base64 decoded as UTF-8 is a write;
 * `?` is a read, which the page ignores; malformed or oversized payloads are ignored.
 */
import { describe, expect, it } from 'vitest'

import { MAX_OSC52_BYTES, parseOsc52 } from '../src/term/osc52'

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64')

describe('parseOsc52', () => {
  it('decodes a write as UTF-8', () => {
    expect(parseOsc52(`c;${b64('hello 52 你好')}`)).toEqual({ kind: 'write', text: 'hello 52 你好' })
  })
  it('ignores the selection name', () => {
    expect(parseOsc52(`;${b64('x')}`)).toEqual({ kind: 'write', text: 'x' })
    expect(parseOsc52(`pc;${b64('y')}`)).toEqual({ kind: 'write', text: 'y' })
  })
  it('recognizes a read', () => {
    expect(parseOsc52('c;?')).toEqual({ kind: 'read' })
  })
  it('ignores malformed payloads', () => {
    expect(parseOsc52('no-semicolon')).toBeNull()
    expect(parseOsc52('c;')).toBeNull()
    expect(parseOsc52('c;!!!not base64')).toBeNull()
  })
  it('ignores more than 1 MiB of decoded text', () => {
    expect(MAX_OSC52_BYTES).toBe(1 << 20)
    const big = 'a'.repeat(MAX_OSC52_BYTES + 1)
    expect(parseOsc52(`c;${b64(big)}`)).toBeNull()
    const ok = 'a'.repeat(MAX_OSC52_BYTES)
    expect(parseOsc52(`c;${b64(ok)}`)).toEqual({ kind: 'write', text: ok })
  })
})
