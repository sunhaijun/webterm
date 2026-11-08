/**
 * Client-side sessions (docs/40-frontend/session-ux.md).
 *
 * One xterm instance per session. Switching away does not destroy it, only detaches its
 * DOM, so on switch-back the screen, scroll position and selection are intact (when the
 * agent sends a delta).
 *
 * Owns session metadata, terminal instances, output writes (OUTPUT / SNAPSHOT), the replay
 * gate, the process-exited line and subscriptions (only the visible session plus pinned
 * ones). No UI.
 */
import type { ITheme } from '@xterm/xterm'

import { inputTrace } from '../keys/inputstats'
import type { SessionInfo, SessionStatus } from '../protocol/messages'
import { createTerminal, exitLine, type TermHandle } from '../term/terminal'
import { moveBefore } from '../ui/reorder'
import { inUserInputEvent } from '../term/userinput'

/** The slice of the connection layer the store needs. */
export interface ConnLike {
  subscribe(sid: number, cols?: number, rows?: number): void
  unsubscribe(sid: number): void
  forget(sid: number): void
  outSeqOf(sid: number): number
  headSeqOf(sid: number): number
}

/** Read-only view for the UI. */
export interface SessionView {
  sid: number
  name: string
  cwd: string
  status: SessionStatus
  exitCode: number | null
  /** `[n]`: 1-based position in the current display order (ADR-0040). */
  index: number
  /** Pinned: stays subscribed while in the background. */
  pinned: boolean
  /** Not the active session, and the agent says it's waiting for you (ADR-0052). */
  attention: boolean
  active: boolean
}

export interface StoreHooks {
  onChange(): void
  /** onData that passed the replay gate: user input, or terminal replies to live queries. */
  onData(sid: number, data: string): void
  /** xterm's onBinary (some mouse report encodings), also past the replay gate. */
  onBinary?(sid: number, data: string): void
  /** App-level shortcuts: return false to keep the key out of the PTY. */
  allowKey(e: KeyboardEvent): boolean
  theme(): ITheme | undefined
  /** The configured terminal font size (AC-5.3), used for new instances. */
  fontSize(): number
  /** A program in session sid put text on the clipboard with OSC 52, in live output (ADR-0053 §4). */
  onClipboard?(sid: number, text: string): void
}

interface Entry {
  info: SessionInfo
  term: TermHandle
  /** Container holding the xterm DOM; detached from the page when switching away. */
  host: HTMLElement
  opened: boolean
  pinned: boolean
  /** The process-exited line has been written (reset on snapshot, which clears the screen). */
  exitShown: boolean
}

export class SessionStore {
  private readonly entries = new Map<number, Entry>()
  /**
   * Display order (ADR-0040), as given by the agent, with new sessions appended. May hold
   * placeholder sids whose session.created hasn't arrived yet.
   */
  private order: number[] = []
  private readonly conn: ConnLike
  private readonly h: StoreHooks
  private activeSid: number | null = null

  constructor(conn: ConnLike, hooks: StoreHooks) {
    this.conn = conn
    this.h = hooks
  }

  get active(): number | null {
    return this.activeSid
  }

  has(sid: number): boolean {
    return this.entries.has(sid)
  }

  info(sid: number): SessionInfo | undefined {
    return this.entries.get(sid)?.info
  }

  termOf(sid: number): TermHandle | undefined {
    return this.entries.get(sid)?.term
  }

  /** Sessions in display order (from the agent, ADR-0040). */
  list(): SessionView[] {
    return this.ordered().map((e, i) => ({
      sid: e.info.sid,
      name: displayName(e.info),
      cwd: e.info.cwd,
      status: e.info.status,
      exitCode: e.info.exit_code,
      index: i + 1,
      pinned: e.pinned,
      attention: e.info.sid !== this.activeSid && e.info.attention === true,
      active: e.info.sid === this.activeSid,
    }))
  }

  upsert(info: SessionInfo): void {
    const existing = this.entries.get(info.sid)
    if (existing) {
      existing.info = { ...existing.info, ...info }
      this.maybeExitLine(existing)
      this.h.onChange()
      return
    }
    const term = createTerminal(this.h.theme(), this.h.fontSize(), {
      clipboard: (text) => this.h.onClipboard?.(info.sid, text),
    })
    const host = document.createElement('div')
    host.className = 'term-host'
    host.dataset.sid = String(info.sid)
    const sid = info.sid

    // Replay gate (§5.3 / ADR-0020): while replayed bytes are still being parsed, only pass
    // onData produced during a user input event. Anything else is xterm auto-replying to
    // old queries and must not reach the PTY as keystrokes.
    const gate = (): boolean => {
      inputTrace.bump('data')
      if (!inUserInputEvent() && term.replaying()) {
        inputTrace.bumpGated()
        return false
      }
      return true
    }
    term.term.onData((data) => {
      if (gate()) this.h.onData(sid, data)
    })
    term.term.onBinary((data) => {
      if (gate()) this.h.onBinary?.(sid, data)
    })
    term.term.attachCustomKeyEventHandler((e) => e.type !== 'keydown' || this.h.allowKey(e))

    const entry: Entry = { info, term, host, opened: false, pinned: false, exitShown: false }
    this.entries.set(sid, entry)
    if (!this.order.includes(sid)) this.order.push(sid) // New sessions go last (ADR-0040)
    this.maybeExitLine(entry)
    this.h.onChange()
  }

  patch(sid: number, patch: Partial<SessionInfo>): void {
    const e = this.entries.get(sid)
    if (!e) return
    e.info = { ...e.info, ...patch }
    this.maybeExitLine(e)
    this.h.onChange()
  }

  remove(sid: number): void {
    const e = this.entries.get(sid)
    if (!e) return
    e.term.dispose()
    e.host.remove()
    this.entries.delete(sid)
    this.order = this.order.filter((x) => x !== sid)
    this.conn.forget(sid)
    if (this.activeSid === sid) this.activeSid = null
    this.h.onChange()
  }

  /** Drops everything (the agent restarted). */
  clear(): void {
    for (const sid of [...this.entries.keys()]) this.remove(sid)
  }

  /**
   * Mounts a session in the visible container and subscribes to it (session-ux.md,
   * subscription strategy).
   *
   *   1. unsubscribe(current session) (unless pinned)
   *   2. mount X.term's DOM → fit()
   *   3. subscribe(X, out_seq, cols, rows)   ← the size rides in this message; no separate resize
   */
  activate(sid: number, container: HTMLElement): void {
    const e = this.entries.get(sid)
    if (!e) return
    if (this.activeSid === sid && e.host.parentElement === container) return

    const prev = this.activeSid !== null ? this.entries.get(this.activeSid) : undefined
    if (prev && prev !== e) {
      prev.host.remove()
      if (!prev.pinned) this.conn.unsubscribe(prev.info.sid)
    }

    container.appendChild(e.host)
    if (!e.opened) {
      e.term.term.open(e.host)
      e.opened = true
    }
    e.term.fit()
    this.activeSid = sid
    this.conn.subscribe(sid, e.term.term.cols, e.term.term.rows)
    this.h.onChange()
  }

  /** Pin: stay subscribed after switching away. Off by default since it costs bandwidth. */
  togglePinned(sid: number): void {
    const e = this.entries.get(sid)
    if (!e) return
    e.pinned = !e.pinned
    if (sid !== this.activeSid) {
      if (e.pinned) this.conn.subscribe(sid)
      else this.conn.unsubscribe(sid)
    }
    this.h.onChange()
  }

  /** An OUTPUT frame (already deduplicated and classified as catch-up or not by the connection). */
  output(sid: number, data: Uint8Array, replay: boolean): void {
    const e = this.entries.get(sid)
    if (!e) return
    e.term.output(data, replay)
    this.maybeExitLine(e)
  }

  /** A complete SNAPSHOT: clear and redraw; if the session has exited, write the notice line again after it. */
  snapshot(sid: number, data: Uint8Array): void {
    const e = this.entries.get(sid)
    if (!e) return
    e.term.snapshot(data)
    e.exitShown = false
    this.maybeExitLine(e)
  }

  /** Theme changed, or the OS switched light/dark: update every instance (layout.md). */
  setTheme(theme: ITheme | undefined): void {
    for (const e of this.entries.values()) e.term.term.options.theme = theme ?? {}
  }

  /**
   * Font size change: update every instance and fit() the mounted one; the others fit on
   * activate(). The caller still owes a resize: the cell size changed but the container
   * didn't, so ResizeObserver stays quiet (AC-5.3).
   */
  setFontSize(px: number): void {
    for (const e of this.entries.values()) {
      e.term.term.options.fontSize = px
      if (e.opened && e.info.sid === this.activeSid) e.term.fit()
    }
  }

  /** The neighbor to switch to after a close: the next one, else the previous one. */
  neighbourOf(sid: number): number | null {
    const ids = this.ordered().map((e) => e.info.sid)
    const i = ids.indexOf(sid)
    if (i < 0) return ids[0] ?? null
    return ids[i + 1] ?? ids[i - 1] ?? null
  }

  /** Previous / next (Ctrl+Shift+↑ / ↓), wrapping around. */
  step(delta: number): number | null {
    const ids = this.ordered().map((e) => e.info.sid)
    if (ids.length === 0) return null
    const i = this.activeSid === null ? -1 : ids.indexOf(this.activeSid)
    const next = (((i + delta) % ids.length) + ids.length) % ids.length
    return ids[next] ?? null
  }

  first(): number | null {
    return this.ordered()[0]?.info.sid ?? null
  }

  dispose(): void {
    for (const e of this.entries.values()) e.term.dispose()
    this.entries.clear()
    this.order = []
    this.activeSid = null
  }

  /**
   * Replaces the order with the agent's full list (welcome.sessions[] order, session.order).
   * Unknown sids are kept as placeholders: for a session another connection just created,
   * session.order may arrive before its session.created (ADR-0040 §2), and it lands where
   * the agent put it. Known sessions missing from the list (just created, closing) follow
   * in their previous relative order.
   */
  setOrder(sids: readonly number[]): void {
    const listed = new Set(sids)
    this.order = [...sids, ...this.order.filter((sid) => !listed.has(sid) && this.entries.has(sid))]
    this.h.onChange()
  }

  /** Moves locally first (takes effect on drop); the agent's session.order is authoritative afterwards. */
  move(sid: number, before: number | null): void {
    this.order = moveBefore(this.order, sid, before)
    this.h.onChange()
  }

  private ordered(): Entry[] {
    return this.order.map((sid) => this.entries.get(sid)).filter((e): e is Entry => e !== undefined)
  }

  /**
   * Process-exited line (AC-4.5): written once when the session has exited and output has
   * caught up (outSeq ≥ headSeq). Not before, or catch-up bytes would land after it.
   */
  private maybeExitLine(e: Entry): void {
    if (e.exitShown || !shouldShowExitLine(e.info.status, this.conn.outSeqOf(e.info.sid), this.conn.headSeqOf(e.info.sid))) {
      return
    }
    e.exitShown = true
    e.term.local(exitLine(e.info.exit_code))
  }
}

/** Whether to write the exit line: exited and caught up. */
export function shouldShowExitLine(status: SessionStatus, outSeq: number, headSeq: number): boolean {
  return status === 'exited' && outSeq >= headSeq
}

/** Display name. The agent already derives it from the CWD (AC-4.4); this is only a fallback. */
export function displayName(s: Pick<SessionInfo, 'name'>): string {
  return s.name || 'shell'
}

/**
 * Input in an exited session (session-ux.md, session end): `\r` closes the session and
 * anything else is dropped. The PTY is gone and the exit line tells the user what to do.
 */
export function routeInput(status: SessionStatus, data: string): 'send' | 'close' | 'drop' {
  if (status !== 'exited') return 'send'
  return data === '\r' ? 'close' : 'drop'
}

/**
 * The CWD shown in the drawer: the home directory or anything under it is abbreviated to
 * `~`, everything else is shown as is. Home comes from `welcome.home` (§4.2); without it
 * nothing is abbreviated, no guessing.
 */
export function shortCwd(cwd: string, home: string | null | undefined): string {
  if (!home || home === '/') return cwd
  const h = home.endsWith('/') ? home.slice(0, -1) : home
  if (cwd === h) return '~'
  if (cwd.startsWith(h + '/')) return '~' + cwd.slice(h.length)
  return cwd
}
