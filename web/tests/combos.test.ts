/**
 * UT-combos-1 (AC-3.25, ADR-0054 §4): the combo tiles for each program and their bytes.
 */
import { describe, expect, it } from 'vitest'

import { combosFor } from '../src/keys/combos'

const bytes = (p: string, id: string) => combosFor(p).find((c) => c.id === id)?.send

describe('combosFor', () => {
  it('claude: the keys a phone cannot type', () => {
    expect(combosFor('claude').map((c) => c.id)).toEqual(['shift-tab', 'esc-esc', 'ctrl-o', 'ctrl-t', 'ctrl-b', 'ctrl-r', 'alt-p', 'ctrl-c'])
    expect(bytes('claude', 'shift-tab')).toEqual(['\x1b[Z'])
    expect(bytes('claude', 'esc-esc'), 'two separate writes').toEqual(['\x1b', '\x1b'])
    expect(bytes('claude', 'ctrl-o')).toEqual(['\x0f'])
    expect(bytes('claude', 'alt-p')).toEqual(['\x1bp'])
  })
  it('codex', () => {
    expect(combosFor('codex').map((c) => c.id)).toEqual(['esc', 'esc-esc', 'ctrl-t', 'ctrl-j', 'ctrl-l', 'ctrl-c'])
    expect(bytes('codex', 'ctrl-j')).toEqual(['\n'])
  })
  it('shell', () => {
    expect(combosFor('shell').map((c) => c.id)).toEqual(['enter', 'ctrl-c', 'ctrl-d', 'ctrl-r', 'ctrl-l', 'ctrl-z', 'ctrl-w', 'ctrl-u'])
    expect(bytes('shell', 'enter')).toEqual(['\r'])
    expect(bytes('shell', 'ctrl-c')).toEqual(['\x03'])
  })
  it('other, unknown and missing fall back to the generic set', () => {
    const ids = ['enter', 'esc', 'ctrl-c', 'ctrl-d', 'ctrl-z', 'ctrl-l']
    expect(combosFor('other').map((c) => c.id)).toEqual(ids)
    expect(combosFor('vim').map((c) => c.id)).toEqual(ids)
    expect(combosFor(undefined).map((c) => c.id)).toEqual(ids)
  })
  it('every tile has a key, a label and something to send', () => {
    for (const p of ['claude', 'codex', 'shell', 'other']) {
      for (const c of combosFor(p)) {
        expect(c.key && c.label && c.send.length > 0 && c.send.every((s) => s.length > 0), `${p}/${c.id}`).toBeTruthy()
      }
    }
  })
})
