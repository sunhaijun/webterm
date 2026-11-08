/**
 * Links in terminal text (input.md §Links, ADR-0053 §1). One detector serves the desktop
 * link provider (Ctrl/Cmd+click) and the touch tap (Open · Copy).
 *
 * A link is an `http://` / `https://` run in a logical line: rows are joined while the next
 * row is a soft wrap, so a URL wrapped across rows is one link. URL characters are ASCII
 * only (RFC 3986), so CJK text and punctuation end a URL. Trailing sentence punctuation and
 * a closing bracket without its opening partner are trimmed off.
 */

/** A cell: 0-based column, absolute buffer row. */
export interface CellPos {
  x: number
  y: number
}

/** A link and the cells it covers, `end` inclusive. */
export interface FoundLink {
  text: string
  start: CellPos
  end: CellPos
}

/** The slice of an xterm buffer this needs, so @xterm/xterm and @xterm/headless both fit. */
export interface LinkBuffer {
  readonly length: number
  getLine(y: number):
    | { readonly isWrapped: boolean; readonly length: number; getCell(x: number): { getChars(): string; getWidth(): number } | undefined }
    | undefined
}

const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', "'", '"'])
const OPENER: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

const count = (s: string, c: string) => s.split(c).length - 1

/** Trims sentence punctuation and unbalanced closing brackets off the end of a URL. */
export function trimUrl(url: string): string {
  for (;;) {
    const c = url[url.length - 1]
    if (c === undefined) return url
    const open = OPENER[c]
    if (TRAILING.has(c) || (open !== undefined && count(url, open) < count(url, c))) {
      url = url.slice(0, -1)
      continue
    }
    return url
  }
}

/** The links in the logical line that contains `row` (absolute buffer row). */
export function linksInRow(buf: LinkBuffer, row: number): FoundLink[] {
  let top = row
  while (top > 0 && buf.getLine(top)?.isWrapped) top--
  let bottom = row
  while (bottom + 1 < buf.length && buf.getLine(bottom + 1)?.isWrapped) bottom++

  // text[i] came from cell pos[i]; a wide cell is one character, its second half is skipped
  let text = ''
  const pos: CellPos[] = []
  for (let y = top; y <= bottom; y++) {
    const line = buf.getLine(y)
    if (!line) break
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x)
      if (!cell || cell.getWidth() === 0) continue
      const ch = cell.getChars() || ' '
      for (let k = 0; k < ch.length; k++) pos.push({ x, y })
      text += ch
    }
  }

  const out: FoundLink[] = []
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0])
    const scheme = url.indexOf('://') + 3
    if (url.length <= scheme) continue
    const i = m.index!
    out.push({ text: url, start: pos[i]!, end: pos[i + url.length - 1]! })
  }
  return out
}

const before = (a: CellPos, b: CellPos) => a.y < b.y || (a.y === b.y && a.x < b.x)

/** The link covering cell (col, row), or null. */
export function linkAt(buf: LinkBuffer, col: number, row: number): FoundLink | null {
  const p = { x: col, y: row }
  return linksInRow(buf, row).find((l) => !before(p, l.start) && !before(l.end, p)) ?? null
}

/** Opens an http(s) URL in a new tab, never anything else (ADR-0053 §2, threat model T5). */
export function openUrl(url: string): void {
  if (!/^https?:\/\//i.test(url)) return
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** Shortens a URL in the middle for one line of the popover. */
export function shortUrl(url: string, max = 60): string {
  if (url.length <= max) return url
  const tail = Math.floor((max - 1) / 3)
  return url.slice(0, max - 1 - tail) + '…' + url.slice(url.length - tail)
}
