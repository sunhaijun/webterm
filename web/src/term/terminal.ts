/**
 * xterm wrapper and the browser's output path (ADR-0026 §7, layout.md).
 *
 * The browser does just this:
 *
 *   per session:   one TextDecoder('utf-8') in stream mode
 *   OUTPUT frame   → term.write(decoder.decode(payload, {stream: true}))
 *   SNAPSHOT frame → reset; decoder = new TextDecoder(); term.write(decode(snapshot))
 *
 * Decode to a string before writing. xterm.js 5.5's `write(Uint8Array)` drops the whole
 * character when a three-byte character is split across two writes right after a second
 * byte of 0x80 (`。` `…` `—`).
 *
 * Rendering uses xterm's default DOM renderer and xterm's own touch scrolling (vertical
 * drags become wheel events when the program enables mouse tracking, ADR-0029 / 0032).
 * Rows and columns are computed here instead of with FitAddon (ADR-0033). No scrollback
 * pause, frame coalescing or write budget until the E2E-37 baseline says we need them.
 */
import { Terminal, type ILink, type ITheme } from '@xterm/xterm'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'

import { linkAt, linksInRow, openUrl, type FoundLink } from './links'
import { parseOsc52 } from './osc52'

/**
 * Terminal font: the system monospace stack, identical to `--font-mono` in CSS. The tail is
 * a CJK monospace fallback: coding fonts rarely include CJK glyphs, and without it they
 * fall back to a proportional font and mixed CJK/Latin columns misalign.
 */
export const FONT_FAMILY =
  'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", "Noto Sans Mono CJK SC", "Sarasa Mono SC", monospace'

/** At least 5000 lines of scrollback (AC-5.1). */
export const SCROLLBACK = 5000

/**
 * Hard reset (RIS). A snapshot clears the terminal in-stream with this instead of calling
 * `term.reset()`, which is synchronous and doesn't flush xterm's write buffer. The agent
 * resends a snapshot whenever the column count changes, and at that moment old output may
 * still be queued unparsed; it would be parsed after the reset but before the snapshot,
 * corrupting the screen. RIS goes through the same write queue, so ordering is correct by
 * construction, with the same effect as `term.reset()`.
 */
export const RIS = '\x1bc'

export interface Size {
  width: number
  height: number
}

/**
 * Rows/cols = available size ÷ cell size, floored, at least 2 cols and 1 row (as in
 * FitAddon). Null when the cell size can't be measured. The cell size must not depend on
 * the current rows/cols; see `fit()` (ADR-0033).
 */
export function proposeSize(avail: Size, cell: Size): { cols: number; rows: number } | null {
  if (!(cell.width > 0 && cell.height > 0)) return null
  return {
    cols: Math.max(2, Math.floor(Math.max(0, avail.width) / cell.width)),
    rows: Math.max(1, Math.floor(Math.max(0, avail.height) / cell.height)),
  }
}

/** The xterm internals we need (the same ones FitAddon reads). */
interface XtermCore {
  _renderService: { dimensions: { device: { cell: Size } }; clear(): void }
  _coreBrowserService: { dpr: number }
  viewport?: { scrollBarWidth: number }
}

export interface TermHandle {
  term: Terminal
  /** Recomputes rows/cols from the container size and resizes only if they changed (ADR-0033). */
  fit(): void
  serialize: SerializeAddon
  /** Writes OUTPUT. replay=true means catch-up: the replay gate blocks xterm's automatic replies while it is written. */
  output(bytes: Uint8Array, replay: boolean): void
  /** Writes a snapshot: reset → fresh decoder → write as replay. */
  snapshot(bytes: Uint8Array): void
  /**
   * Writes a local line (the process-exited notice) after any output already written. If a
   * snapshot arrives first (snapshots clear the screen), this write is dropped; the caller
   * writes it again after the snapshot.
   */
  local(line: string): void
  /** Replay gate: replayed bytes are still being parsed by xterm. */
  replaying(): boolean
  /** Whether the alternate screen buffer is active. */
  altScreen(): boolean
  /** The foreground program enabled mouse tracking. */
  mouseTracking(): boolean
  /** Row height in px. */
  rowHeight(): number
  /** Dispatches one wheel step at viewport coordinates (x, y) (ADR-0029); up = scroll up. */
  wheel(up: boolean, x: number, y: number): void
  /** The URL in the text under viewport point (x, y), or null (ADR-0053 §3). */
  linkAtPoint(x: number, y: number): FoundLink | null
  dispose(): void
}

/** What the terminal tells its owner. */
export interface TermHooks {
  /**
   * A program asked to put text on the clipboard (OSC 52) in live output; never called while
   * replaying (ADR-0053 §4). Reads are never answered.
   */
  clipboard?(text: string): void
}

/** Ctrl+click, or Cmd+click on macOS, opens a link (ADR-0053 §2). */
const opensLink = (e: MouseEvent) => e.ctrlKey || e.metaKey

/** `fontSize` comes from settings (`ui/prefs.ts`, default 14, ADR-0037). */
export function createTerminal(theme: ITheme | undefined, fontSize: number, hooks: TermHooks = {}): TermHandle {
  const term = new Terminal({
    fontSize,
    fontFamily: FONT_FAMILY,
    scrollback: SCROLLBACK,
    allowProposedApi: true,
    convertEol: false,
    cursorBlink: true,
    theme,
    // OSC 8 hyperlinks: http / https only (allowNonHttpProtocols stays off), opened like
    // URLs in text instead of through xterm's confirm() (ADR-0053 §1–§2)
    linkHandler: {
      activate: (e, uri) => {
        if (opensLink(e)) openUrl(uri)
      },
    },
  })

  // URLs in text (ADR-0053 §1): underlined on hover, opened with Ctrl/Cmd+click
  term.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const row = lineNumber - 1
      const links: ILink[] = linksInRow(term.buffer.active, row).map((l) => ({
        range: { start: { x: l.start.x + 1, y: l.start.y + 1 }, end: { x: l.end.x + 1, y: l.end.y + 1 } },
        text: l.text,
        decorations: { pointerCursor: false, underline: true },
        activate: (e, text) => {
          if (opensLink(e)) openUrl(text)
        },
      }))
      callback(links.length ? links : undefined)
    },
  })

  const serialize = new SerializeAddon()
  term.loadAddon(serialize)

  // Correct widths for CJK and emoji; otherwise mixed CJK/Latin text misaligns
  term.loadAddon(new Unicode11Addon())
  term.unicode.activeVersion = '11'

  let decoder = new TextDecoder('utf-8')
  let replayDepth = 0

  // OSC 52 (ADR-0053 §4): write only, and never from replayed bytes (catch-up, snapshot), so
  // a reconnect or switching back doesn't put something old on the clipboard. Handled either
  // way, so nothing answers a read.
  term.parser.registerOscHandler(52, (data) => {
    const m = parseOsc52(data)
    if (m?.kind === 'write' && replayDepth === 0) hooks.clipboard?.(m.text)
    return true
  })
  /** Bumped on every snapshot; local lines queued before it are dropped. */
  let generation = 0

  /**
   * Available size follows FitAddon: the parent's size minus `.xterm` padding, and minus
   * the scrollbar for width. The cell size is device.cell / dpr, not css.cell: the DOM
   * renderer's css.cell.width is "rounded row width ÷ current cols", so it depends on the
   * current column count. FitAddon divides by it, and at 900px wide every fit flipped
   * between 104 and 103 cols, even when only the height changed (ADR-0033).
   */
  const fit = () => {
    const el = term.element
    const parent = el?.parentElement
    if (!el || !parent) return
    const core = (term as unknown as { _core: XtermCore })._core
    const dpr = core._coreBrowserService.dpr
    const cell = core._renderService.dimensions.device.cell
    const ps = getComputedStyle(parent)
    const es = getComputedStyle(el)
    const px = (v: string) => parseInt(v) || 0
    const size = proposeSize(
      {
        width: px(ps.width) - px(es.paddingLeft) - px(es.paddingRight) - (core.viewport?.scrollBarWidth ?? 0),
        height: px(ps.height) - px(es.paddingTop) - px(es.paddingBottom),
      },
      { width: cell.width / dpr, height: cell.height / dpr },
    )
    if (!size || (size.cols === term.cols && size.rows === term.rows)) return
    core._renderService.clear()
    term.resize(size.cols, size.rows)
  }

  const writeReplay = (s: string) => {
    // Open the window when the write is queued and close it only once parsed: xterm parses
    // asynchronously in chunks, so closing synchronously would miss replies triggered later
    replayDepth++
    term.write(s, () => {
      replayDepth--
    })
  }

  return {
    term,
    fit,
    serialize,
    output(bytes, replay) {
      const s = decoder.decode(bytes, { stream: true })
      if (s === '') return // The whole frame is a partial character; it waits in the decoder for the next frame
      if (replay) writeReplay(s)
      else term.write(s)
    },
    snapshot(bytes) {
      generation++
      // Fresh decoder: the old one may hold a partial character from the pre-snapshot stream
      decoder = new TextDecoder('utf-8')
      // A snapshot may end mid-sequence (including half a UTF-8 character); stream mode keeps it for the next frame
      writeReplay(RIS + decoder.decode(bytes, { stream: true }))
    },
    local(line) {
      // The process exited: flush any partial character from the decoder (it becomes U+FFFD) so it doesn't land after the notice
      const tail = decoder.decode()
      const gen = generation
      term.write(tail, () => {
        if (gen !== generation) return
        // Start a new line unless the cursor is at column 0, so the notice doesn't trail the prompt
        term.write((term.buffer.active.cursorX > 0 ? '\r\n' : '') + line)
      })
    },
    replaying: () => replayDepth > 0,
    altScreen: () => term.buffer.active.type === 'alternate',
    mouseTracking: () => term.modes.mouseTrackingMode !== 'none',
    rowHeight() {
      const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
      return Math.max((screen?.getBoundingClientRect().height ?? 0) / Math.max(term.rows, 1), 1)
    },
    wheel(up, x, y) {
      // Go through xterm's own mouse tracking: one DOM_DELTA_LINE wheel event is one report,
      // with the encoding (X10 / SGR / URXVT) and cell coordinates the program asked for
      term.element?.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: up ? -1 : 1,
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      )
    },
    linkAtPoint(x, y) {
      const screen = term.element?.querySelector<HTMLElement>('.xterm-screen')
      if (!screen) return null
      const r = screen.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) return null
      const col = Math.floor(((x - r.left) / r.width) * term.cols)
      const row = Math.floor(((y - r.top) / r.height) * term.rows)
      if (col < 0 || row < 0 || col >= term.cols || row >= term.rows) return null
      const buf = term.buffer.active
      return linkAt(buf, col, buf.viewportY + row)
    },
    dispose() {
      term.dispose()
    },
  }
}

/**
 * Reads the xterm theme from CSS custom properties (layout.md): `--term-bg` `--term-fg`
 * `--term-cursor` `--term-sel` and the 16 colors `--ansi-0` … `--ansi-15`. Undefined
 * entries fall back to xterm's defaults.
 */
export function themeFromCss(get: (name: string) => string): ITheme {
  const v = (name: string) => get(name).trim() || undefined
  const ansi = [
    'black',
    'red',
    'green',
    'yellow',
    'blue',
    'magenta',
    'cyan',
    'white',
    'brightBlack',
    'brightRed',
    'brightGreen',
    'brightYellow',
    'brightBlue',
    'brightMagenta',
    'brightCyan',
    'brightWhite',
  ] as const
  const theme: Record<string, string | undefined> = {
    background: v('--term-bg'),
    foreground: v('--term-fg'),
    cursor: v('--term-cursor'),
    cursorAccent: v('--term-bg'),
    selectionBackground: v('--term-sel'),
  }
  ansi.forEach((name, i) => {
    theme[name] = v(`--ansi-${i}`)
  })
  for (const k of Object.keys(theme)) if (theme[k] === undefined) delete theme[k]
  return theme as ITheme
}

/** The local process-exited line (AC-4.5), dimmed to set it apart from output. */
export function exitLine(code: number | null): string {
  const text = code === null ? '[Exited · Enter to close]' : `[Exited (code ${code}) · Enter to close]`
  return `\x1b[0;2m${text}\x1b[0m`
}
