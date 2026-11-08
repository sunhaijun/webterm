/**
 * The last key column's popovers and the command editor (input.md §History and commands,
 * ADR-0057):
 *
 * - `KeyMenus`: ⟲'s history list, or ⌘'s command strip (one row of chips scrolled
 *   sideways, ✎ fixed at its right end), just above the extra keys. Nothing in them takes
 *   focus, so the on-screen keyboard stays as it was.
 * - `CommandEditor`: a bottom sheet listing the tool's items: ≡ drags (the session
 *   drawer's drag, ADR-0040), 👁 hides or shows, a tap edits.
 * - `CommandItemSheet`: editing one item, or adding one, stacked over the editor.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'

import { historyRow, type CommandItem, type ItemForm, type Strip } from '../keys/commands'
import type { KeyMenu } from '../keys/extrakeys'
import { Drawer } from '../ui/drawer'
import { EditIcon, EyeIcon, EyeOffIcon, GripIcon, PencilIcon } from '../ui/icons'
import { capturePointer } from '../ui/pointer'
import { DragReorder } from '../ui/reorder'
import { useEscape } from './linkpop'

const GAP = 6
const noFocus = (e: Event) => e.preventDefault()

/** A mouse wheel over the strip scrolls it sideways. */
const sideways = (e: WheelEvent) => {
  const el = e.currentTarget as HTMLElement
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
  e.preventDefault()
  el.scrollLeft += e.deltaY
}

export interface KeyMenusProps {
  menu: KeyMenu | null
  /** History of the program in front; null while the first list loads. */
  history: string[] | null
  /** The command strip of the tool in front; null while it loads. */
  strip: Strip | null
  onSendHistory(i: number): void
  onInsertHistory(i: number): void
  onRun(id: string): void
  onEdit(): void
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
  }, [p.menu, p.history, p.strip])
  if (!p.menu) return null
  const style = top === null ? { visibility: 'hidden' } : { top: `${top}px` }
  return (
    <>
      <div class="km-backdrop" data-testid="menu-backdrop" onPointerDown={(e) => (e.preventDefault(), p.onClose())} />
      {p.menu === 'history' ? (
        <div class="km-menu" data-testid="history-menu" ref={box} style={style} onPointerDown={noFocus}>
          <HistoryRows items={p.history} onSend={p.onSendHistory} onInsert={p.onInsertHistory} />
        </div>
      ) : (
        <div class="km-strip" data-testid="command-strip" ref={box} style={style} onPointerDown={noFocus}>
          <div class="cs-scroll" onWheel={sideways}>
            {p.strip === null ? (
              <span class="cs-loading">…</span>
            ) : (
              p.strip.items
                .filter((it) => !it.hidden)
                .map((it) => (
                  <button type="button" key={it.id} class="cs-chip" data-testid={`command-${it.id}`} onPointerDown={noFocus} onClick={() => p.onRun(it.id)}>
                    {it.label}
                  </button>
                ))
            )}
          </div>
          <button type="button" class="cs-edit" data-testid="command-edit" aria-label="Edit commands" onPointerDown={noFocus} onClick={p.onEdit}>
            <PencilIcon />
          </button>
        </div>
      )}
    </>
  )
}

function HistoryRows(p: { items: string[] | null; onSend(i: number): void; onInsert(i: number): void }) {
  if (p.items === null) return null
  if (p.items.length === 0) {
    return (
      <div class="km-empty" data-testid="history-empty">
        No history
      </div>
    )
  }
  return (
    <>
      {p.items.map((text, i) => {
        const row = historyRow(text)
        return (
          <div class="km-row" key={`${i}:${text}`}>
            <button type="button" class="km-send" data-testid={`history-${i}`} title={text} onPointerDown={noFocus} onClick={() => p.onSend(i)}>
              <span class="km-text">{row.first}</span>
              {row.lines > 1 && <span class="km-lines">{row.lines} lines</span>}
            </button>
            <button type="button" class="km-insert" data-testid={`history-insert-${i}`} aria-label="Insert without sending" onPointerDown={noFocus} onClick={() => p.onInsert(i)}>
              <EditIcon />
            </button>
          </div>
        )
      })}
    </>
  )
}

/** What an editor row shows under the label: the text it sends, when that isn't obvious from the label. */
function rowDetail(it: CommandItem): string {
  if (it.kind !== 'text') return ''
  const text = it.send[0] ?? ''
  if (text === it.label && it.enter) return ''
  return `${historyRow(text).first}${it.enter ? ' ↵' : ''}`
}

/** Reset takes a second tap within this long. */
const ARM_MS = 3000

export interface CommandEditorProps {
  strip: Strip | null
  onMove(from: number, to: number): void
  onToggle(id: string): void
  onEditItem(id: string): void
  onAdd(): void
  onReset(): void
  onRefresh(): void
  onClose(): void
}

export function CommandEditor(p: CommandEditorProps) {
  const listRef = useRef<HTMLUListElement>(null)
  const grip = useRef<DragReorder | null>(null)
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), ARM_MS)
    return () => clearTimeout(t)
  }, [armed])
  const items = p.strip?.items ?? []

  const onGripDown = (e: PointerEvent, index: number) => {
    e.preventDefault()
    e.stopPropagation()
    const list = listRef.current
    if (!list) return
    grip.current?.finish(true)
    capturePointer(e.currentTarget as Element, e.pointerId)
    grip.current = new DragReorder({
      axis: 'y',
      scroller: list.closest<HTMLElement>('.drawer-body') ?? list,
      items: [...list.children] as HTMLElement[],
      order: items.map((_, i) => i),
      from: index,
      start: e.clientY,
    })
  }
  const onGripUp = (cancel: boolean) => {
    const r = grip.current?.finish(cancel)
    grip.current = null
    if (!r) return
    // `before` is an index in the old list; the moved item lands just in front of it
    const from = r.sid
    const to = r.before === null ? items.length - 1 : r.before < from ? r.before : r.before - 1
    p.onMove(from, to)
  }

  return (
    <Drawer
      title={p.strip ? `${p.strip.program} commands` : 'Commands'}
      testid="command-editor"
      backdropTestid="command-editor-backdrop"
      variant="sessions"
      backButton
      onClose={p.onClose}
      foot={
        <div class="drawer-actions">
          <button type="button" class="drawer-btn" data-testid="command-add" onClick={p.onAdd}>
            + Add
          </button>
          {p.strip?.program === 'claude' && (
            <button type="button" class="drawer-btn" data-testid="command-refresh" onClick={p.onRefresh}>
              Refresh
            </button>
          )}
          <button
            type="button"
            class={armed ? 'drawer-btn danger' : 'drawer-btn'}
            data-testid="command-reset"
            data-armed={armed ? 'true' : 'false'}
            onClick={() => {
              if (!armed) return setArmed(true)
              setArmed(false)
              p.onReset()
            }}
          >
            {armed ? 'Reset all?' : 'Reset'}
          </button>
        </div>
      }
    >
      {p.strip?.warning && (
        <p class="ce-warning" data-testid="command-warning">
          {p.strip.warning}
        </p>
      )}
      <ul class="ce-list" ref={listRef}>
        {items.map((it, i) => {
          const detail = rowDetail(it)
          return (
            <li key={it.id} class="ce-item" data-hidden={it.hidden ? 'true' : 'false'}>
              <div
                class="ce-row"
                role="button"
                tabIndex={0}
                data-testid={`command-row-${i}`}
                data-id={it.id}
                onClick={() => p.onEditItem(it.id)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
                  e.preventDefault()
                  p.onEditItem(it.id)
                }}
              >
                <span class="ce-text">
                  <span class="ce-label">{it.label}</span>
                  {detail && <span class="ce-detail">{detail}</span>}
                </span>
                <button
                  type="button"
                  class="ce-eye"
                  data-testid={`command-eye-${i}`}
                  aria-label={it.hidden ? 'Show' : 'Hide'}
                  aria-pressed={it.hidden ? 'false' : 'true'}
                  onClick={(e) => {
                    e.stopPropagation()
                    p.onToggle(it.id)
                  }}
                >
                  {it.hidden ? <EyeOffIcon /> : <EyeIcon />}
                </button>
                <span
                  class="row-grip"
                  data-testid={`command-grip-${i}`}
                  aria-label="Drag to reorder"
                  onPointerDown={(e) => onGripDown(e, i)}
                  onPointerMove={(e) => grip.current?.move(e.clientY)}
                  onPointerUp={() => onGripUp(false)}
                  onPointerCancel={() => onGripUp(true)}
                  onClick={(e) => e.stopPropagation()}
                >
                  <GripIcon />
                </span>
              </div>
            </li>
          )
        })}
      </ul>
    </Drawer>
  )
}

export interface CommandItemSheetProps {
  /** The item being edited; null adds a new text item. */
  item: CommandItem | null
  onSave(f: ItemForm): void
  /** Only for items you added. */
  onDelete?(): void
  onCancel(): void
}

export function CommandItemSheet({ item, onSave, onDelete, onCancel }: CommandItemSheetProps) {
  const labelRef = useRef<HTMLInputElement>(null)
  const sendRef = useRef<HTMLTextAreaElement>(null)
  const isText = item === null || item.kind === 'text'
  const [enter, setEnter] = useState(item?.enter ?? true)
  const [canSave, setCanSave] = useState(item !== null)
  useLayoutEffect(() => {
    for (const el of [labelRef.current, sendRef.current]) {
      if (!el) continue
      el.setAttribute('autocorrect', 'off')
      el.setAttribute('autocapitalize', 'off')
      el.setAttribute('spellcheck', 'false')
    }
    if (labelRef.current) labelRef.current.value = item?.label ?? ''
    if (sendRef.current) sendRef.current.value = item?.send[0] ?? ''
    const first = item === null ? sendRef.current : labelRef.current
    first?.focus({ preventScroll: true })
  }, [])
  const save = () => {
    const send = sendRef.current?.value ?? ''
    if (item === null && send === '') return
    onSave({ label: labelRef.current?.value ?? '', send, enter })
  }
  return (
    <Drawer
      title={item ? 'Edit' : 'Add'}
      testid="command-form"
      backdropTestid="command-form-backdrop"
      variant="rename"
      onClose={onCancel}
      foot={
        <div class="drawer-actions">
          {onDelete && (
            <button type="button" class="drawer-btn danger" data-testid="command-form-delete" onClick={onDelete}>
              Delete
            </button>
          )}
          <button type="button" class="drawer-btn" data-testid="command-form-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" class="drawer-btn primary" data-testid="command-form-save" disabled={!canSave} onClick={save}>
            Save
          </button>
        </div>
      }
    >
      <div class="ce-form">
        {isText && (
          <textarea
            ref={sendRef}
            class="ce-send"
            data-testid="command-form-send"
            rows={3}
            maxLength={32 << 10}
            aria-label="Text to send"
            placeholder="Text"
            onInput={(e) => item === null && setCanSave((e.currentTarget as HTMLTextAreaElement).value !== '')}
          />
        )}
        <input
          ref={labelRef}
          class="rename-sheet-input"
          data-testid="command-form-label"
          type="text"
          autocomplete="off"
          maxLength={200}
          aria-label="Label"
          placeholder="Label"
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return
            e.preventDefault()
            save()
          }}
        />
        {isText && (
          <label class="ce-enter">
            <input type="checkbox" data-testid="command-form-enter" checked={enter} onChange={(e) => setEnter((e.currentTarget as HTMLInputElement).checked)} />
            Press Enter
          </label>
        )}
      </div>
    </Drawer>
  )
}
