/** UT-keymap-1 / UT-keys-1: keys to bytes, extra keys, sticky modifiers and app shortcuts, checked against docs/40-frontend/keymap.md. */
import { describe, expect, it } from 'vitest'

import {
  EXTRA_KEYS,
  KEY_BYTES,
  NO_MODS,
  Sticky,
  appAction,
  chord,
  cursorKey,
  extraKeyBytes,
  isModifierKey,
  type ExtraKeyId,
} from '../src/keys/keymap'

const ESC = '\x1b'

describe('UT-keymap-1 control key mapping', () => {
  it('Ctrl+<letter> → 0x01..0x1a', () => {
    expect(chord('a', { ctrl: true })).toBe('\x01')
    expect(chord('c', { ctrl: true })).toBe('\x03') // interrupt
    expect(chord('d', { ctrl: true })).toBe('\x04') // EOF
    expect(chord('z', { ctrl: true })).toBe('\x1a')
    expect(chord('C', { ctrl: true }), 'uppercase works too').toBe('\x03')
  })

  it('Ctrl+[ \\ ] ^ _ control codes', () => {
    expect(chord('[', { ctrl: true })).toBe('\x1b')
    expect(chord('\\', { ctrl: true })).toBe('\x1c')
    expect(chord(']', { ctrl: true })).toBe('\x1d')
    expect(chord('^', { ctrl: true })).toBe('\x1e')
    expect(chord('_', { ctrl: true })).toBe('\x1f')
  })

  it('Ctrl+@ / space → 0x00, Ctrl+? → 0x7f, other printable characters unchanged', () => {
    expect(chord('@', { ctrl: true })).toBe('\x00')
    expect(chord(' ', { ctrl: true })).toBe('\x00')
    expect(chord('?', { ctrl: true })).toBe('\x7f')
    expect(chord('/', { ctrl: true })).toBe('/')
    expect(chord('-', { ctrl: true })).toBe('-')
    expect(chord('1', { ctrl: true })).toBe('1')
    expect(chord('中', { ctrl: true })).toBe('中')
  })

  it('Alt+<char> → ESC + char', () => {
    expect(chord('b', { alt: true })).toBe(`${ESC}b`)
    expect(chord('f', { alt: true })).toBe(`${ESC}f`)
  })

  it('combines Ctrl+Alt', () => {
    expect(chord('c', { ctrl: true, alt: true })).toBe(`${ESC}\x03`)
  })

  it('special key bytes match the docs exactly', () => {
    expect(KEY_BYTES.Backspace, 'Backspace is DEL (0x7f), not 0x08').toBe('\x7f')
    expect(KEY_BYTES.Enter, 'Enter is CR, not LF').toBe('\r')
    expect(KEY_BYTES.Escape).toBe(ESC)
    expect(KEY_BYTES.Tab).toBe('\t')
    expect(KEY_BYTES.ArrowUp).toBe(`${ESC}[A`)
    expect(KEY_BYTES.ArrowDown).toBe(`${ESC}[B`)
    expect(KEY_BYTES.ArrowRight).toBe(`${ESC}[C`)
    expect(KEY_BYTES.ArrowLeft).toBe(`${ESC}[D`)
    expect(KEY_BYTES.Home).toBe(`${ESC}[H`)
    expect(KEY_BYTES.End).toBe(`${ESC}[F`)
    expect(KEY_BYTES.PageUp).toBe(`${ESC}[5~`)
    expect(KEY_BYTES.PageDown).toBe(`${ESC}[6~`)
    expect(KEY_BYTES.Delete).toBe(`${ESC}[3~`)
    expect(KEY_BYTES.Insert).toBe(`${ESC}[2~`)
    expect(KEY_BYTES.ShiftTab).toBe(`${ESC}[Z`)
  })

  it('F1–F4 use SS3, F5–F12 use CSI', () => {
    expect(KEY_BYTES.F1).toBe(`${ESC}OP`)
    expect(KEY_BYTES.F4).toBe(`${ESC}OS`)
    expect(KEY_BYTES.F5).toBe(`${ESC}[15~`)
    expect(KEY_BYTES.F12).toBe(`${ESC}[24~`)
    // F-key codes skip numbers (no 16/22); copied from the docs
    expect(KEY_BYTES.F6).toBe(`${ESC}[17~`)
    expect(KEY_BYTES.F11).toBe(`${ESC}[23~`)
  })
})

describe('app-level shortcuts', () => {
  const key = (k: string, mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = {}) => ({
    key: k,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...mods,
  })

  it('leaves Ctrl/Cmd+K to the terminal (readline kill-to-end-of-line, ADR-0022)', () => {
    // With the command palette gone this key is no longer intercepted; catching it would steal a key terminals really use
    expect(appAction(key('k', { ctrlKey: true }))).toBeNull()
    expect(appAction(key('K', { ctrlKey: true }))).toBeNull()
    expect(appAction(key('k', { metaKey: true }))).toBeNull()
  })

  it('leaves Ctrl/Cmd+F to the browser or terminal (in-session search was removed, ADR-0025 §7)', () => {
    expect(appAction(key('f', { ctrlKey: true }))).toBeNull()
    expect(appAction(key('F', { ctrlKey: true }))).toBeNull()
    expect(appAction(key('f', { metaKey: true }))).toBeNull()
  })

  it('treats Ctrl+Shift+* as app shortcuts', () => {
    expect(appAction(key('Enter', { ctrlKey: true, shiftKey: true }))).toBe('newSession')
    // Ctrl+M is the terminal's Enter (CR); Ctrl+Shift+M must never be an app shortcut or it would collide with Enter
    expect(appAction(key('M', { ctrlKey: true, shiftKey: true })), 'Ctrl+M is the terminal Enter').toBeNull()
    expect(appAction(key('ArrowUp', { ctrlKey: true, shiftKey: true }))).toBe('prevSession')
    expect(appAction(key('ArrowDown', { ctrlKey: true, shiftKey: true }))).toBe('nextSession')
    expect(appAction(key('W', { ctrlKey: true, shiftKey: true }))).toBe('closeSession')
    expect(appAction(key('B', { ctrlKey: true, shiftKey: true }))).toBe('toggleSessions')
  })

  it('UT-look-1 Ctrl+Shift+, is not a shortcut (settings has no key binding, ADR-0037 §2) and goes to the terminal', () => {
    expect(appAction(key('<', { ctrlKey: true, shiftKey: true }))).toBeNull()
    expect(appAction(key(',', { ctrlKey: true, shiftKey: true }))).toBeNull()
  })

  it('does not treat Ctrl+Alt+* as shortcuts (AltGr on Windows / European layouts)', () => {
    expect(appAction(key('Enter', { ctrlKey: true, shiftKey: true, altKey: true }))).toBeNull()
    expect(appAction(key('b', { ctrlKey: true, altKey: true }))).toBeNull()
  })

  it('never intercepts combinations the terminal needs', () => {
    // Ctrl+C / Ctrl+D / Ctrl+R must reach the PTY as is, or vim, less and Ctrl+C all break
    // Ctrl+K is readline's kill-to-end-of-line and must not be caught either (ADR-0022)
    for (const k of ['c', 'd', 'r', 'a', 'e', 'u', 'z', 'k']) {
      expect(appAction(key(k, { ctrlKey: true })), `Ctrl+${k} was swallowed by the app`).toBeNull()
    }
    // Alt+<letter> is Meta in TUIs
    for (const k of ['b', 'f', 'd']) {
      expect(appAction(key(k, { altKey: true })), `Alt+${k} was swallowed`).toBeNull()
    }
    // Plain keys are obviously not caught
    expect(appAction(key('a'))).toBeNull()
    expect(appAction(key('Enter'))).toBeNull()
  })
})

describe('UT-keymap-1 DECCKM: arrows and HOME / END follow application cursor key mode', () => {
  it('uses CSI when off and SS3 when on', () => {
    expect(cursorKey('ArrowUp', false)).toBe(`${ESC}[A`)
    expect(cursorKey('ArrowUp', true)).toBe(`${ESC}OA`)
    expect(cursorKey('ArrowLeft', true)).toBe(`${ESC}OD`)
    expect(cursorKey('Home', false)).toBe(`${ESC}[H`)
    expect(cursorKey('Home', true)).toBe(`${ESC}OH`)
    expect(cursorKey('End', true)).toBe(`${ESC}OF`)
    expect(cursorKey('PageUp', true), 'PGUP ignores DECCKM').toBeUndefined()
  })
})

describe('UT-keys-1 extra keys (AC-3.18)', () => {
  it('has 14 keys in two rows, in Termux\'s default order', () => {
    expect(EXTRA_KEYS.map((row) => row.map((k) => k.label))).toEqual([
      ['ESC', '/', '-', 'HOME', '↑', 'END', 'PGUP'],
      ['TAB', 'CTRL', 'ALT', '←', '↓', '→', 'PGDN'],
    ])
    expect(EXTRA_KEYS.flat().map((k) => `key-${k.id}`)).toEqual([
      'key-Escape', 'key-Slash', 'key-Minus', 'key-Home', 'key-ArrowUp', 'key-End', 'key-PageUp',
      'key-Tab', 'key-Ctrl', 'key-Alt', 'key-ArrowLeft', 'key-ArrowDown', 'key-ArrowRight', 'key-PageDown',
    ])
  })

  it('matches the physical keyboard encoding without modifiers', () => {
    const b = (id: ExtraKeyId, decckm = false) => extraKeyBytes(id, NO_MODS, decckm)
    expect(b('Escape')).toBe('\x1b')
    expect(b('Slash')).toBe('/')
    expect(b('Minus')).toBe('-')
    expect(b('Tab')).toBe('\t')
    expect(b('ArrowUp')).toBe('\x1b[A')
    expect(b('ArrowDown')).toBe('\x1b[B')
    expect(b('ArrowRight')).toBe('\x1b[C')
    expect(b('ArrowLeft')).toBe('\x1b[D')
    expect(b('Home')).toBe('\x1b[H')
    expect(b('End')).toBe('\x1b[F')
    expect(b('PageUp')).toBe('\x1b[5~')
    expect(b('PageDown')).toBe('\x1b[6~')
    for (const id of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'] as const) {
      expect(b(id), `${id} matches KEY_BYTES`).toBe(KEY_BYTES[id])
    }
  })

  it('sends SS3 for arrows / HOME / END with DECCKM on (E2E-10 ④: ↑ → 1b4f41, HOME → 1b4f48)', () => {
    expect(extraKeyBytes('ArrowUp', NO_MODS, true)).toBe('\x1bOA')
    expect(extraKeyBytes('Home', NO_MODS, true)).toBe('\x1bOH')
    expect(extraKeyBytes('End', NO_MODS, true)).toBe('\x1bOF')
    expect(extraKeyBytes('PageUp', NO_MODS, true), 'PGUP is unaffected').toBe('\x1b[5~')
  })

  it('uses xterm\'s modifier encoding for arrows under CTRL / ALT (E2E-10 ⑥: CTRL+← → 1b5b313b3544)', () => {
    expect(extraKeyBytes('ArrowLeft', { ctrl: true, alt: false }, false)).toBe('\x1b[1;5D')
    expect(extraKeyBytes('ArrowUp', { ctrl: false, alt: true }, false)).toBe('\x1b[1;3A')
    expect(extraKeyBytes('ArrowUp', { ctrl: true, alt: true }, false)).toBe('\x1b[1;7A')
    expect(extraKeyBytes('ArrowUp', { ctrl: true, alt: false }, true), 'the modified form ignores DECCKM').toBe('\x1b[1;5A')
    expect(extraKeyBytes('Home', { ctrl: true, alt: false }, false)).toBe('\x1b[1;5H')
    expect(extraKeyBytes('PageUp', { ctrl: true, alt: false }, false)).toBe('\x1b[5;5~')
    expect(extraKeyBytes('PageDown', { ctrl: false, alt: true }, false)).toBe('\x1b[6;3~')
  })

  it('ESC / TAB are unchanged under CTRL and ESC-prefixed under ALT; / - go through chord', () => {
    expect(extraKeyBytes('Escape', { ctrl: true, alt: false }, false)).toBe('\x1b')
    expect(extraKeyBytes('Escape', { ctrl: false, alt: true }, false)).toBe('\x1b\x1b')
    expect(extraKeyBytes('Tab', { ctrl: true, alt: false }, false)).toBe('\t')
    expect(extraKeyBytes('Tab', { ctrl: false, alt: true }, false)).toBe('\x1b\t')
    expect(extraKeyBytes('Slash', { ctrl: true, alt: false }, false)).toBe('/')
    expect(extraKeyBytes('Minus', { ctrl: false, alt: true }, false)).toBe('\x1b-')
  })

  it('CTRL / ALT send no bytes themselves', () => {
    expect(isModifierKey('Ctrl')).toBe(true)
    expect(isModifierKey('Alt')).toBe(true)
    expect(isModifierKey('Tab')).toBe(false)
    expect(extraKeyBytes('Ctrl', NO_MODS, false)).toBe('')
  })
})

describe('UT-keys-1 sticky CTRL / ALT', () => {
  it('tap arms it for the next key only, then it returns to off', () => {
    const s = new Sticky()
    s.tap('ctrl')
    expect(s.state('ctrl')).toBe('armed')
    expect(s.take()).toEqual({ ctrl: true, alt: false })
    expect(s.state('ctrl')).toBe('off')
    expect(s.take()).toEqual({ ctrl: false, alt: false })
  })

  it('a second tap while armed turns it off', () => {
    const s = new Sticky()
    s.tap('alt')
    s.tap('alt')
    expect(s.state('alt')).toBe('off')
  })

  it('long-press locks it for repeated chords (Ctrl+C then Ctrl+D); a tap unlocks', () => {
    const s = new Sticky()
    s.hold('ctrl')
    expect(s.state('ctrl')).toBe('locked')
    expect(s.apply('c')).toBe('\x03')
    expect(s.apply('d')).toBe('\x04')
    expect(s.state('ctrl')).toBe('locked')
    s.tap('ctrl')
    expect(s.state('ctrl')).toBe('off')
    expect(s.apply('c')).toBe('c')
  })

  it('applies to the next on-screen keyboard character too (onData exit)', () => {
    const s = new Sticky()
    s.tap('ctrl')
    expect(s.apply('c'), 'E2E-10 ⑥: CTRL armed + on-screen c → 03').toBe('\x03')
    expect(s.state('ctrl')).toBe('off')
    s.tap('alt')
    expect(s.apply('b')).toBe('\x1bb')
    expect(s.state('alt')).toBe('off')
  })

  it('with CTRL and ALT both on, applies CTRL first, then ESC', () => {
    const s = new Sticky()
    s.tap('ctrl')
    s.tap('alt')
    expect(s.apply('c')).toBe('\x1b\x03')
    expect(s.mods()).toEqual({ ctrl: false, alt: false })
  })

  it('passes anything but a single character (paste, IME commit, terminal reply) through unchanged without consuming', () => {
    const s = new Sticky()
    s.tap('ctrl')
    expect(s.apply('你好')).toBe('你好')
    expect(s.apply('\x1b[12;1R')).toBe('\x1b[12;1R')
    expect(s.state('ctrl')).toBe('armed')
    expect(s.apply('中'), 'a single CJK character counts as one character: unchanged, but consumes').toBe('中')
    expect(s.state('ctrl')).toBe('off')
  })

  it('does nothing without modifiers', () => {
    const s = new Sticky()
    expect(s.apply('a')).toBe('a')
  })

  it('notifies subscribers on state changes (the UI uses it to update data-sticky)', () => {
    const s = new Sticky()
    let n = 0
    const off = s.subscribe(() => n++)
    s.tap('ctrl') // off → armed
    s.apply('x') // armed → off
    s.apply('y') // no change, no notification
    s.hold('alt')
    off()
    s.tap('alt')
    expect(n).toBe(3)
  })
})
