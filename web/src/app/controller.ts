/**
 * App logic: connection ⇄ sessions ⇄ input ⇄ UI state. Components (app.tsx and
 * its children) only render; all state and actions live here (ADR-0025 §9).
 */
import { Connection, type ConnState, type StateInfo, type WebSocketLike } from '../conn/connection'
import { inputTrace, viewOf } from '../keys/inputstats'
import { Sticky, appAction, extraKeyBytes, type ExtraKeyId } from '../keys/keymap'
import { RawIme, cursorPosition } from '../keys/raw'
import { TextPages, type KeyPage, type TextPageEls, type TextSend } from '../keys/textpage'
import { clearLocalData } from './localdata'
import { Code, T, type ServerMessage, type Welcome } from '../protocol/messages'
import { SessionStore, routeInput, type SessionView } from '../sessions/store'
import { installDragWheel, installTapToggle } from '../term/gestures'
import { themeFromCss } from '../term/terminal'
import { inUserInputEvent } from '../term/userinput'
import { applyTheme, readFontSize, readTheme, validFontSize, writeFontSize, writeTheme, type Theme } from '../ui/prefs'
import { debounce, installAppFit, isCoarsePointer, watchCoarse } from '../ui/viewport'
import { readForm, type Form } from './form'

export interface Toast {
  id: number
  kind: 'info' | 'warn' | 'error'
  text: string
}

/** A connection note in the banner (ADR-0049): shown for NOTE_MS next to the state. */
export interface ConnNote {
  id: number
  kind: 'ok' | 'warn'
  text: string
}

export interface ImePreviewState {
  text: string
  left: number
  top: number
}

export interface AppState {
  form: Form
  coarse: boolean
  conn: ConnState
  connInfo: StateInfo
  /** An error reconnecting won't fix (protocol mismatch). */
  fatal: string | null
  /** Device revoked (AC-1.11): the connection is stopped and the UI switches to the pairing page. */
  revoked: boolean
  /** The sign-out confirmation is open (AC-1.22, ADR-0048). */
  signingOut: boolean
  /** This device signed itself out: the UI switches to the pairing page. */
  signedOut: boolean
  /** The agent user's home directory (welcome.home), shown as `~` in CWDs; null means no abbreviation. */
  home: string | null
  /** A welcome has arrived. Before that the session list is unknown, so no empty state is shown. */
  welcomed: boolean
  sessions: SessionView[]
  active: number | null
  maxSessions: number
  toast: Toast | null
  /** Connection note in the banner (ADR-0049): resumed, session ended, refused offline. */
  connNote: ConnNote | null
  preview: ImePreviewState | null
  /** The session drawer (compact). */
  sessionsOpen: boolean
  /** The settings sheet (AC-5.3, ADR-0037). */
  settingsOpen: boolean
  /** The session awaiting close confirmation (AC-4.11, ADR-0038). */
  closing: number | null
  theme: Theme
  /** Terminal font size in px. */
  fontSize: number
  /** Which page the extra-keys slot shows for the active session (tracked per session, ADR-0036). */
  page: KeyPage
}

const TOAST_MS = 3000
/** How long a connection note stays in the banner (ADR-0049). */
export const NOTE_MS = 3000

export class AppController {
  readonly sticky = new Sticky()
  private state: AppState
  private readonly listeners = new Set<() => void>()
  private readonly conn: Connection
  private readonly store: SessionStore
  private readonly enc = new TextEncoder()
  private area: HTMLElement | null = null
  /** Per-session page and draft; the text page follows the session (AC-3.22, ADR-0036). */
  private readonly pages = new TextPages()
  private textPage: TextPageEls | null = null
  private untrackText: (() => void) | null = null
  /** The session whose draft is currently in the text box. */
  private textOwner: number | null = null
  /** The text box is in IME composition (no candidate picked yet). */
  private composing = false
  private ime: RawIme | null = null
  private imeEl: HTMLTextAreaElement | null = null
  private lastWelcome: Welcome | null = null
  private resizeCount = 0
  private reqSeq = 0
  private toastSeq = 0
  private toastTimer: ReturnType<typeof setTimeout> | undefined
  private noteSeq = 0
  private noteTimer: ReturnType<typeof setTimeout> | undefined
  /** session.create requests we sent → whether to focus the session once it exists. */
  private readonly pendingCreate = new Map<string, boolean>()
  /**
   * Whether to return focus to the input once a sheet closes (AC-4.8 / ADR-0037 §4 /
   * ADR-0038 §3), recorded when it opens. For the drawer we record whether the user
   * was typing before it opened, and decide per form factor on select / new.
   */
  private drawerTyping = false
  private settingsRefocus = false
  private closeRefocus = false
  /**
   * Sessions we sent session.close for but haven't seen session.closed (ADR-0038 §5).
   * The agent drops the session from its table first and then waits up to 2s for the
   * process to exit; anything sent to it meanwhile gets unknown_session back.
   */
  private closeSent = new Set<number>()
  /** Extra keys or the text page are feeding the terminal; onData must not apply sticky modifiers again. */
  private keyBypass = false
  /** Set when the connection refuses input (too large, queue full); sendText checks it after paste(). */
  private inputRefused = false
  private lastW = 0
  private lastH = 0
  private readonly sendResize = debounce(() => this.sendResizeNow(), 100)

  /** Asks whether this device is still authorized; resolves to the HTTP status. */
  private readonly authProbe: () => Promise<number>
  private probing = false
  /** Signs this device out on the agent (`POST /auth/logout`); resolves to the HTTP status. */
  private readonly signOutRequest: () => Promise<number>
  /** A sign-out request is in flight: the revocation it causes isn't a "revoked" event. */
  private leaving = false

  constructor(
    opts: {
      url?: string
      clientID?: string
      socketFactory?: (url: string) => WebSocketLike
      authProbe?: () => Promise<number>
      signOut?: () => Promise<number>
    } = {},
  ) {
    this.authProbe = opts.authProbe ?? (() => fetch('/api/devices', { credentials: 'same-origin' }).then((r) => r.status))
    this.signOutRequest =
      opts.signOut ?? (() => fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).then((r) => r.status))
    this.state = {
      form: readForm(),
      coarse: isCoarsePointer(),
      conn: 'connecting',
      connInfo: {},
      fatal: null,
      revoked: false,
      signingOut: false,
      signedOut: false,
      home: null,
      welcomed: false,
      sessions: [],
      active: null,
      maxSessions: 20,
      toast: null,
      connNote: null,
      preview: null,
      sessionsOpen: false,
      settingsOpen: false,
      closing: null,
      theme: readTheme(),
      fontSize: readFontSize(),
      page: 'keys',
    }
    this.conn = new Connection({
      url: opts.url ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
      clientID: opts.clientID ?? clientID(),
      socketFactory: opts.socketFactory,
      handlers: {
        onOutput: (sid, data, replay) => this.store.output(sid, data, replay),
        onSnapshot: (sid, data) => this.store.snapshot(sid, data),
        onMessage: (msg) => this.onMessage(msg),
        onState: (conn, connInfo) => this.set({ conn, connInfo }),
        onRecovered: (bytes) => this.note('ok', `Resumed · caught up ${formatBytes(bytes)}`),
        onRestart: () => {
          const had = this.store.list().length > 0
          this.store.clear()
          if (had) this.note('warn', 'Session ended (agent may have restarted)')
        },
        onFatal: (reason) => this.set({ fatal: reason }),
        onUnauthorized: () => this.revoke(),
        onClosed: (welcomed) => {
          // Closed before any welcome: the upgrade was most likely rejected. Browsers hide the
          // WebSocket HTTP status, so ask REST; 401 means the device was revoked (e.g. while offline).
          if (!welcomed) this.probeAuth()
        },
        onError: (reason) => this.toast('error', reason),
      },
    })
    this.store = new SessionStore(this.conn, {
      onChange: () => this.refresh(),
      onData: (sid, data) => this.onTermData(sid, data),
      onBinary: (sid, data) => this.onTermBinary(sid, data),
      allowKey: (e) => appAction(e) === null,
      theme: () => cssTheme(),
      fontSize: () => this.state.fontSize,
    })
  }

  // ---------- State ----------

  get(): AppState {
    return this.state
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch }
    for (const fn of this.listeners) fn()
  }

  private refresh(): void {
    this.syncTextPage()
    // The session behind an open close-confirm is gone (closed elsewhere, agent restart): close it too, sids are reused (ADR-0038 §4)
    const closing = this.state.closing !== null && this.store.has(this.state.closing) ? this.state.closing : null
    this.set({ sessions: this.store.list(), active: this.store.active, page: this.pages.page(this.store.active), closing })
  }

  private toast(kind: Toast['kind'], text: string): void {
    if (this.toastTimer) clearTimeout(this.toastTimer)
    this.set({ toast: { id: ++this.toastSeq, kind, text } })
    this.toastTimer = setTimeout(() => this.set({ toast: null }), TOAST_MS)
  }

  /**
   * A connection message goes in the banner, not a toast (ADR-0049): every connection
   * message is in one place. It stays for NOTE_MS next to the state, or alone once online.
   */
  private note(kind: ConnNote['kind'], text: string): void {
    if (this.noteTimer) clearTimeout(this.noteTimer)
    this.set({ connNote: { id: ++this.noteSeq, kind, text } })
    this.noteTimer = setTimeout(() => this.set({ connNote: null }), NOTE_MS)
  }

  /**
   * Device revoked (AC-1.11 / E2E-15): stop reconnecting and show the pairing page.
   * Retrying would just collect 401s and look like a network problem.
   */
  private revoke(): void {
    if (this.state.revoked || this.leaving || this.state.signedOut) return
    this.conn.close()
    this.set({ revoked: true, fatal: 'This device has been revoked' })
  }

  private probeAuth(): void {
    if (this.probing || this.state.revoked) return
    this.probing = true
    this.authProbe()
      .then((status) => {
        if (status === 401) this.revoke()
      })
      .catch(() => {
        /* Network down: keep reconnecting as usual */
      })
      .finally(() => {
        this.probing = false
      })
  }

  // ---------- Mount ----------

  /** Call once the terminal container and `.app` exist. Returns the unmount function. */
  mount(area: HTMLElement, root: HTMLElement): () => void {
    this.area = area

    // Fit only when the container size actually changes; ResizeObserver also fires on content changes and subpixel jitter
    const ro = new ResizeObserver(() => this.measure())
    ro.observe(area)
    const unfit = installAppFit(root)
    // The form factor is computed once at load and never again (layout.md §Form).
    // In some environments (Playwright device emulation, some Android WebViews) `screen`
    // tracks the viewport, so recomputing would flip a tablet to compact when the keyboard
    // opens. After moving the window to another display, reload.
    const uncoarse = watchCoarse((coarse) => this.set({ coarse }))

    // Network back / page visible again → retry or probe immediately (AC-2.9 / AC-2.20)
    const kick = () => this.conn.retryNow()
    const onVisible = () => {
      if (document.visibilityState === 'visible') kick()
    }
    window.addEventListener('online', kick)
    document.addEventListener('visibilitychange', onVisible)

    // First two stages of the input-path probe (AC-3.17). Must be capture phase: keys xterm
    // handles get preventDefault + stopPropagation and never bubble.
    const onKeyTrace = () => {
      inputTrace.bump('keydown')
      if (document.activeElement?.classList.contains('xterm-helper-textarea')) inputTrace.bump('toTerm')
    }
    const onKey = (e: KeyboardEvent) => this.onShortcut(e)
    window.addEventListener('keydown', onKeyTrace, true)
    window.addEventListener('keydown', onKey)

    const untap = installTapToggle(area, () => {
      const t = this.activeTerm()
      if (!t) return null
      return {
        mouseTracking: () => t.mouseTracking(),
        focused: () => document.activeElement === t.term.textarea,
        focus: () => t.term.focus(),
        blur: () => t.term.blur(),
      }
    })
    const undrag = installDragWheel(area, () => this.activeTerm() ?? null)

    // Theme follows the system (AC-5.3): when the OS switches light/dark the CSS variables
    // change and xterm must re-read them. Harmless when light or dark is forced.
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    const onScheme = () => this.store.setTheme(cssTheme())
    mq?.addEventListener('change', onScheme)

    ;(window as unknown as { __webterm: unknown }).__webterm = this.hooks()
    this.conn.connect()

    return () => {
      window.removeEventListener('online', kick)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('keydown', onKeyTrace, true)
      window.removeEventListener('keydown', onKey)
      mq?.removeEventListener('change', onScheme)
      ro.disconnect()
      unfit()
      uncoarse()
      untap()
      undrag()
      this.sendResize.cancel()
      this.ime?.dispose()
      this.untrackText?.()
      this.conn.close()
      this.store.dispose()
      if (this.toastTimer) clearTimeout(this.toastTimer)
      if (this.noteTimer) clearTimeout(this.noteTimer)
      this.area = null
    }
  }

  /**
   * The extra-keys component hands over (or withdraws) the text page DOM. From then on,
   * switching sessions flips the page, swaps the draft and moves focus here. Extra keys
   * can appear after sessions (`pointer: coarse` changed at runtime), so load the active
   * session's state on registration.
   */
  registerTextPage(els: TextPageEls | null): void {
    const old = this.textPage
    if (old) this.pages.setDraft(this.textOwner, old.text.value)
    this.untrackText?.()
    this.untrackText = null
    this.composing = false
    this.textPage = els
    if (!els) return
    els.text.value = this.pages.draft(this.textOwner)
    els.slot.dataset.page = this.pages.page(this.textOwner)
    const start = () => (this.composing = true)
    const end = () => (this.composing = false)
    els.text.addEventListener('compositionstart', start)
    els.text.addEventListener('compositionend', end)
    els.text.addEventListener('blur', end)
    this.untrackText = () => {
      els.text.removeEventListener('compositionstart', start)
      els.text.removeEventListener('compositionend', end)
      els.text.removeEventListener('blur', end)
    }
  }

  // ---------- Sessions ----------

  /**
   * Switches to a session. Focus follows the session (AC-4.8): `activate()` detaches the
   * previous session's DOM and focus drops to body, so first record whether focus was in
   * the terminal or text box, then hand it to the new session's input (the text box if it
   * is on the text page, else the terminal, ADR-0036). Non-touch devices always get focus.
   * An explicit `focus` wins (from the drawer: what it was before the drawer opened).
   * Selecting the already-active session leaves focus alone.
   */
  select(sid: number, focus?: boolean): void {
    const area = this.area
    if (!area || !this.store.has(sid)) return
    const typing = this.typing()
    const same = sid === this.store.active
    this.store.activate(sid, area)
    this.attachIme()
    this.syncTextPage()
    if ((focus ?? this.refocus(typing)) && !(same && typing)) this.focusInput()
    this.refresh()
  }

  step(delta: number): void {
    const next = this.store.step(delta)
    if (next !== null && next !== this.store.active) this.select(next)
  }

  newSession(focus?: boolean): void {
    if (this.state.sessions.length >= this.state.maxSessions) {
      this.toast('warn', `Session limit reached (${this.state.maxSessions})`)
      return
    }
    if (this.state.conn !== 'online') {
      this.note('warn', "Can't create a session until reconnected")
      return
    }
    const reqID = `new-${++this.reqSeq}`
    this.pendingCreate.set(reqID, focus ?? this.refocus(this.typing()))
    const sid = this.store.active
    const cur = sid === null ? undefined : this.store.info(sid)
    const t = this.activeTerm()?.term
    this.conn.send({
      t: T.sessionCreate,
      req_id: reqID,
      name: null,
      // Inherit the active session's cwd: usually you want another shell in the same project
      cwd: cur?.cwd || null,
      cols: t?.cols ?? 80,
      rows: t?.rows ?? 24,
    })
  }

  /** Closes a session: `running` ones ask for confirmation first (AC-4.11, ADR-0038), `exited` ones close immediately. */
  requestClose(sid: number): void {
    const info = this.store.info(sid)
    if (!info || this.state.closing !== null) return
    if (info.status !== 'running') {
      this.sendClose(sid)
      return
    }
    // Opened from the drawer: don't return focus (it stays in the drawer)
    this.closeRefocus = !this.state.sessionsOpen && this.refocus(this.typing())
    this.set({ closing: sid })
  }

  /**
   * Confirms the close. Restore focus before sending session.close: on session.closed we
   * switch to a neighbor and focus it only if focus is in the terminal (AC-4.8). Sending
   * first would read as "not typing".
   */
  confirmClose(): void {
    const sid = this.state.closing
    if (sid === null) return
    this.endClosing()
    if (this.store.has(sid)) this.sendClose(sid)
  }

  cancelClose(): void {
    if (this.state.closing === null) return
    this.endClosing()
  }

  private endClosing(): void {
    this.set({ closing: null })
    if (this.closeRefocus) this.focusInput()
  }

  private sendClose(sid: number): void {
    if (this.closeSent.has(sid)) return
    // Offline sends are dropped silently; don't mark it as closing, or after reconnecting it would be alive but ignore input
    if (this.state.conn !== 'online') {
      this.note('warn', "Can't close the session until reconnected")
      return
    }
    this.closeSent.add(sid)
    this.conn.send({ t: T.sessionClose, req_id: `close-${++this.reqSeq}`, sid })
  }

  /**
   * Renames a session; an empty name goes back to the automatic CWD-based name. Unchanged
   * names (confirming the auto name as-is) are not sent, so the session keeps following its CWD.
   */
  rename(sid: number, name: string): void {
    const trimmed = name.trim()
    const info = this.store.info(sid)
    if (!info || trimmed === info.name) return
    this.conn.send({ t: T.sessionRename, req_id: `rename-${++this.reqSeq}`, sid, name: trimmed === '' ? null : trimmed })
  }

  togglePin(sid: number): void {
    this.store.togglePinned(sid)
  }

  /** Drag-to-reorder drop (ADR-0040): move locally, then tell the agent; session.order is authoritative. */
  moveSession(sid: number, before: number | null): void {
    if (!this.store.has(sid)) return
    this.store.move(sid, before)
    this.conn.send({ t: T.sessionMove, req_id: `move-${++this.reqSeq}`, sid, before })
  }

  // ---------- Sheets ----------

  openSessions(): void {
    this.drawerTyping = this.typing()
    this.set({ sessionsOpen: true, settingsOpen: false })
  }

  closeSessions(): void {
    this.set({ sessionsOpen: false })
  }

  /**
   * Picks a session in the drawer: closes it and restores focus as it was before the drawer
   * opened (inside this click, so iOS shows the keyboard).
   */
  selectFromDrawer(sid: number): void {
    this.set({ sessionsOpen: false })
    this.select(sid, this.refocus(this.drawerTyping))
  }

  newFromDrawer(): void {
    this.set({ sessionsOpen: false })
    this.newSession(this.refocus(this.drawerTyping))
  }

  /**
   * Opens settings (ADR-0037 §2). When opened from the session drawer, focus is in the
   * drawer, so "where focus was" means before the drawer opened.
   */
  openSettings(): void {
    this.settingsRefocus = this.refocus(this.state.sessionsOpen ? this.drawerTyping : this.typing())
    this.set({ settingsOpen: true, sessionsOpen: false })
  }

  /** Closes settings; returns focus if the user was typing before or on non-touch devices (ADR-0037 §4). */
  closeSettings(): void {
    if (!this.state.settingsOpen) return
    this.set({ settingsOpen: false })
    if (this.settingsRefocus) this.focusInput()
  }

  // ---------- Sign out (AC-1.22, ADR-0048) ----------

  /**
   * "Sign out this device" in settings: closes settings and asks first. Offline it
   * refuses: the token can only be revoked on the agent, and clearing just the local
   * copy would leave one the agent still accepts.
   */
  requestSignOut(): void {
    if (this.state.conn !== 'online') {
      this.note('warn', "Can't sign out until reconnected")
      return
    }
    this.set({ signingOut: true, settingsOpen: false })
  }

  cancelSignOut(): void {
    if (!this.state.signingOut) return
    this.set({ signingOut: false })
    if (this.settingsRefocus) this.focusInput()
  }

  /**
   * Revokes this device on the agent, then stops the connection and clears local data.
   * A 401 means the device is already not authorized, which is the same outcome. Any
   * other failure leaves everything as it was.
   */
  async confirmSignOut(): Promise<void> {
    if (!this.state.signingOut) return
    this.set({ signingOut: false })
    this.leaving = true
    let status: number
    try {
      status = await this.signOutRequest()
    } catch {
      this.leaving = false
      this.toast('error', "Couldn't reach the agent; still signed in")
      return
    }
    if (status !== 204 && status !== 401) {
      this.leaving = false
      this.toast('error', `Sign-out failed (HTTP ${status}); still signed in`)
      return
    }
    this.conn.close()
    await clearLocalData()
    this.set({ signedOut: true })
  }

  // ---------- Preferences (AC-5.3, ADR-0037) ----------

  setTheme(theme: Theme): void {
    if (theme === this.state.theme) return
    applyTheme(theme)
    writeTheme(theme)
    this.set({ theme })
    this.store.setTheme(cssTheme())
  }

  /** Changes font size: all terminals → fit → explicit resize (the container didn't change, so ResizeObserver stays quiet). */
  setFontSize(px: number): void {
    if (!validFontSize(px) || px === this.state.fontSize) return
    writeFontSize(px)
    this.set({ fontSize: px })
    this.store.setFontSize(px)
    this.measure(true)
  }

  // ---------- Input ----------

  /**
   * Extra key press (called from the pointer event dispatch): computes bytes from the sticky
   * modifiers and DECCKM, then goes out through onData.
   */
  pressKey(id: ExtraKeyId): void {
    const t = this.activeTerm()
    if (!t) return
    const bytes = extraKeyBytes(id, this.sticky.take(), t.term.modes.applicationCursorKeysMode)
    if (!bytes) return
    this.keyBypass = true
    try {
      t.term.input(bytes, true)
    } finally {
      this.keyBypass = false
    }
  }

  /**
   * Enter on the text page (called from the keydown dispatch, ADR-0027). The text goes in as
   * a paste and Enter is typed separately: written together as "long text + \r", claude
   * treats it as one paste and swallows the \r. Sticky modifiers apply to neither; with ALT
   * active, Enter would become ESC \r, which claude reads as a newline.
   */
  sendText(send: TextSend): boolean {
    const t = this.activeTerm()
    if (!t || send.kind !== 'submit') return false
    this.keyBypass = true
    this.inputRefused = false
    try {
      // paste() reaches onTermData synchronously, so a refusal is known right after it.
      // A refused paste must not be followed by Enter: that would run whatever was on the
      // line, and the text box would be cleared as if the text had gone out.
      if (send.text !== '') t.term.paste(send.text)
      if (this.inputRefused) return false
      t.term.input('\r', true)
      return true
    } finally {
      this.keyBypass = false
    }
  }

  focusTerm(): void {
    this.activeTerm()?.term.focus()
  }

  /**
   * ✎ or a horizontal swipe on the key area: flips the active session's page (ADR-0036).
   * The DOM page flips synchronously: the focus() below needs the text box visible now, and
   * iOS only shows the keyboard if focus happens inside this click / pointerup handler.
   */
  togglePage(): void {
    const sid = this.store.active
    const next: KeyPage = this.pages.page(sid) === 'keys' ? 'text' : 'keys'
    this.pages.setPage(sid, next)
    const el = this.textPage
    if (el) el.slot.dataset.page = next
    this.set({ page: next })
    if (next === 'text') el?.text.focus({ preventScroll: true })
    else if (el && document.activeElement === el.text) this.focusTerm()
  }

  /** Focuses the active session's input: the text box if it is on the text page (and that page is mounted), else the terminal. */
  private focusInput(): void {
    const el = this.textPage
    if (el && this.pages.page(this.store.active) === 'text') el.text.focus({ preventScroll: true })
    else this.focusTerm()
  }

  /**
   * When the active session changes (switch, close, agent restart), load its draft into the
   * text box and flip the extra-keys slot to its page (AC-3.22). If the old session still
   * exists, save the box contents as its draft first. During IME composition, blur first so
   * the IME commits the pending text before we save; setting `value` directly makes the IME
   * drop characters or append them to the new session's draft (ADR-0036 §3).
   */
  private syncTextPage(): void {
    this.pages.retain((s) => this.store.has(s))
    const sid = this.store.active
    if (sid === this.textOwner) return
    const el = this.textPage
    const owner = this.textOwner
    this.textOwner = sid
    if (!el) return
    if (this.composing && document.activeElement === el.text) el.text.blur()
    if (owner === null || this.store.has(owner)) this.pages.setDraft(owner, el.text.value)
    el.text.value = this.pages.draft(sid)
    el.slot.dataset.page = this.pages.page(sid)
  }

  private onTermData(sid: number, data: string): void {
    // Closing: send neither keystrokes nor focus reports (tmux / claude enable mode 1004) (ADR-0038 §5)
    if (this.closeSent.has(sid)) return
    // Never send a byte during IME composition; it is committed once on compositionend (AC-3.3)
    if (sid === this.store.active && this.ime?.isComposing) return
    // Sticky CTRL / ALT also applies to the next character from the on-screen keyboard; extra keys already applied it
    const out = inUserInputEvent() && !this.keyBypass ? this.sticky.apply(data) : data
    const info = this.store.info(sid)
    if (!info) return
    switch (routeInput(info.status, out)) {
      case 'send':
        if (!this.conn.sendInput(sid, this.enc.encode(out))) this.inputRefused = true
        break
      case 'close':
        this.requestClose(sid)
        break
      case 'drop':
        break
    }
  }

  private onTermBinary(sid: number, data: string): void {
    if (this.closeSent.has(sid) || this.store.info(sid)?.status !== 'running') return
    this.conn.sendInput(sid, Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff))
  }

  private onShortcut(e: KeyboardEvent): void {
    const act = appAction(e)
    if (act === null) return
    e.preventDefault()
    const sid = this.store.active
    switch (act) {
      case 'newSession':
        this.newSession()
        break
      case 'closeSession':
        if (sid !== null) this.requestClose(sid)
        break
      case 'prevSession':
        this.step(-1)
        break
      case 'nextSession':
        this.step(1)
        break
      case 'toggleSessions':
        // No-op on wide: sessions are in the tab bar
        if (this.state.form === 'compact') {
          if (this.state.sessionsOpen) this.closeSessions()
          else this.openSessions()
        }
        break
    }
  }

  /**
   * Attaches the IME handler to the active session's helper textarea. Every session has its
   * own xterm and therefore its own textarea, so it must be re-attached on every switch, or
   * bytes typed during composition would go straight to the PTY (AC-3.3).
   */
  private attachIme(): void {
    const helper = this.area?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea') ?? null
    if (!helper || helper === this.imeEl) return
    this.ime?.dispose()
    this.imeEl = helper
    this.ime = new RawIme(helper, {
      // Same onData exit as everything else: replay gate, sticky modifiers and inputStats all apply
      onCommit: (text) => this.activeTerm()?.term.input(text, true),
      onPreview: (text) => this.set({ preview: text ? this.previewAt(text) : null }),
    })
  }

  private previewAt(text: string): ImePreviewState | null {
    const t = this.activeTerm()
    const screen = this.area?.querySelector<HTMLElement>('.xterm-screen')
    const stage = this.area?.parentElement
    if (!t || !screen || !stage) return null
    const s = screen.getBoundingClientRect()
    const g = stage.getBoundingClientRect()
    const cell = { width: s.width / Math.max(t.term.cols, 1), height: s.height / Math.max(t.term.rows, 1) }
    const buf = t.term.buffer.active
    const pos = cursorPosition(buf.cursorX, buf.cursorY, cell)
    return { text, left: s.left - g.left + pos.left, top: s.top - g.top + pos.top }
  }

  // ---------- Size ----------

  /**
   * Container size changed → fit → debounced resize. `force` is for when the container is
   * the same but the cell size changed (font size): size dedup would swallow the whole
   * measurement and the client and PTY would disagree on cols/rows.
   */
  private measure(force = false): void {
    const area = this.area
    if (!area) return
    const w = area.clientWidth
    const h = area.clientHeight
    if (!force && w === this.lastW && h === this.lastH) return
    this.lastW = w
    this.lastH = h
    const t = this.activeTerm()
    if (!t) return
    t.fit()
    this.sendResize()
  }

  private sendResizeNow(): void {
    const sid = this.store.active
    const t = this.activeTerm()?.term
    if (sid === null || !t || this.closeSent.has(sid)) return
    this.conn.send({ t: T.resize, sid, cols: t.cols, rows: t.rows })
    this.resizeCount++
  }

  // ---------- Messages ----------

  private onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case T.welcome:
        this.onWelcome(msg)
        break
      case T.sessionCreated: {
        this.store.upsert(msg.session)
        const focus = msg.req_id === undefined ? undefined : this.pendingCreate.get(msg.req_id)
        if (focus !== undefined) {
          this.pendingCreate.delete(msg.req_id!)
          this.select(msg.session.sid, focus)
        } else if (this.store.active === null) {
          this.select(msg.session.sid)
        }
        break
      }
      case T.sessionClosed:
        this.closeLocal(msg.sid)
        break
      case T.sessionOrder:
        this.store.setOrder(msg.sids)
        break
      case T.sessionUpdated: {
        const { t: _t, sid, head_seq: _head, ...patch } = msg
        this.store.patch(sid, patch)
        break
      }
      case T.error:
        // Closing or already-gone sessions: unknown_session is expected, no toast (ADR-0038 §5)
        if (msg.code === Code.unknownSession && msg.sid !== undefined && (this.closeSent.has(msg.sid) || !this.store.has(msg.sid))) break
        if (msg.code === Code.sessionLimit) this.toast('warn', `Session limit reached (${this.state.maxSessions})`)
        else if (msg.code !== Code.unauthorized && msg.code !== Code.protocolUnsupported && msg.code !== Code.sessionExited) {
          this.toast('error', msg.message || msg.code)
        }
        break
      case T.notice:
        this.toast(msg.level, msg.message)
        break
    }
    this.refresh()
  }

  private onWelcome(w: Welcome): void {
    const first = !this.state.welcomed
    this.lastWelcome = w
    let gone = false
    for (const r of w.resumed) {
      if (r.status !== 'gone') continue
      if (this.store.has(r.sid)) gone = true
      this.store.remove(r.sid)
    }
    // Sessions closed while we were offline
    const live = new Set(w.sessions.map((s) => s.sid))
    for (const s of this.store.list()) if (!live.has(s.sid)) this.store.remove(s.sid)
    for (const s of w.sessions) this.store.upsert(s)
    // A session still in the welcome never got our session.close (disconnect, or sid reused after an agent restart): no longer closing
    this.closeSent.clear()
    // welcome.sessions[] is in display order (ADR-0040)
    this.store.setOrder(w.sessions.map((s) => s.sid))
    if (gone) this.note('warn', 'Session ended (agent may have restarted)')
    this.set({ welcomed: true, maxSessions: w.limits.max_sessions, fatal: null, home: w.home || null })

    const active = this.store.active
    if (active === null) {
      const firstSid = this.store.first()
      if (firstSid !== null) this.select(firstSid)
      else if (first) this.newSession()
      return
    }
    // Reconnect: the terminal may have resized while offline (keyboard, rotation) and those resizes were never sent
    const t = this.activeTerm()?.term
    const info = this.store.info(active)
    if (t && info && (t.cols !== info.cols || t.rows !== info.rows)) this.sendResizeNow()
  }

  private closeLocal(sid: number): void {
    const wasActive = this.store.active === sid
    const typing = this.typing()
    const next = wasActive ? this.store.neighbourOf(sid) : null
    // Mark as closing before tearing down: dispose blurs xterm, and programs with focus reporting would emit another ESC [O
    this.closeSent.add(sid)
    this.store.remove(sid)
    this.closeSent.delete(sid)
    if (next !== null) this.select(next, this.refocus(typing))
  }

  private activeTerm() {
    const sid = this.store.active
    return sid === null ? undefined : this.store.termOf(sid)
  }

  /** Whether focus is in an input (the terminal or the text page). */
  private typing(): boolean {
    const el = document.activeElement
    return (!!this.textPage && el === this.textPage.text) || !!this.area?.contains(el)
  }

  /** Whether to focus the input: if the user was typing, or always on non-touch devices (AC-4.8). */
  private refocus(typing: boolean): boolean {
    return typing || !this.state.coarse
  }

  // ---------- Debug / E2E hooks ----------

  /** `window.__webterm` (e2e-scenarios.md; inputStats also ships in production builds, AC-3.17). */
  private hooks() {
    const term = () => this.activeTerm()?.term
    return {
      /** The active session's full buffer text, scrollback included. */
      text: () => {
        const t = term()
        if (!t) return ''
        const buf = t.buffer.active
        const out: string[] = []
        for (let i = 0; i < buf.length; i++) out.push(buf.getLine(i)?.translateToString(true) ?? '')
        return out.join('\n')
      },
      /** SerializeAddon output, for byte-level comparisons. */
      serialize: () => this.activeTerm()?.serialize.serialize() ?? '',
      outSeq: () => (this.store.active === null ? 0 : this.conn.outSeqOf(this.store.active)),
      size: () => ({ cols: term()?.cols ?? 0, rows: term()?.rows ?? 0 }),
      welcome: () => this.lastWelcome,
      resizes: () => this.resizeCount,
      sid: () => this.store.active,
      form: () => this.state.form,
      fontSize: () => term()?.options.fontSize ?? 0,
      altScreen: () => this.activeTerm()?.altScreen() ?? false,
      unread: (sid: number) => this.conn.isUnread(sid),
      /** Recently received binary frames `{type, kind, sid, seq, flags, bytes, replay}`. */
      frames: () => this.conn.frames(),
      scrollLines: (n: number) => term()?.scrollLines(n),
      viewport: () => {
        const t = term()
        if (!t) return { y: -1, top: '' }
        const buf = t.buffer.active
        return { y: buf.viewportY, top: buf.getLine(buf.viewportY)?.translateToString(true) ?? '' }
      },
      // When typing does nothing, shows which stage the input stopped at (AC-3.17)
      inputStats: () =>
        viewOf(
          inputTrace.snapshot({
            unackedBytes: this.store.active === null ? 0 : this.conn.unackedOf(this.store.active),
            focus: focusName(document.activeElement),
            sid: this.store.active,
          }),
          Date.now(),
        ),
    }
  }
}

/**
 * client_id keys the input accounting (§4.1 / §5.4). One per page load, in memory only;
 * it stays stable across reconnects because the Connection object lives on.
 *
 * It must not go in sessionStorage: after a reload the tab and id would be the same, the
 * agent's in_ack for (client_id, sid) would still hold the pre-reload total, and the new
 * page's in_seq restarts at 0. The first N bytes typed after the reload would be dropped
 * silently as already-processed resends (seen in E2E-36 ⑤), violating ADR-0020.
 */
function clientID(): string {
  return crypto.randomUUID()
}

function cssTheme() {
  const style = getComputedStyle(document.documentElement)
  return themeFromCss((n) => style.getPropertyValue(n))
}

function focusName(el: Element | null): string {
  if (!el || el === document.body) return ''
  return el.className || (el as HTMLElement).dataset?.testid || el.tagName.toLowerCase()
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
