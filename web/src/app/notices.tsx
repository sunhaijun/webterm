/**
 * Overlays on top of the terminal (layout.md, session-ux.md §Connection status): the
 * connection banner, toasts and the IME composition preview. All absolutely positioned;
 * showing or hiding them never changes terminal geometry or sends a resize. The
 * process-exited line is not here; it is written into the terminal (AC-4.5).
 */
import type { ConnState, StateInfo } from '../conn/connection'
import type { ConnNote, ImePreviewState, Toast } from './controller'

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
 * Connection banner, the one place for connection messages (ADR-0049). `conn-text` is
 * always in the DOM: when online it is only visually hidden, so `aria-live` still
 * announces and E2E locators stay valid. A note (resumed, session ended, refused offline)
 * shows next to the state, or alone once online. Fatal errors (device revoked, protocol
 * mismatch) also show here.
 */
export function ConnBanner({
  state,
  info,
  fatal,
  note = null,
}: {
  state: ConnState
  info: StateInfo
  fatal: string | null
  note?: ConnNote | null
}) {
  const quiet = fatal === null && state === 'online'
  const show = !quiet || note !== null
  return (
    <div
      class={`conn-banner${show ? '' : ' sr-only'}`}
      data-state={fatal ? 'fatal' : state}
      data-note={note?.kind}
      data-testid="conn-banner"
    >
      <span data-testid="conn-text" role="status" aria-live="polite" class={quiet ? 'sr-only' : undefined}>
        {connLabel(state, info)}
      </span>
      {note && (
        <span class="conn-note" data-testid="conn-note" role="status" aria-live="polite" key={note.id}>
          {note.text}
        </span>
      )}
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
