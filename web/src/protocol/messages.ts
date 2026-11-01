/** Control message types and error codes (protocol §4 / §7, v2). */

export const T = {
  hello: 'hello',
  sessionCreate: 'session.create',
  sessionClose: 'session.close',
  sessionRename: 'session.rename',
  sessionMove: 'session.move',
  subscribe: 'subscribe',
  unsubscribe: 'unsubscribe',
  resize: 'resize',
  ping: 'ping',

  welcome: 'welcome',
  sessionCreated: 'session.created',
  sessionClosed: 'session.closed',
  sessionUpdated: 'session.updated',
  sessionOrder: 'session.order',
  ack: 'ack',
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
/** `resumed[].status` (§4.2): delta / snapshot / session no longer exists. */
export type ResumeStatus = 'ok' | 'snapshot' | 'gone'

export interface ResumeReq {
  sid: number
  out_seq: number
}

export interface Hello {
  t: 'hello'
  protocol: number
  client_id: string
  instance_id?: string | null
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
  /** The agent user's home directory; the UI abbreviates it to `~` in CWDs (§4.2). Older agents omit it. */
  home?: string
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

/** Only the changed fields plus sid; the client merges them in. */
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
  head_seq?: number
}

/** The full display order, broadcast after session.move (§4.2, ADR-0040). */
export interface SessionOrder {
  t: 'session.order'
  req_id?: string
  sids: number[]
}

export interface Ack {
  t: 'ack'
  sid: number
  in_ack: number
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

/** All agent → client control messages. */
export type ServerMessage =
  | Welcome
  | SessionCreated
  | SessionClosed
  | SessionUpdated
  | SessionOrder
  | Ack
  | Pong
  | ErrorMsg
  | Notice

const KNOWN: ReadonlySet<string> = new Set(Object.values(T))

/**
 * Parses a control message.
 *
 * Unknown t values return null; callers must ignore them rather than close the connection
 * (protocol §4, forward compatibility).
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
