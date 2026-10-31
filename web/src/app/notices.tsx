/**
 * 盖在终端上的提示（layout.md §盖在终端上的东西，session-ux.md §连接状态指示）：
 * 连接横幅、toast、组字预览。全部绝对定位，出现与消失都不改终端几何、不发 resize。
 * 进程结束提示行不在这里 —— 它直接写进终端（AC-4.5）。
 */
import type { ConnState, StateInfo } from '../conn/connection'
import type { ImePreviewState, Toast } from './controller'

/** `conn-text` 的文字。在线就是「在线」（RTT 进 wide 状态点的 title）。 */
export function connLabel(state: ConnState, info: StateInfo): string {
  switch (state) {
    case 'online':
      return '在线'
    case 'connecting':
      return '连接中…'
    case 'reconnecting':
      return info.retryInMs === undefined ? '重连中…' : `重连中 · ${Math.ceil(info.retryInMs / 1000)}s 后重试`
    case 'closed':
      return '已断开'
  }
}

/**
 * 连接横幅。`conn-text` **一直在 DOM 里**：在线时整条只是视觉隐藏，`aria-live` 照常播报，
 * E2E 的引用也不用变。致命错误（设备被吊销、协议不符）也走这条横幅。
 */
export function ConnBanner({ state, info, fatal }: { state: ConnState; info: StateInfo; fatal: string | null }) {
  const show = fatal !== null || state !== 'online'
  return (
    <div class={`conn-banner${show ? '' : ' sr-only'}`} data-state={fatal ? 'fatal' : state} data-testid="conn-banner">
      <span data-testid="conn-text" role="status" aria-live="polite">
        {connLabel(state, info)}
      </span>
      {fatal && (
        <span class="conn-fatal" data-testid="fatal">
          {fatal}
        </span>
      )}
    </div>
  )
}

export function ToastView({ toast }: { toast: Toast | null }) {
  if (!toast) return null
  return (
    <div class="toast" data-testid="toast" data-kind={toast.kind} key={toast.id} role="status">
      {toast.text}
    </div>
  )
}

/** 组字预览：跟着终端光标走，显示未提交的组字内容。 */
export function ImePreview({ preview }: { preview: ImePreviewState | null }) {
  if (!preview) return null
  return (
    <div class="ime-preview" data-testid="ime-preview" style={{ left: `${preview.left}px`, top: `${preview.top}px` }}>
      {preview.text}
    </div>
  )
}
