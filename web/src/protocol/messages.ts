/** 控制消息类型与错误码 —— 协议 §4 / §7。 */

export const T = {
  hello: 'hello',
  sessionCreate: 'session.create',
  sessionClose: 'session.close',
  sessionRename: 'session.rename',
  subscribe: 'subscribe',
  unsubscribe: 'unsubscribe',
  resize: 'resize',
  ping: 'ping',

  welcome: 'welcome',
  sessionCreated: 'session.created',
  sessionClosed: 'session.closed',
  sessionUpdated: 'session.updated',
  ack: 'ack',
  reset: 'reset',
  cwd: 'cwd',
  prompt: 'prompt',
  commandStart: 'command.start',
  commandEnd: 'command.end',
  pong: 'pong',
  error: 'error',
  notice: 'notice',
} as const

export const Code = {
  expectedHello: 'expected_hello',
  protocolUnsupported: 'protocol_unsupported',
  badFrame: 'bad_frame',
  frameTooLarge: 'frame_too_large',
  inputGap: 'input_gap',
  inputStalled: 'input_stalled',
  unauthorized: 'unauthorized',
  unknownSession: 'unknown_session',
  sessionExited: 'session_exited',
  sessionLimit: 'session_limit',
  badRequest: 'bad_request',
  internal: 'internal',
} as const

export type SessionStatus = 'running' | 'exited'
export type Integration = 'pending' | 'active' | 'inactive'
export type PromptState = 'input' | 'running' | 'done'
export type ResumeStatus = 'ok' | 'reset' | 'gone'

export interface ResumeReq {
  sid: number
  out_seq: number
}

export interface Hello {
  t: 'hello'
  protocol: number
  client_id: string
  instance_id?: string
  resume: ResumeReq[]
}

export interface SessionInfo {
  sid: number
  name: string
  name_is_manual: boolean
  cwd: string
  status: SessionStatus
  exit_code: number | null
  cols: number
  rows: number
  integration: Integration
  /**
   * 重连时用来重新对齐输入模式（协议 §4.2）。
   *
   * prompt 消息只在状态变化时发一次，离线期间的那些就丢了 —— 断线跨过
   * 命令边界的话，客户端会停在 Raw、Composer 收起，用户连字都打不了。
   */
  prompt_state: PromptState | null
  base_seq: number
  head_seq: number
  created_at: number
}

export interface ResumeResult {
  sid: number
  status: ResumeStatus
  from_seq: number
  in_ack: number
}

export interface Welcome {
  t: 'welcome'
  protocol: number
  server_version: string
  instance_id: string
  limits: { max_sessions: number; ring_bytes: number; max_frame_bytes: number }
  sessions: SessionInfo[]
  resumed: ResumeResult[]
}

export interface SessionCreated {
  t: 'session.created'
  req_id?: string
  session: SessionInfo
}

export interface SessionClosed {
  t: 'session.closed'
  req_id?: string
  sid: number
  exit_code: number | null
}

/** 只包含发生变化的字段 + sid，client 做增量合并。 */
export interface SessionUpdated {
  t: 'session.updated'
  sid: number
  name?: string
  name_is_manual?: boolean
  cwd?: string
  status?: SessionStatus
  exit_code?: number | null
  cols?: number
  rows?: number
  integration?: Integration
  head_seq?: number
}

export interface Ack {
  t: 'ack'
  sid: number
  in_ack: number
}
export interface ResetMsg {
  t: 'reset'
  sid: number
  base_seq: number
}
export interface Cwd {
  t: 'cwd'
  sid: number
  path: string
}
export interface Prompt {
  t: 'prompt'
  sid: number
  state: PromptState
}
export interface CommandStart {
  t: 'command.start'
  sid: number
  cmd_id: number
  text: string
  cwd: string
  at: number
  out_seq: number
}
export interface CommandEnd {
  t: 'command.end'
  sid: number
  cmd_id: number
  exit_code: number | null
  duration_ms: number
  out_seq: number
}
export interface Pong {
  t: 'pong'
  ts: number
}
export interface ErrorMsg {
  t: 'error'
  req_id?: string
  sid?: number
  code: string
  message: string
}
export interface Notice {
  t: 'notice'
  level: 'info' | 'warn' | 'error'
  message: string
}

/** agent → client 的全部控制消息。 */
export type ServerMessage =
  | Welcome
  | SessionCreated
  | SessionClosed
  | SessionUpdated
  | Ack
  | ResetMsg
  | Cwd
  | Prompt
  | CommandStart
  | CommandEnd
  | Pong
  | ErrorMsg
  | Notice

const KNOWN: ReadonlySet<string> = new Set(Object.values(T))

/**
 * 解析一条控制消息。
 *
 * 未知的 t 值返回 null —— 调用方【必须忽略】而不是关连接（协议 §4，前向兼容）。
 */
export function decodeMessage(text: string): ServerMessage | null {
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof obj !== 'object' || obj === null) return null
  const t = (obj as { t?: unknown }).t
  if (typeof t !== 'string' || !KNOWN.has(t)) return null
  return obj as ServerMessage
}

export function encodeMessage(msg: object): string {
  return JSON.stringify(msg)
}
