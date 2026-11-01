/**
 * Overlays on top of the terminal (layout.md, session-ux.md §Connection status): the
 * connection banner, toasts and the IME composition preview. All absolutely positioned;
 * showing or hiding them never changes terminal geometry or sends a resize. The
 * process-exited line is not here; it is written into the terminal (AC-4.5).
 */
import type { ConnState, StateInfo } from '../conn/connection'
import type { ImePreviewState, Toast } from './controller'

/** Text for `conn-text`. Online is just "Online"; the RTT goes in the wide status dot's title. */
export function connLabel(state: ConnState, info: StateInfo): string {
  switch (state) {
    case 'online':
      return 'Online'
    case 'connecting':
      return 'Connecting…'
    case 'reconnecting':
      return info.retryInMs === undefined ? 'Reconnecting…' : `Reconnecting · retry in ${Math.ceil(info.retryInMs / 1000)}s`
    case 'closed':
      return 'Disconnected'
  }
}

/**
 * Connection banner. `conn-text` is always in the DOM: when online the banner is only
 * visually hidden, so `aria-live` still announces and E2E locators stay valid. Fatal
 * errors (device revoked, protocol mismatch) also show here.
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

/** IME composition preview: follows the terminal cursor and shows the uncommitted text. */
export function ImePreview({ preview, fontSize }: { preview: ImePreviewState | null; fontSize: number }) {
  if (!preview) return null
  return (
    <div
      class="ime-preview"
      data-testid="ime-preview"
      style={{ left: `${preview.left}px`, top: `${preview.top}px`, fontSize: `${fontSize}px` }}
    >
      {preview.text}
    </div>
  )
}
