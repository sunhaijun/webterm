/**
 * OSC 52 from programs (input.md §Clipboard from programs, ADR-0053 §4): write only.
 * `OSC 52 ; Pc ; Pd` — Pd is base64 text to put on the clipboard, or `?` to read it, which
 * the page never answers. Pc (the selection) doesn't matter: a browser has one clipboard.
 */

/** The most decoded text the page will put on the clipboard. */
export const MAX_OSC52_BYTES = 1 << 20

export type Osc52 = { kind: 'write'; text: string } | { kind: 'read' }

/** Parses an OSC 52 payload (what follows `52;`). Malformed or oversized → null. */
export function parseOsc52(data: string): Osc52 | null {
  const i = data.indexOf(';')
  if (i < 0) return null
  const pd = data.slice(i + 1).replace(/\s+/g, '')
  if (pd === '?') return { kind: 'read' }
  if (pd === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(pd)) return null
  if (Math.floor((pd.length * 3) / 4) - 2 > MAX_OSC52_BYTES) return null
  let bin: string
  try {
    bin = atob(pd)
  } catch {
    return null
  }
  if (bin.length > MAX_OSC52_BYTES) return null
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return { kind: 'write', text: new TextDecoder('utf-8').decode(bytes) }
}
