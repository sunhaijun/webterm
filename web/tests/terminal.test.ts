/**
 * The browser's output path (ADR-0026 §7, layout.md):
 *   UT-decode-1  streaming UTF-8 decode: characters split across frames are not lost (AC-2.23)
 *   snapshots    RIS clears in-stream, a fresh decoder, written as replay (AC-2.6)
 *   local line   queued after output; dropped if queued before a snapshot (AC-4.5)
 */
import { describe, expect, it } from 'vitest'

import { FONT_FAMILY, SCROLLBACK, createTerminal, exitLine, proposeSize, themeFromCss } from '../src/term/terminal'
import { FONT_DEFAULT } from '../src/ui/prefs'
import { flush, lineText, lines } from './helpers'

const bytes = (...xs: number[]) => new Uint8Array(xs)
const enc = (s: string) => new TextEncoder().encode(s)
const mk = () => createTerminal(undefined, FONT_DEFAULT)

describe('UT-decode-1 split UTF-8 loses nothing', () => {
  it('handles 。…— each split after the second byte across OUTPUT frames (the E2E-43 split)', async () => {
    const h = mk()
    h.output(bytes(0xe3, 0x80), false)
    h.output(bytes(0x82, 0xe2, 0x80), false)
    h.output(bytes(0xa6, 0xe2, 0x80), false)
    h.output(new Uint8Array([0x94, ...enc('END\r\n')]), false)
    await flush(h.term)
    expect(lineText(h.term, 0)).toBe('。…—END')
    h.dispose()
  })

  it('reassembles one byte per frame (CJK, emoji)', async () => {
    const h = mk()
    for (const b of enc('中文😀，“引号”、《书名》\r\n')) h.output(bytes(b), false)
    await flush(h.term)
    expect(lineText(h.term, 0)).toBe('中文😀，“引号”、《书名》')
    h.dispose()
  })

  it('writes nothing when a whole frame is a partial character, and waits for the next', async () => {
    const h = mk()
    h.output(bytes(0xe4), false)
    h.output(bytes(0xb8), false)
    await flush(h.term)
    expect(lineText(h.term, 0)).toBe('')
    h.output(bytes(0xad), false)
    await flush(h.term)
    expect(lineText(h.term, 0)).toBe('中')
    h.dispose()
  })

  it('uses a decoder per session, so a partial character never joins another session\'s bytes', async () => {
    const a = mk()
    const b = mk()
    a.output(bytes(0xe3, 0x80), false)
    b.output(enc('x'), false)
    a.output(bytes(0x82), false)
    await flush(a.term)
    await flush(b.term)
    expect(lineText(a.term, 0)).toBe('。')
    expect(lineText(b.term, 0)).toBe('x')
    a.dispose()
    b.dispose()
  })
})

describe('snapshots (AC-2.6)', () => {
  it('clears and redraws: old content appears 0 times, snapshot content exactly once', async () => {
    const h = mk()
    h.output(enc('MARK-ONE\r\nold line\r\n'), false)
    await flush(h.term)
    h.snapshot(enc('restored\r\n$ '))
    await flush(h.term)
    expect(lines(h.term)).toEqual(['restored', '$ '])
    h.dispose()
  })

  it('clears in-stream, so old output not yet parsed is never drawn after the snapshot', async () => {
    const h = mk()
    // The snapshot arrives before parsing finishes (the agent resends one as soon as cols change, with old output possibly still queued)
    h.output(enc('stale-1\r\nstale-2\r\n'), false)
    h.snapshot(enc('fresh'))
    await flush(h.term)
    expect(lines(h.term)).toEqual(['fresh'])
    h.dispose()
  })

  it('uses a fresh decoder, dropping a partial character held by the old one instead of joining it to post-snapshot bytes', async () => {
    const h = mk()
    h.output(bytes(0xe3, 0x80), false) // half of 。
    h.snapshot(enc('S\r\n'))
    h.output(bytes(0x82), false) // the other half arrives after the snapshot
    await flush(h.term)
    expect(h.term.buffer.active.getLine(1)?.translateToString(true)).not.toContain('。')
    h.dispose()
  })

  it('keeps a partial character at the end of a snapshot for the next frame', async () => {
    const h = mk()
    h.snapshot(new Uint8Array([...enc('A'), 0xe3, 0x80]))
    h.output(bytes(0x82), false)
    await flush(h.term)
    expect(lineText(h.term, 0)).toBe('A。')
    h.dispose()
  })

  it('counts snapshots as replay: replaying() is true until parsed', async () => {
    const h = mk()
    expect(h.replaying()).toBe(false)
    h.snapshot(enc('x'))
    expect(h.replaying()).toBe(true)
    await flush(h.term)
    expect(h.replaying()).toBe(false)
    h.output(enc('y'), true)
    expect(h.replaying()).toBe(true)
    await flush(h.term)
    expect(h.replaying()).toBe(false)
    h.output(enc('z'), false)
    expect(h.replaying(), 'live output does not open the gate').toBe(false)
    h.dispose()
  })

  it('can put the client on the alternate screen', async () => {
    const h = mk()
    h.snapshot(enc('\x1b[?1049h\x1b[HFRAME 1'))
    await flush(h.term)
    expect(h.altScreen()).toBe(true)
    h.snapshot(enc('back'))
    await flush(h.term)
    expect(h.altScreen(), 'the next snapshot resets it').toBe(false)
    h.dispose()
  })
})

describe('process-exited line (AC-4.5)', () => {
  it('matches the documented text and omits the parentheses without an exit code', () => {
    expect(exitLine(1)).toContain('[Exited (code 1) · Enter to close]')
    expect(exitLine(0)).toContain('(code 0)')
    expect(exitLine(null)).toContain('[Exited · Enter to close]')
  })

  it('goes after the last output, starting a new line if the cursor is not at column 0', async () => {
    const h = mk()
    h.output(enc('LAST-LINE\r\n$ '), false)
    h.local('[END]')
    await flush(h.term)
    await flush(h.term)
    expect(lines(h.term)).toEqual(['LAST-LINE', '$ ', '[END]'])
    h.dispose()
  })

  it('adds no blank line when the cursor is at column 0', async () => {
    const h = mk()
    h.output(enc('exit\r\n'), false)
    h.local('[END]')
    await flush(h.term)
    await flush(h.term)
    expect(lineText(h.term, 1)).toBe('[END]')
    h.dispose()
  })

  it('drops a line queued before a snapshot (it clears the screen; the caller writes again after it)', async () => {
    const h = mk()
    h.output(enc('a\r\n'), false)
    h.local('[END-1]')
    h.snapshot(enc('restored\r\n'))
    h.local('[END-2]')
    await flush(h.term)
    await flush(h.term)
    expect(lines(h.term)).toEqual(['restored', '[END-2]'])
    h.dispose()
  })
})

describe('UT-fit-1 rows/cols = available size ÷ a stable cell size (AC-3.11, ADR-0033)', () => {
  it('rounds down', () => {
    expect(proposeSize({ width: 800, height: 600 }, { width: 8, height: 17 })).toEqual({ cols: 100, rows: 35 })
  })

  it('measured at 900px wide: cell 8.4287, 877px available → 104 cols regardless of current cols', () => {
    // FitAddon's css.cell.width is "rounded row width ÷ current cols": 877 / 104 at 104 cols, 868 / 103 at 103.
    // Dividing 877 by those gives 103 and 104, so every fit flips. The glyph width itself (269.71875 / 32) doesn't depend on cols
    const cell = { width: 269.71875 / 32, height: 17 }
    expect(proposeSize({ width: 877, height: 676 }, cell)?.cols).toBe(104)
    expect(Math.floor(877 / (877 / 104)), 'the old algorithm proposes 103 at 104 cols (877 ÷ (877/104) = 103.99999999999999)').toBe(103)
    expect(Math.floor(877 / (868 / 103)), 'the old algorithm proposes 104 at 103 cols').toBe(104)
  })

  it('is at least 2 cols and 1 row; null when the cell size cannot be measured (not rendered yet)', () => {
    expect(proposeSize({ width: 3, height: 3 }, { width: 8, height: 17 })).toEqual({ cols: 2, rows: 1 })
    expect(proposeSize({ width: -20, height: 0 }, { width: 8, height: 17 })).toEqual({ cols: 2, rows: 1 })
    expect(proposeSize({ width: 800, height: 600 }, { width: 0, height: 17 })).toBeNull()
    expect(proposeSize({ width: 800, height: 600 }, { width: 8, height: NaN })).toBeNull()
  })
})

describe('xterm configuration', () => {
  it('has at least 5000 lines of scrollback (AC-5.1)', () => {
    const h = mk()
    expect(SCROLLBACK).toBeGreaterThanOrEqual(5000)
    expect(h.term.options.scrollback).toBe(SCROLLBACK)
    h.dispose()
  })

  it('UT-look-1 defaults to 14px with the system monospace stack and a CJK monospace fallback (AC-5.3)', () => {
    const h = mk()
    expect(FONT_DEFAULT).toBe(14)
    expect(h.term.options.fontSize).toBe(14)
    expect(createTerminal(undefined, 18).term.options.fontSize, 'new instances use the font size from settings').toBe(18)
    expect(h.term.options.fontFamily).toBe(FONT_FAMILY)
    expect(FONT_FAMILY).toMatch(/^ui-monospace, /)
    expect(FONT_FAMILY).toMatch(/"Noto Sans Mono CJK SC", "Sarasa Mono SC", monospace$/)
    h.dispose()
  })

  it('reads mouse tracking state live', async () => {
    const h = mk()
    expect(h.mouseTracking()).toBe(false)
    h.output(enc('\x1b[?1000h'), false)
    await flush(h.term)
    expect(h.mouseTracking()).toBe(true)
    h.dispose()
  })

  it('reads the theme from CSS variables, leaving undefined entries to xterm defaults', () => {
    const vars: Record<string, string> = { '--term-bg': ' #0d1117 ', '--term-fg': '#e6edf3', '--ansi-1': '#ff7b72' }
    const t = themeFromCss((n) => vars[n] ?? '')
    expect(t).toEqual({ background: '#0d1117', foreground: '#e6edf3', cursorAccent: '#0d1117', red: '#ff7b72' })
  })
})
