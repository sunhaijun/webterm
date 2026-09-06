/** 连接状态指示（AC-2.10 / session-ux.md）。 */
import type { ConnState, StateInfo } from '../conn/connection'

export interface StatusProps {
  state: ConnState
  info: StateInfo
  sessionName: string
  cwd: string
}

export function StatusBar({ state, info, sessionName, cwd }: StatusProps) {
  return (
    <div class="statusbar" data-state={state}>
      <span class="dot" data-state={state} data-testid="conn-dot" />
      <span class="name">{sessionName}</span>
      <span class="cwd">{cwd}</span>
      <span class="conn" data-testid="conn-text">
        {label(state, info)}
      </span>
    </div>
  )
}

function label(state: ConnState, info: StateInfo): string {
  switch (state) {
    case 'online':
      // RTT 高的时候才显示，平时不占地方
      return info.rttMs !== undefined && info.rttMs > 300 ? `在线 · ${info.rttMs}ms` : '在线'
    case 'connecting':
      return '连接中'
    case 'reconnecting': {
      const s = Math.ceil((info.retryInMs ?? 0) / 1000)
      return `重连中 · ${s}s 后重试`
    }
    case 'closed':
      return '已断开'
  }
}

/**
 * "已恢复 · 补齐 N KB" 的 toast。
 *
 * 这个数字看起来多余，但它让用户【确信没丢东西】—— 这是"永不断线"这个
 * 承诺的可见证据。
 */
export function RecoveredToast({ bytes }: { bytes: number }) {
  return (
    <div class="toast" data-testid="recovered-toast">
      已恢复 · 补齐 {formatBytes(bytes)}
    </div>
  )
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
