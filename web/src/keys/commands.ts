/**
 * The command strip and the history list (input.md §History and commands, ADR-0057): the
 * shapes `/api/commands` and `/api/history` return, and the pure changes the editor makes
 * to an arrangement before sending it back whole (http-api.md §Commands).
 */
import type { Program } from '../protocol/messages'

/** Writes of a keys item more than one apart are this far apart (Esc Esc reads as a double tap). */
export const KEY_GAP_MS = 120

export type StripProgram = 'claude' | 'codex'

/** Only claude and codex have a strip (ADR-0057 §2). */
export function hasStrip(program: Program): program is StripProgram {
  return program === 'claude' || program === 'codex'
}

export interface CommandItem {
  id: string
  label: string
  kind: 'keys' | 'text'
  /** keys: byte strings written KEY_GAP_MS apart; text: one string. */
  send: string[]
  /** text: press Enter after pasting. */
  enter: boolean
  origin: 'key' | 'builtin' | 'custom' | 'skill' | 'added'
  hidden: boolean
}

export interface ItemEdit {
  label?: string
  send?: string
  enter?: boolean
}

export interface AddedItem {
  id: string
  label: string
  send: string
  enter: boolean
}

/** The user's changes to one tool's list, as PUT /api/commands takes it. */
export interface Arrangement {
  order?: string[]
  visible?: Record<string, boolean>
  edits?: Record<string, ItemEdit>
  added?: AddedItem[]
}

export interface Strip {
  program: StripProgram
  /** In the strip's order, hidden ones included (the editor lists them). */
  items: CommandItem[]
  arrangement: Arrangement
  /** Why claude's built-in commands are missing, if they are. */
  warning: string
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const strs = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [])

/** GET /api/commands → a Strip, or null when the program has none (or the body is wrong). */
export function parseStrip(body: unknown): Strip | null {
  if (!isObj(body) || (body.program !== 'claude' && body.program !== 'codex')) return null
  const items: CommandItem[] = []
  for (const x of Array.isArray(body.items) ? body.items : []) {
    if (!isObj(x) || typeof x.id !== 'string' || typeof x.label !== 'string') continue
    const kind = x.kind === 'keys' ? 'keys' : 'text'
    const send = strs(x.send)
    if (send.length === 0) continue
    items.push({
      id: x.id,
      label: x.label,
      kind,
      send,
      enter: x.enter === true,
      origin: (['key', 'builtin', 'custom', 'skill', 'added'] as const).find((o) => o === x.origin) ?? 'builtin',
      hidden: x.hidden === true,
    })
  }
  return {
    program: body.program,
    items,
    arrangement: isObj(body.arrangement) ? (body.arrangement as Arrangement) : {},
    warning: typeof body.warning === 'string' ? body.warning : '',
  }
}

/** Moves the item at `from` to index `to` (its index after the move): the order becomes every id as shown. */
export function moveItem(s: Strip, from: number, to: number): Strip {
  const items = [...s.items]
  const [it] = items.splice(from, 1)
  if (!it) return s
  items.splice(Math.max(0, Math.min(to, items.length)), 0, it)
  return { ...s, items, arrangement: { ...s.arrangement, order: items.map((x) => x.id) } }
}

/** 👁: hide or show one item. */
export function setHidden(s: Strip, id: string, hidden: boolean): Strip {
  return {
    ...s,
    items: s.items.map((x) => (x.id === id ? { ...x, hidden } : x)),
    arrangement: { ...s.arrangement, visible: { ...s.arrangement.visible, [id]: !hidden } },
  }
}

/** The editor's form values; send and enter only apply to text items. */
export interface ItemForm {
  label: string
  send: string
  enter: boolean
}

/** A label for an added item left without one: its text's first line, shortened. */
export function defaultLabel(send: string): string {
  const first = send.split('\n').find((l) => l.trim() !== '')?.trim() ?? ''
  return first.length > 24 ? `${first.slice(0, 23)}…` : first
}

/**
 * Saves the form for an item. An added item is rewritten in place; anything else gets an
 * entry in `edits` (a blank label or text means "the default"). Returns the arrangement to
 * PUT; the merged list comes back from the agent.
 */
export function editItem(s: Strip, item: CommandItem, f: ItemForm): Arrangement {
  const a = s.arrangement
  if (item.origin === 'added') {
    const send = f.send === '' ? (item.send[0] ?? '') : f.send
    const label = f.label.trim() || defaultLabel(send)
    return { ...a, added: (a.added ?? []).map((x) => (x.id === item.id ? { ...x, label, send, enter: f.enter } : x)) }
  }
  const edit: ItemEdit = { label: f.label.trim() }
  if (item.kind === 'text') {
    edit.send = f.send
    edit.enter = f.enter
  }
  return { ...a, edits: { ...a.edits, [item.id]: edit } }
}

/** + Add: a new text item, at the end. */
export function addItem(s: Strip, f: ItemForm, id: string): Arrangement {
  const a = s.arrangement
  const item: AddedItem = { id, label: f.label.trim() || defaultLabel(f.send), send: f.send, enter: f.enter }
  return { ...a, added: [...(a.added ?? []), item] }
}

/** Deletes an added item and every trace of it. */
export function removeItem(s: Strip, id: string): Arrangement {
  const a = s.arrangement
  const visible = { ...a.visible }
  const edits = { ...a.edits }
  delete visible[id]
  delete edits[id]
  return {
    ...a,
    order: a.order?.filter((x) => x !== id),
    visible,
    edits,
    added: (a.added ?? []).filter((x) => x.id !== id),
  }
}

/** An id for a new item: unique enough within one tool's list. */
export function newItemId(now = Date.now(), rand = Math.random()): string {
  return `add:${now.toString(36)}${Math.floor(rand * 1296).toString(36)}`
}

/** A history row: the first non-blank line, and how many lines there are. */
export function historyRow(text: string): { first: string; lines: number } {
  const lines = text.split('\n')
  const first = lines.find((l) => l.trim() !== '') ?? ''
  return { first, lines: lines.length }
}
