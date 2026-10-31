/** 测试共用的小工具。 */
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

/** 等 xterm 把之前排下的 write 全部解析完（write 回调按 FIFO 触发）。 */
export function flush(term: Pick<Terminal, 'write'>): Promise<void> {
  return new Promise((r) => term.write('', () => r()))
}

/** 某一行的文本（去掉行尾空白）。 */
export function lineText(term: Terminal, y: number): string {
  return term.buffer.active.getLine(y)?.translateToString(true) ?? ''
}

/** 整个缓冲区（含 scrollback）的非空行。 */
export function lines(term: Terminal): string[] {
  const buf = term.buffer.active
  const out: string[] = []
  for (let i = 0; i < buf.length; i++) {
    const t = buf.getLine(i)?.translateToString(true) ?? ''
    if (t !== '') out.push(t)
  }
  return out
}
