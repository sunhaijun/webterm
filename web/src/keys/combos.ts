/**
 * Combo keys for the program in front (input.md §Combo keys, ADR-0054 §4). Keys a phone
 * can't type, or that take several taps with sticky CTRL: one tile each. The set follows
 * `program` from the agent; the key that opens it never moves.
 */
import type { Program } from '../protocol/messages'

export interface Combo {
  id: string
  /** What's on the key, e.g. `^O`. */
  key: string
  /** A short action name, e.g. `Transcript`. */
  label: string
  /** Writes to send, in order; more than one are COMBO_GAP_MS apart (Esc Esc reads as a double tap). */
  send: string[]
}

export const COMBO_GAP_MS = 120

const ESC = '\x1b'
const c = (id: string, key: string, label: string, ...send: string[]): Combo => ({ id, key, label, send })

const ctrlC = (label: string) => c('ctrl-c', '^C', label, '\x03')

/** Checked against claude 2.1.317's key bindings; codex 0.166 on a real run (manual checklist). */
const SETS: Record<Program, Combo[]> = {
  claude: [
    c('shift-tab', '⇧Tab', 'Mode', `${ESC}[Z`),
    c('esc-esc', 'Esc Esc', 'Rewind', ESC, ESC),
    c('ctrl-o', '^O', 'Transcript', '\x0f'),
    c('ctrl-t', '^T', 'Todos', '\x14'),
    c('ctrl-b', '^B', 'Background', '\x02'),
    c('ctrl-r', '^R', 'History', '\x12'),
    c('alt-p', '⌥P', 'Model', `${ESC}p`),
    ctrlC('Interrupt'),
  ],
  codex: [
    c('esc', 'Esc', 'Interrupt', ESC),
    c('esc-esc', 'Esc Esc', 'Edit previous', ESC, ESC),
    c('ctrl-t', '^T', 'Transcript', '\x14'),
    c('ctrl-j', '^J', 'Newline', '\n'),
    c('ctrl-l', '^L', 'Clear', '\x0c'),
    ctrlC('Quit'),
  ],
  shell: [
    c('enter', '↵', 'Enter', '\r'),
    ctrlC('Interrupt'),
    c('ctrl-d', '^D', 'EOF', '\x04'),
    c('ctrl-r', '^R', 'Search', '\x12'),
    c('ctrl-l', '^L', 'Clear', '\x0c'),
    c('ctrl-z', '^Z', 'Suspend', '\x1a'),
    c('ctrl-w', '^W', 'Delete word', '\x17'),
    c('ctrl-u', '^U', 'Delete line', '\x15'),
  ],
  other: [
    c('enter', '↵', 'Enter', '\r'),
    c('esc', 'Esc', 'Escape', ESC),
    ctrlC('Interrupt'),
    c('ctrl-d', '^D', 'EOF', '\x04'),
    c('ctrl-z', '^Z', 'Suspend', '\x1a'),
    c('ctrl-l', '^L', 'Clear', '\x0c'),
  ],
}

/** The tiles for a program; unknown or missing is `other`. */
export function combosFor(program: Program | string | undefined): Combo[] {
  return SETS[(program ?? 'other') as Program] ?? SETS.other
}
