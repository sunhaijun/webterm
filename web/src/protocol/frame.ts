/**
 * 二进制数据帧的编解码 —— 协议 §3（v2）。
 *
 * 契约见 docs/30-protocol/websocket-protocol.md。这一侧与 Go 侧的
 * internal/protocol 必须严格对应，两边都跑 testdata/vectors.json。
 */

export const PROTOCOL_VERSION = 2

export const HEADER_SIZE = 12
export const MAX_PAYLOAD = 256 * 1024

export const TYPE_OUTPUT = 0x01 // agent → client
export const TYPE_INPUT = 0x02 // client → agent
export const TYPE_SNAPSHOT = 0x03 // agent → client

/**
 * SNAPSHOT 的 flags bit0：同一份快照后面还有帧（§3）。
 * 其余位、以及其它帧类型上的 bit0 都是保留位：发送方填 0，接收方忽略。
 */
export const FLAG_MORE = 0x01

export interface Frame {
  type: number
  flags: number
  sid: number
  /** OUTPUT / INPUT：本帧首字节的 seq；SNAPSHOT：这份快照对应的 out_seq。 */
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

/**
 * 解一帧。只校验帧本身（长度、类型）；方向对不对（agent 不该发 INPUT）
 * 由收的那一侧判断。
 */
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
  if (f.type !== TYPE_OUTPUT && f.type !== TYPE_INPUT && f.type !== TYPE_SNAPSHOT) {
    throw new BadFrameError(`未知的帧类型 ${f.type}`)
  }
  return f
}

/**
 * 本帧计入 seq 的字节数：OUTPUT / INPUT 是 payload 长度；SNAPSHOT 是 0 ——
 * 快照是 agent 生成的渲染指令，不是流内容（§3，不变式 ④）。
 *
 * 连续的 OUTPUT 帧必须满足 seq(n+1) === seq(n) + dataLen(n)。
 */
export function dataLen(f: Frame): number {
  return f.type === TYPE_SNAPSHOT ? 0 : f.payload.length
}

/** 这一帧之后同一份快照还有没有（只对 SNAPSHOT 有意义，别的类型上 bit0 是保留位）。 */
export function hasMore(f: Frame): boolean {
  return f.type === TYPE_SNAPSHOT && (f.flags & FLAG_MORE) !== 0
}
