/**
 * The link popover (Open · Copy) and the Copy bar for OSC 52 (input.md §Links, §Clipboard
 * from programs; ADR-0053 §3–§4).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'

import { shortUrl } from '../term/links'

export interface LinkPop {
  url: string
  /** Viewport point of the tap. */
  x: number
  y: number
}

export interface ClipOffer {
  id: number
  text: string
}

/**
 * Escape closes the popover while it's open, and goes no further: captured before xterm sees
 * it, so dismissing doesn't also interrupt the program.
 */
function useEscape(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, close])
}

const MARGIN = 8
const GAP = 12

export function LinkPopover(p: { pop: LinkPop | null; onOpen(): void; onCopy(): void; onClose(): void }) {
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useEscape(p.pop !== null, p.onClose)
  // Above the finger when there's room, else below; kept inside the viewport
  useLayoutEffect(() => {
    const el = box.current
    if (!p.pop || !el) return setPos(null)
    const w = el.offsetWidth
    const h = el.offsetHeight
    const vw = window.innerWidth
    const left = Math.min(Math.max(p.pop.x - w / 2, MARGIN), Math.max(vw - w - MARGIN, MARGIN))
    const top = p.pop.y - GAP - h >= MARGIN ? p.pop.y - GAP - h : p.pop.y + GAP
    setPos({ left, top })
  }, [p.pop])
  if (!p.pop) return null
  return (
    <>
      <div class="link-backdrop" data-testid="link-backdrop" onPointerDown={p.onClose} />
      <div
        class="link-popover"
        data-testid="link-popover"
        role="dialog"
        ref={box}
        style={pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : { visibility: 'hidden' }}
      >
        <div class="link-url" data-testid="link-url" title={p.pop.url}>
          {shortUrl(p.pop.url)}
        </div>
        <div class="link-actions">
          <button type="button" data-testid="link-open" onClick={p.onOpen}>
            Open
          </button>
          <button type="button" data-testid="link-copy" onClick={p.onCopy}>
            Copy
          </button>
        </div>
      </div>
    </>
  )
}

/**
 * No Escape here: the bar stays up to 30 s while you keep working, and Escape belongs to the
 * program (claude interrupts on it).
 */
export function ClipBar(p: { offer: ClipOffer | null; onCopy(): void; onClose(): void }) {
  if (!p.offer) return null
  const first = p.offer.text.split('\n', 1)[0] ?? ''
  return (
    <div class="clip-bar" data-testid="clip-bar" role="status" key={p.offer.id}>
      <span class="clip-text">{first}</span>
      <button type="button" class="clip-copy" data-testid="clip-copy" onClick={p.onCopy}>
        Copy
      </button>
      <button type="button" class="clip-close" data-testid="clip-close" aria-label="Close" onClick={p.onClose}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" />
        </svg>
      </button>
    </div>
  )
}
