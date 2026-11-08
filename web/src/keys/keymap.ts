/**
 * Key mapping (docs/40-frontend/keymap.md).
 *
 * When typing into the terminal, almost every key goes through xterm's onData, which
 * already implements the standard mapping. This module only handles:
 *   1. bytes for the extra keys (two rows of 14, ADR-0025 §2), encoded like a physical
 *      keyboard, DECCKM included;
 *   2. sticky CTRL / ALT, which apply to the next extra key or on-screen keyboard character;
 *   3. recognizing app-level shortcuts (kept out of the PTY).
 */

/** Control characters. */
export const ESC = '\x1b'

// ---------- App-level shortcuts ----------

/**
 * App-level shortcuts use only `Ctrl+Shift+*`: Ctrl+<letter> is a terminal control code,
 * Alt+<letter> is Meta in TUIs, Ctrl+Alt is AltGr on Windows / European layouts, and
 * Ctrl+<digit> belongs to the browser. `Ctrl/Cmd+F` and `Ctrl/Cmd+K` are left to the
 * browser or terminal.
 */
export type AppAction =
  | 'newSession'
  | 'closeSession'
  | 'prevSession'
  | 'nextSession'
  | 'toggleSessions'

export interface KeyEventLike {
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

/** Recognizes app-level shortcuts. Null means it isn't one and the key goes to the terminal. */
export function appAction(e: KeyEventLike): AppAction | null {
  if (!(e.ctrlKey && e.shiftKey) || e.altKey || e.metaKey) return null
  switch (e.key) {
    case 'Enter':
      return 'newSession'
    case 'W':
    case 'w':
      return 'closeSession'
    case 'ArrowUp':
      return 'prevSession'
    case 'ArrowDown':
      return 'nextSession'
    case 'B':
    case 'b':
      return 'toggleSessions'
    default:
      return null
  }
}

// ---------- Keys to bytes ----------

/** Bytes for these physical keys (the table in keymap.md). Arrows / Home / End: see `cursorKey`. */
export const KEY_BYTES: Readonly<Record<string, string>> = {
  Escape: ESC,
  Tab: '\t',
  Enter: '\r', // CR, not LF: the PTY line discipline expects the real Enter byte
  Backspace: '\x7f', // DEL, not 0x08
  ArrowUp: `${ESC}[A`,
  ArrowDown: `${ESC}[B`,
  ArrowRight: `${ESC}[C`,
  ArrowLeft: `${ESC}[D`,
  Home: `${ESC}[H`,
  End: `${ESC}[F`,
  PageUp: `${ESC}[5~`,
  PageDown: `${ESC}[6~`,
  Delete: `${ESC}[3~`,
  Insert: `${ESC}[2~`,
  F1: `${ESC}OP`,
  F2: `${ESC}OQ`,
  F3: `${ESC}OR`,
  F4: `${ESC}OS`,
  F5: `${ESC}[15~`,
  F6: `${ESC}[17~`,
  F7: `${ESC}[18~`,
  F8: `${ESC}[19~`,
  F9: `${ESC}[20~`,
  F10: `${ESC}[21~`,
  F11: `${ESC}[23~`,
  F12: `${ESC}[24~`,
  ShiftTab: `${ESC}[Z`,
}

/** Keys that follow DECCKM, and their final characters. */
const CURSOR_FINAL: Readonly<Record<string, string>> = {
  ArrowUp: 'A',
  ArrowDown: 'B',
  ArrowRight: 'C',
  ArrowLeft: 'D',
  Home: 'H',
  End: 'F',
}

/**
 * Arrows and Home / End: `ESC O x` in application cursor key mode (DECCKM), else `ESC [ x`.
 * Callers read DECCKM fresh on every key press (`term.modes.applicationCursorKeysMode`)
 * rather than caching it, since programs reset it on exit.
 */
export function cursorKey(key: string, decckm: boolean): string | undefined {
  const fin = CURSOR_FINAL[key]
  return fin === undefined ? undefined : `${ESC}${decckm ? 'O' : '['}${fin}`
}

export interface Mods {
  ctrl: boolean
  alt: boolean
}

export const NO_MODS: Mods = { ctrl: false, alt: false }

/**
 * Applies modifiers to one character (keymap.md, sticky modifiers on extra keys).
 *
 * CTRL: letters (either case) → 0x01–0x1a; `[ \ ] ^ _` → 0x1b–0x1f; `@` / space → 0x00;
 * `?` → 0x7f; anything else unchanged. ALT: prefix ESC. With both, CTRL first, then ESC.
 */
export function chord(ch: string, mods: Partial<Mods>): string {
  let out = ch
  if (mods.ctrl) {
    const c = ch.toLowerCase()
    if (c.length === 1 && c >= 'a' && c <= 'z') {
      out = String.fromCharCode(c.charCodeAt(0) - 96) // a → 0x01
    } else {
      switch (ch) {
        case '[':
          out = '\x1b'
          break
        case '\\':
          out = '\x1c'
          break
        case ']':
          out = '\x1d'
          break
        case '^':
          out = '\x1e'
          break
        case '_':
          out = '\x1f'
          break
        case '@':
        case ' ':
          out = '\x00'
          break
        case '?':
          out = '\x7f'
          break
        default:
          out = ch // No control code for it: send as is
      }
    }
  }
  if (mods.alt) out = ESC + out
  return out
}

/** xterm's modifier parameter: 1 + Shift(1) + Alt(2) + Ctrl(4). */
function modParam(mods: Mods): number {
  return 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0)
}

// ---------- Extra keys (ADR-0025 §2, input.md) ----------

export type ExtraKeyId =
  | 'Escape'
  | 'Slash'
  | 'Minus'
  | 'Home'
  | 'ArrowUp'
  | 'End'
  | 'PageUp'
  | 'Tab'
  | 'Ctrl'
  | 'Alt'
  | 'ArrowLeft'
  | 'ArrowDown'
  | 'ArrowRight'
  | 'PageDown'
  | 'Enter'

export interface ExtraKey {
  id: ExtraKeyId
  label: string
}

/**
 * Termux's default layout: two static rows that don't change with the foreground program
 * or prompt state. The testid is `key-<id>`.
 */
export const EXTRA_KEYS: readonly (readonly ExtraKey[])[] = [
  [
    { id: 'Escape', label: 'ESC' },
    { id: 'Slash', label: '/' },
    { id: 'Minus', label: '-' },
    { id: 'Home', label: 'HOME' },
    { id: 'ArrowUp', label: '↑' },
    { id: 'End', label: 'END' },
    { id: 'PageUp', label: 'PGUP' },
  ],
  [
    { id: 'Tab', label: 'TAB' },
    { id: 'Ctrl', label: 'CTRL' },
    { id: 'Alt', label: 'ALT' },
    { id: 'ArrowLeft', label: '←' },
    { id: 'ArrowDown', label: '↓' },
    { id: 'ArrowRight', label: '→' },
    { id: 'PageDown', label: 'PGDN' },
    // The last column's bottom cell (ADR-0058 §1); ⌘ above it isn't a key
    { id: 'Enter', label: '↵' },
  ],
]

/** Modifier keys (sticky) send no bytes themselves. */
export function isModifierKey(id: ExtraKeyId): id is 'Ctrl' | 'Alt' {
  return id === 'Ctrl' || id === 'Alt'
}

const PAGE_NUM: Partial<Record<ExtraKeyId, number>> = { PageUp: 5, PageDown: 6 }
const CHAR_OF: Partial<Record<ExtraKeyId, string>> = { Slash: '/', Minus: '-', Escape: ESC, Tab: '\t', Enter: '\r' }

/**
 * Extra key → bytes, encoded like a physical keyboard (keymap.md).
 *
 * - Arrows / HOME / END: follow DECCKM without modifiers; with modifiers use xterm's
 *   `ESC [ 1 ; m X` (the modified form ignores DECCKM, as xterm does);
 * - PGUP / PGDN: `ESC [ 5 ~` / `ESC [ 6 ~`, with modifiers `ESC [ 5 ; m ~`;
 * - ESC / TAB: unchanged under CTRL, ESC-prefixed under ALT;
 * - `/` `-`: combined via `chord` (unchanged under CTRL, ESC-prefixed under ALT).
 */
export function extraKeyBytes(id: ExtraKeyId, mods: Mods, decckm: boolean): string {
  if (isModifierKey(id)) return ''
  const any = mods.ctrl || mods.alt
  const fin = CURSOR_FINAL[id]
  if (fin !== undefined) {
    return any ? `${ESC}[1;${modParam(mods)}${fin}` : cursorKey(id, decckm)!
  }
  const page = PAGE_NUM[id]
  if (page !== undefined) {
    return any ? `${ESC}[${page};${modParam(mods)}~` : `${ESC}[${page}~`
  }
  const ch = CHAR_OF[id]!
  return chord(ch, mods)
}

// ---------- Sticky CTRL / ALT (input.md) ----------

export type StickyState = 'off' | 'armed' | 'locked'
export type StickyMod = 'ctrl' | 'alt'

/**
 * State machine for sticky modifiers.
 *
 * Tap → armed, applies to the next key only; long-press → locked, applies until released;
 * tap again → off. The next key can come from the extra keys (`take()`) or from the
 * on-screen keyboard (`apply()`, hooked into the terminal's onData exit).
 */
export class Sticky {
  private readonly s: Record<StickyMod, StickyState> = { ctrl: 'off', alt: 'off' }
  private readonly listeners = new Set<() => void>()

  state(m: StickyMod): StickyState {
    return this.s[m]
  }

  mods(): Mods {
    return { ctrl: this.s.ctrl !== 'off', alt: this.s.alt !== 'off' }
  }

  /** Tap: off → armed; armed / locked → off. */
  tap(m: StickyMod): void {
    this.set(m, this.s[m] === 'off' ? 'armed' : 'off')
  }

  /** Long-press: lock. */
  hold(m: StickyMod): void {
    this.set(m, 'locked')
  }

  /** For extra keys: returns the current modifiers and consumes armed ones (locked stay). */
  take(): Mods {
    const mods = this.mods()
    this.consume()
    return mods
  }

  /**
   * For the onData exit: a single character is combined with the modifiers and armed ones
   * are consumed. With no modifiers, or for anything but a single character (paste, IME
   * commit, terminal reply), data is returned unchanged and nothing is consumed.
   */
  apply(data: string): string {
    const mods = this.mods()
    if (!mods.ctrl && !mods.alt) return data
    if ([...data].length !== 1) return data
    this.consume()
    return chord(data, mods)
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private consume(): void {
    let changed = false
    for (const m of ['ctrl', 'alt'] as const) {
      if (this.s[m] === 'armed') {
        this.s[m] = 'off'
        changed = true
      }
    }
    if (changed) this.emit()
  }

  private set(m: StickyMod, v: StickyState): void {
    if (this.s[m] === v) return
    this.s[m] = v
    this.emit()
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }
}
