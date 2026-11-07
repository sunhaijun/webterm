/**
 * The frequent-input and combo-key menus (input.md §Frequent input and combo keys,
 * ADR-0054 §4): a popover just above the extra keys. Nothing in it takes focus, so the
 * on-screen keyboard stays as it was.
 */
import { useLayoutEffect, useRef, useState } from 'preact/hooks'

import type { Combo } from '../keys/combos'
import type { KeyMenu } from '../keys/extrakeys'
import { EditIcon } from '../ui/icons'
import { useEscape } from './linkpop'

const GAP = 6
const noFocus = (e: Event) => e.preventDefault()

export interface KeyMenusProps {
  menu: KeyMenu | null
  /** Frequent input for the program in front; null while the first list loads. */
  frequent: string[] | null
  combos: Combo[]
  onSend(i: number): void
  onInsert(i: number): void
  onCombo(id: string): void
  onClose(): void
}

export function KeyMenus(p: KeyMenusProps) {
  const box = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState<number | null>(null)
  useEscape(p.menu !== null, p.onClose)
  // Sits right above the extra keys, wherever the on-screen keyboard has put them
  useLayoutEffect(() => {
    const el = box.current
    const keys = document.querySelector<HTMLElement>('[data-testid="extrakeys"]')
    if (!p.menu || !el || !keys) return setTop(null)
    setTop(Math.max(keys.getBoundingClientRect().top - el.offsetHeight - GAP, GAP))
  }, [p.menu, p.frequent, p.combos])
  if (!p.menu) return null
  return (
    <>
      <div class="km-backdrop" data-testid="menu-backdrop" onPointerDown={(e) => (e.preventDefault(), p.onClose())} />
      <div
        class="km-menu"
        data-testid={p.menu === 'frequent' ? 'frequent-menu' : 'combo-menu'}
        ref={box}
        style={top === null ? { visibility: 'hidden' } : { top: `${top}px` }}
        onPointerDown={noFocus}
      >
        {p.menu === 'frequent' ? (
          <FrequentRows items={p.frequent} onSend={p.onSend} onInsert={p.onInsert} />
        ) : (
          <div class="km-grid">
            {p.combos.map((c) => (
              <button type="button" key={c.id} class="km-tile" data-testid={`combo-${c.id}`} onPointerDown={noFocus} onClick={() => p.onCombo(c.id)}>
                <span class="km-key">{c.key}</span>
                <span class="km-label">{c.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

function FrequentRows(p: { items: string[] | null; onSend(i: number): void; onInsert(i: number): void }) {
  if (p.items === null) return null
  if (p.items.length === 0) {
    return (
      <div class="km-empty" data-testid="frequent-empty">
        No history
      </div>
    )
  }
  return (
    <>
      {p.items.map((text, i) => (
        <div class="km-row" key={`${i}:${text}`}>
          <button type="button" class="km-send" data-testid={`frequent-${i}`} title={text} onPointerDown={noFocus} onClick={() => p.onSend(i)}>
            {text}
          </button>
          <button type="button" class="km-insert" data-testid={`frequent-insert-${i}`} aria-label="Insert without sending" onPointerDown={noFocus} onClick={() => p.onInsert(i)}>
            <EditIcon />
          </button>
        </div>
      ))}
    </>
  )
}
