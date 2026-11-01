/** Small shared test helpers. */
import type { Terminal } from '@xterm/xterm'

import type { SessionInfo } from '../src/protocol/messages'

export function info(sid: number, patch: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sid,
    name: `s${sid}`,
    name_is_manual: false,
    cwd: '/tmp',
    status: 'running',
    exit_code: null,
    cols: 80,
    rows: 24,
    base_seq: 0,
    head_seq: 0,
    created_at: sid,
    ...patch,
  }
}

/** Waits until xterm has parsed every queued write (write callbacks fire in FIFO order). */
export function flush(term: Pick<Terminal, 'write'>): Promise<void> {
  return new Promise((r) => term.write('', () => r()))
}

/** One line's text, trailing whitespace trimmed. */
export function lineText(term: Terminal, y: number): string {
  return term.buffer.active.getLine(y)?.translateToString(true) ?? ''
}

/** Non-empty lines of the whole buffer, scrollback included. */
export function lines(term: Terminal): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let i = 0; i < buf.length; i++) {
    const t = buf.getLine(i)?.translateToString(true) ?? ''
    if (t !== '') out.push(t)
  }
  return out
}
