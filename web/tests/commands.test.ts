/**
 * UT-strip-1 (AC-3.25, ADR-0057): parsing /api/commands, and the changes the editor makes
 * to an arrangement before sending it back whole.
 */
import { describe, expect, it } from 'vitest'

import {
  addItem,
  defaultLabel,
  editItem,
  firstLine,
  hasStrip,
  moveItem,
  newItemId,
  parseStrip,
  removeItem,
  setHidden,
  type Strip,
} from '../src/keys/commands'

const body = {
  program: 'claude',
  items: [
    { id: 'key:shift-tab', label: '⇧Tab Mode', kind: 'keys', send: ['\x1b[Z'], enter: false, origin: 'key', hidden: false },
    { id: '/compact', label: '/compact', kind: 'text', send: ['/compact'], enter: true, origin: 'builtin', hidden: false },
    { id: '/deep-research', label: '/deep-research', kind: 'text', send: ['/deep-research'], enter: true, origin: 'skill', hidden: true },
    { id: 'add:1', label: 'go on', kind: 'text', send: ['continue'], enter: true, origin: 'added', hidden: false },
  ],
  arrangement: { added: [{ id: 'add:1', label: 'go on', send: 'continue', enter: true }] },
  warning: '',
}
const strip = (): Strip => parseStrip(structuredClone(body))!

describe('parseStrip', () => {
  it('reads items in order and the arrangement', () => {
    const s = strip()
    expect(s.program).toBe('claude')
    expect(s.items.map((x) => x.id)).toEqual(['key:shift-tab', '/compact', '/deep-research', 'add:1'])
    expect(s.items[2]!.hidden).toBe(true)
    expect(s.items[0]!.kind).toBe('keys')
    expect(s.arrangement.added).toHaveLength(1)
  })
  it('no strip for other programs or a broken body', () => {
    expect(parseStrip({ program: 'shell', items: [] })).toBeNull()
    expect(parseStrip(null)).toBeNull()
    expect(parseStrip('x')).toBeNull()
  })
  it('drops malformed items', () => {
    const s = parseStrip({ program: 'codex', items: [{ id: 1 }, { id: 'x', label: 'x', send: [] }, { id: '/new', label: '/new', send: ['/new'] }] })!
    expect(s.items.map((x) => x.id)).toEqual(['/new'])
    expect(s.arrangement).toEqual({})
  })
  it('only claude and codex have one', () => {
    expect(hasStrip('claude')).toBe(true)
    expect(hasStrip('codex')).toBe(true)
    expect(hasStrip('shell')).toBe(false)
    expect(hasStrip('other')).toBe(false)
  })
})

describe('editor changes', () => {
  it('a move stores every id in the new order', () => {
    const s = moveItem(strip(), 1, 0)
    expect(s.items.map((x) => x.id)).toEqual(['/compact', 'key:shift-tab', '/deep-research', 'add:1'])
    expect(s.arrangement.order).toEqual(['/compact', 'key:shift-tab', '/deep-research', 'add:1'])
    const end = moveItem(strip(), 0, 3)
    expect(end.items.map((x) => x.id)).toEqual(['/compact', '/deep-research', 'add:1', 'key:shift-tab'])
  })
  it('hide and show override the defaults', () => {
    const s = setHidden(setHidden(strip(), 'key:shift-tab', true), '/deep-research', false)
    expect(s.items.find((x) => x.id === 'key:shift-tab')!.hidden).toBe(true)
    expect(s.arrangement.visible).toEqual({ 'key:shift-tab': false, '/deep-research': true })
  })
  it('editing a built-in goes into edits; a key only keeps its label', () => {
    const s = strip()
    const a = editItem(s, s.items[1]!, { label: '压缩', send: '/compact', enter: true })
    expect(a.edits).toEqual({ '/compact': { label: '压缩', send: '/compact', enter: true } })
    const k = editItem(s, s.items[0]!, { label: 'Mode', send: 'ignored', enter: true })
    expect(k.edits).toEqual({ 'key:shift-tab': { label: 'Mode' } })
  })
  it('editing an added item rewrites it in place', () => {
    const s = strip()
    const a = editItem(s, s.items[3]!, { label: '', send: 'keep going', enter: false })
    expect(a.added).toEqual([{ id: 'add:1', label: 'keep going', send: 'keep going', enter: false }])
    expect(a.edits).toBeUndefined()
  })
  it('adding appends a text item; its label defaults to the first line', () => {
    const a = addItem(strip(), { label: ' ', send: '\n继续\nmore', enter: true }, 'add:2')
    expect(a.added!.map((x) => x.id)).toEqual(['add:1', 'add:2'])
    expect(a.added![1]).toEqual({ id: 'add:2', label: '继续', send: '\n继续\nmore', enter: true })
    expect(defaultLabel('x'.repeat(40))).toBe(`${'x'.repeat(23)}…`)
  })
  it('deleting an added item removes every trace', () => {
    let s = moveItem(strip(), 3, 0)
    s = setHidden(s, 'add:1', true)
    const a = removeItem(s, 'add:1')
    expect(a.added).toEqual([])
    expect(a.order).not.toContain('add:1')
    expect(a.visible).toEqual({})
  })
  it('new ids look like add:…', () => {
    expect(newItemId(0, 0)).toBe('add:00')
    expect(newItemId(1_700_000_000_000, 0.5)).toMatch(/^add:[0-9a-z]+$/)
  })
})

describe('firstLine', () => {
  it('the first non-blank line', () => {
    expect(firstLine('one')).toBe('one')
    expect(firstLine('first\nsecond')).toBe('first')
    expect(firstLine('\n  \nreal\n')).toBe('real')
    expect(firstLine('')).toBe('')
  })
})
