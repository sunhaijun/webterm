/**
 * 二进制数据帧的编解码 —— 协议 §3。
 *
 * 契约见 docs/30-protocol/websocket-protocol.md。这一侧与 Go 侧的
 * internal/protocol 必须严格对应，两边都跑 testdata/vectors.json。
 */

export const PROTOCOL_VERSION = 1

export const HEADER_SIZE = 12
export const MAX_PAYLOAD = 256 * 1024

export const TYPE_OUTPUT = 0x01 // agent → client
export const TYPE_INPUT = 0x02 // client → agent

/**
 * payload 的前 4 字节是 ATTR_PREFIX，属于渲染修正，【不计入 seq】。
 * 只出现在 reset 回放的第一帧上。
 */
export const FLAG_ATTR_PREFIX = 0x01

/** reset 回放前置的 SGR reset。这 4 个字节不计入 out_seq。 */
export const ATTR_PREFIX = new Uint8Array([0x1b, 0x5b, 0x30, 0x6d]) // ESC [ 0 m

export interface Frame {
  type: number
  flags: number
  sid: number
  seq: bigint
  payload: Uint8Array
}

export class BadFrameError extends Error {
  constructor(msg = 'bad frame') {
    super(msg)
    this.name = 'BadFrameError'
  }
}

export class FrameTooLargeError extends Error {
  constructor(msg = 'frame too large') {
    super(msg)
    this.name = 'FrameTooLargeError'
  }
}

/**
 * 本帧计入 seq 的字节数。带 ATTR_PREFIX 时前 4 字节不算。
 *
 * 连续的 OUTPUT 帧必须满足 seq(n+1) === seq(n) + dataLen(n)。
 */
export function dataLen(f: Frame): number {
  return f.payload.length - (f.flags & FLAG_ATTR_PREFIX ? ATTR_PREFIX.length : 0)
}

export function encodeFrame(f: Frame): Uint8Array {
  const out = new Uint8Array(HEADER_SIZE + f.payload.length)
  const view = new DataView(out.buffer)
  view.setUint8(0, f.type)
  view.setUint8(1, f.flags)
  view.setUint16(2, f.sid, false) // 大端
  view.setBigUint64(4, f.seq, false)
  out.set(f.payload, HEADER_SIZE)
  return out
}

export function decodeFrame(b: Uint8Array): Frame {
  // payload 长度为 0 的帧是非法的
  if (b.length < HEADER_SIZE + 1) throw new BadFrameError('长度不足')
  if (b.length - HEADER_SIZE > MAX_PAYLOAD) throw new FrameTooLargeError()

  const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const f: Frame = {
    type: view.getUint8(0),
    flags: view.getUint8(1),
    sid: view.getUint16(2, false),
    seq: view.getBigUint64(4, false),
    payload: b.subarray(HEADER_SIZE),
  }
  if (f.type !== TYPE_OUTPUT && f.type !== TYPE_INPUT) {
    throw new BadFrameError(`未知的帧类型 ${f.type}`)
  }
  // ATTR_PREFIX 只对 OUTPUT 有意义，且 payload 必须真的以它开头
  if (f.flags & FLAG_ATTR_PREFIX) {
    if (f.type !== TYPE_OUTPUT || f.payload.length < ATTR_PREFIX.length) {
      throw new BadFrameError('ATTR_PREFIX 用在了不该用的地方')
    }
    for (let i = 0; i < ATTR_PREFIX.length; i++) {
      if (f.payload[i] !== ATTR_PREFIX[i]) {
        throw new BadFrameError('置了 ATTR_PREFIX 但 payload 不是以 ESC[0m 开头')
      }
    }
  }
  return f
}

/** 去掉属性修正前缀，返回真正计入 seq 的那部分。 */
export function frameData(f: Frame): Uint8Array {
  return f.flags & FLAG_ATTR_PREFIX ? f.payload.subarray(ATTR_PREFIX.length) : f.payload
}
