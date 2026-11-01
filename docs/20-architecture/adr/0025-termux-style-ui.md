# ADR-0025 Termux-style UI: full-screen terminal, two rows of extra keys, session switching by device form

Status: Accepted (2026-10-30). Rolled out as milestones m8–m10 (see [Rollout](#rollout)).

Later changes:

- **§3 Enter behavior and send path**: revised by [ADR-0027](0027-text-page-enter-submits.md). Enter with content sends the content **and** a carriage return (`term.paste()`, then `\r`).
- **§3 text page**: revised by [ADR-0036](0036-text-page-per-session.md). Each session keeps its own page and draft; switching sessions swaps both, and focus goes to the new session's input.
- **§5 vertical drag**: revised by [ADR-0029](0029-touch-drag-to-wheel.md). xterm ignores touch drags when mouse tracking is on, so webterm converts vertical drags to wheel events (one per row of finger movement, per [ADR-0032](0032-drag-wheel-per-row.md)).
- **Settings**: removed by [ADR-0030](0030-no-settings.md). §4's ☰ became a session button showing the session count and both ⚙ entries went away; §5's font size is fixed at 14px until m10; §7's `Ctrl+Shift+,` is no longer bound; §8's config row became "no configuration"; m9's configurable key layout (§2) was dropped. Settings came back with [ADR-0037](0037-settings-theme-and-font-size.md), limited to theme and terminal font size: a line-icon ⚙ at the right end of the tab bar and at the bottom of the session drawer. `Ctrl+Shift+,` stays unbound.
- **§4 `wide` tab width**: revised by [ADR-0031](0031-tabs-equal-width.md). Tabs share the available width equally (120–240px), scroll horizontally when they don't fit, and the mouse wheel scrolls the tab strip sideways.
- **§4 `wide` `+` button**: revised by [ADR-0035](0035-tabbar-new-button-pinned.md). It sits outside the scrolling tab strip, always visible, behind a non-clickable gap, drawn as an icon aligned with the status dot.

Supersedes:

- [ADR-0007](0007-dual-mode-input.md) (dual-mode input) entirely, including the internal composer/raw state machine; nothing in the new UI consumes it.
- [ADR-0013](0013-terminal-only.md) §2–§5 (input bar, per-program key rows, visual zoom with the PTY fixed at 43 columns, mobile chrome). **§1, "the terminal is the only display surface", carries over.**
- [ADR-0014](0014-input-toggle.md) (input toggle key) and [ADR-0015](0015-bottom-keyrow.md) (single bottom key row) entirely.
- The ⋯ menu, history sheet and tablet session sheet from [ADR-0018](0018-one-drawer-primitive.md). **The `Drawer` primitive stays**, used for settings and the phone session list.
- The subject of [ADR-0021](0021-drag-preview-not-live-relayout.md) (the desktop sidebar). **Its principle, "preview while dragging, relayout on release", carries over to pinch-to-zoom.**
- [ADR-0008](0008-pinned-history-as-snippets.md) (pinned history as snippets) entirely. [ADR-0006](0006-agent-side-osc-parsing.md) and [ADR-0010](0010-bash-rcfile-injection.md) (shell integration) are superseded wholesale by [ADR-0026](0026-agent-holds-terminal-state.md); see [§10](#10-backend-and-protocol-that-become-dead-code).

[ADR-0026](0026-agent-holds-terminal-state.md) revised parts of this ADR before it shipped: the output path (scrollback hint, budgeted writer, WebGL, custom touch scrolling, client snapshot) goes native, shell integration is deleted (§10), and the original steps 1 and 2 merged into one PR ([Rollout](#rollout)). The text below already reflects that.

Unchanged: resume and byte-level continuity (AC-2.1 ★); [ADR-0020](0020-input-never-silently-dropped.md) (input is never silently dropped: replay gate, IME fallback, `inputStats`); [ADR-0023](0023-terminal-font-list.md) (terminal font list); [ADR-0024](0024-scrollback-layered-model.md) §1 (keep claude on the main screen). All protocol changes come from ADR-0026.

## Context

### The old UI was eight rounds of layering

ADR-0007 through ADR-0022 reworked the input area and session entry points eight times. Each round had measurements behind it, but together they asked users to learn all of this:

| Concept | Source |
|---|---|
| Toggle key (terminal input ⇄ edit panel) | ADR-0014 |
| Edit panel with three sizes (collapsed / half / full), grab handle, chips (same-directory history / path completion / snippets), edit key row, long-press send = no Enter | ADR-0011 ③, ADR-0015 |
| Key area that changes with whatever owns the screen: prompt keys, generic keys, and one set each for less / top / vim / nano / AI / generic TUI | ADR-0011 ②, ADR-0015 |
| Internal composer/raw mode (invisible to users, only drives the key area) | ADR-0007 |
| ⋯ action sheet → session / history / settings sheets | ADR-0013 §5, ADR-0018 |
| Four layouts (phone / tablet / desktop / short); desktop sidebar resize, snap, collapse | layout-responsive.md, ADR-0021 |
| Swipe to switch sessions, two-finger visual zoom, double-tap zoom, PTY fixed at 43 columns | AC-4.7, ADR-0013 §4 |

All of it converged in `web/src/ui/app.tsx`, which had grown to 1271 lines. About 4.5k of the frontend's 7761 lines were this UI layer.

### Why Termux works

The user asked for the Termux experience: simple and convenient. Termux has few concepts, and almost all of them are static:

- One full-screen terminal, no title bar, no status bar.
- Two fixed rows of extra keys (`ESC / - HOME ↑ END PGUP` / `TAB CTRL ALT ← ↓ → PGDN`). They don't change with the foreground program, so their positions become muscle memory after a few uses.
- Sessions live in a drawer; one tap switches.
- Pinch changes the font size; long-press selects text.
- For text that needs an IME, such as Chinese, swipe the extra-key row left to reveal a native text field.

The convenience comes from **fixed positions and predictable behavior**. The old UI's context-dependent keys and panels were the opposite.

Termux is a native app. Some things a web page can't do, and in some places webterm already had a sturdier decision; see [§8](#8-where-we-dont-copy-termux).

## Decision

### 1. One terminal, two device forms

The terminal fills the available area, with no title bar or status bar. Devices come in two **forms**, set on `.app[data-form]`:

| Form | Devices | Rule |
|---|---|---|
| `compact` | Phones (including landscape) | `min(screen.width, screen.height) < 600` |
| `wide` | PCs, tablets | Everything else |

**The rule uses the screen's short side, not the viewport width**, for three reasons:

- The user's split is by device ("on a phone…", "on a PC or tablet…"), not by window width.
- Screen size doesn't change with the on-screen keyboard, rotation or the address bar, so the form **never flips during use** and never causes a terminal relayout or a SIGWINCH. A viewport rule can't promise that: in browsers that shrink the layout viewport for the keyboard (`resizes-content`), a landscape tablet drops below 480px tall when the keyboard opens and the form would flip back and forth.
- Phones top out around 440px on the short side and tablets start around 600px (iPad mini: 744px), leaving a comfortable gap.

This replaces the phone / tablet / desktop / short breakpoints and the rule that breakpoints depend only on viewport width. Screen size is not UA sniffing; "no UA sniffing" still holds.

The two forms differ **only in how sessions are switched** (§4). Terminal, extra keys, text page and gestures are identical.

```
compact (phone)                          wide (PC / tablet)
┌──────────────────────────────┐        ┌ ● webterm ✕│○ api •│○ logs│ + ──── ● ⚙ ┐ tab bar
│                              │        │                                         │
│           terminal           │        │                terminal                 │
│                              │        │                                         │
├────┬─────────────────────────┤        ├────┬────────────────────────────────────┤
│ ☰• │ ESC  /   -  HOME ↑ END PGUP│      │    │ ESC   /    -   HOME   ↑   END  PGUP │ extra keys
│ ✎  │ TAB CTRL ALT ←   ↓  →  PGDN│      │ ✎  │ TAB  CTRL ALT   ←    ↓    →   PGDN │ (touch only)
└────┴─────────────────────────┘        └────┴────────────────────────────────────┘
```

### 2. Extra keys: two static rows with Termux's default layout

- **When shown**: on `compact`, or when `pointer: coarse`. Always on phones, on touch tablets, never on mouse-and-keyboard devices.
- **The default layout is Termux's default**, 14 keys:
  ```
  ESC  /    -    HOME  ↑  END  PGUP
  TAB  CTRL ALT  ←     ↓  →    PGDN
  ```
- **Static**: the layout doesn't change with the foreground program, prompt state or shell integration. The old prompt key set, generic key set and six per-program sets are gone. less's `q` and vim's `:wq` are typed on the on-screen keyboard; the extra keys provide what that keyboard lacks.
- **Geometry**: two 40px rows (80px total), equal-width keys within a row, no horizontal scrolling. A fixed 44px left column holds ☰ (top) and ✎ (bottom) on `compact`, and only ✎ (spanning both rows) on touch `wide`. At 393px wide each key is about 50px. The 40px row height is a deliberate exception to the 44×44 hit-target rule, following Termux's 37.5dp; the width makes up for it.
- **Never steal focus**: every key calls `preventDefault` on `pointerdown`, so pressing one never opens or closes the on-screen keyboard.
- **Same encoding as a physical keyboard**: byte mapping in [`keymap.md`](../../40-frontend/keymap.md). Arrows, `HOME` and `END` follow application cursor key mode (DECCKM, `term.modes.applicationCursorKeysMode`) and send `ESC O A` instead of `ESC [ A` when it's on.
- **Sticky CTRL / ALT**: tap to apply to the next key only; long-press to lock; tap again to release. The next key typed on the on-screen keyboard counts too. Active and locked states must be visibly different.
- **Added in m9**:
  - Swipe up on a key to send its secondary key. Defaults: `-` → `|`, `/` → `~`, the two characters the old UI showed were hardest to reach on on-screen keyboards.
  - Auto-repeat: `↑ ↓ ← → PGUP PGDN` repeat every 60ms after a 400ms hold.
  - Configurable layout in settings using Termux's `extra-keys` syntax, stored in `localStorage['webterm.extraKeys']`. On a parse error, fall back to the default and show the error; never fail silently.

### 3. Text page: replaces the Composer

The extra-key area has two pages, the **key page** and the **text page**, both 80px tall, so switching never changes terminal geometry.

- **Switching**: tap ✎ (the visible entry point), or swipe left/right on the key area (a shortcut, not the only way).
- **Text page**: a two-line `textarea` filling the key area, except the left column.
  - Font size ≥ 16px, so iOS doesn't zoom the page on focus.
  - `enterkeyhint="send"`.
  - `autocorrect` / `autocapitalize` / `spellcheck` must be turned off with `setAttribute`. Chrome treats `autocorrect` as a boolean attribute, so writing it in JSX reflects as `on` (see input.md).
- **What Enter does** (as in Termux):
  - During IME composition (`isComposing`): nothing.
  - With content: send the content, **without a trailing carriage return**.
  - Empty: send `\r`.
  - Enter **never inserts a newline** into the text field.

  The idea was to drop a paragraph into claude's input box, finish editing it there, then submit with an empty Enter. The old hidden gesture "long-press send = no Enter" goes away.
- **How content is sent**: content without newlines is equivalent to typing it, and takes the same `onData` path as key presses: `inputStats` counts it and the replay gate judges it per event (ADR-0020). Content with newlines (only possible via paste) goes through `term.paste()`, which wraps it in bracketed paste if the remote side enabled it.
- After sending, clear the field and **stay on the text page with focus**, ready for the next chunk.
- Mouse-and-keyboard devices have no extra keys and therefore no text page. A physical-keyboard IME types straight into the terminal, handled by `RawIme`'s composition and direct-insert logic (AC-3.3 / AC-3.14), both kept.

Removed along with the Composer: chips, `↑ ↓` history, path completion, the edit key row, multi-line editing, and the half/full-screen sizes.

### 4. Session switching

**`compact` (phone): ☰ opens a bottom drawer**

- ☰ is the top cell of the extra keys' left column. If any session other than the current one has unread output (`head_seq > out_seq`), ☰ shows a small red dot.
- ☰ opens a `Drawer`, bottom-anchored and full width as in [ADR-0018](0018-one-drawer-primitive.md). Top to bottom:
  - the session list, with stable numbers like `[1] webterm  ~/github/webterm`, unread dots, and exited sessions grayed out;
  - a fixed bottom row: "+ New session · ⚙ Settings".
- Long-press a session for the session menu: "Rename · Pin · Close". "Pin" is the existing pinned subscription (the session keeps receiving output while switched away, see session-ux.md); in the old UI it was the ⇵ icon on the row.
- Close the drawer by tapping the backdrop, choosing a session, `Esc`, or the system back button. Swiping down also works, as a shortcut.
- **On-screen keyboard**: opening the drawer moves focus into it and closes the keyboard, so the drawer gets the full height. After a session is chosen, if focus was in the terminal **before the drawer opened**, focus the new session's terminal within that click handler so the keyboard comes back (iOS only opens the keyboard from a user gesture). This is ADR-0020's "focus follows the session" applied to the drawer.
- **System back button**: `history.pushState` when the drawer opens; close it on `popstate`. When it's closed any other way, call `history.back()` to remove that entry so entries don't pile up. Otherwise back exits the app in an Android PWA.
- `Ctrl+Shift+B` toggles the drawer.

**`wide` (PC / tablet): a tab bar at the top** (modeled on Termius)

- 36px tall, 40px on touch. Left to right: session tabs, `+`, space, connection status dot, ⚙.
- A tab shows the session name and an unread dot. Pinned sessions have a small marker before the name. Exited sessions are grayed out.
- Close with ✕. On mouse devices it shows on hover and on the current tab; on touch, only on the current tab, to avoid accidental taps. Middle-click also closes.
- Right-click (mouse) or long-press (touch) a tab for the same session menu as on the phone. Double-click starts renaming directly (a mouse shortcut). While renaming, the tab turns into an input in place; `Enter` confirms, `Esc` cancels.
- Tabs are in creation order with no drag reordering ([ADR-0040](0040-session-order-drag.md) later added it). Overflowing tabs scroll horizontally; when the current tab changes, scroll it into view without smooth scrolling.
- Switching tabs never changes terminal geometry. The tab bar is always there, decided once at page load.

**Both forms**

- The selected item uses the accent color and hover uses neutral gray, so they differ in hue; the selected item has `aria-current="true"`. This rewrites AC-4.9 from "sidebar / drawer / sheet" to "tab / list item".
- Closing a session works as before; for the `Ctrl+Shift+W` confirmation rules see keymap.md.

### 5. Touch gestures on the terminal

| Gesture | Behavior | Milestone |
|---|---|---|
| Tap | If the program has mouse tracking on, xterm handles it: the browser synthesizes mouse events from the touch and xterm reports a click in the program's protocol. Otherwise, toggle the on-screen keyboard (`blur` if the terminal has focus, `focus` if not) | m8 |
| Vertical drag | xterm's built-in touch scrolling (scrollback on the main screen). On the alternate screen with mouse tracking, xterm reports per its own rules; without it, nothing moves. Our own per-frame scrolling and inertia are removed ([ADR-0026](0026-agent-holds-terminal-state.md) §7) until measurements say otherwise | m8 |
| Horizontal drag | **Nothing.** Swipe to switch sessions (AC-4.7) is removed | m8 |
| Pinch | **Change the font size**, with a real relayout (below) | m10 |
| Long-press | Select the word under the finger (below) | m10 |

**Pinch to change the font size** (replaces visual zoom and the fixed 43-column PTY):

- During the pinch, only set a CSS `transform: scale()` on `.xterm-screen` as a preview: no `fit()`, no `resize`. This inherits ADR-0021's "preview while dragging".
- On release, the new size is `clamp(round(start size × scale), 8, 32)`. Set `fontSize` on every xterm instance, `fit()` the mounted one, then **send an extra `resize`**: the cell size changed but the container didn't, so `ResizeObserver` won't fire (the AC-5.3 rule still applies).
- The size is stored per form: `webterm.fontSize.compact` / `webterm.fontSize.wide`, both defaulting to 14px.
- Double-tap zoom is removed. Until m10, the font size is changed in settings.

**Long-press selection**:

- A press of ≥ 500ms moving < 10px selects the word under the finger (`term.select`), shows drag handles at both ends, and a floating bar above: "Copy · Paste · More…". "More" offers:
  - **Select link**: lists the http(s) links in view; tapping one opens it in a new tab.
  - **Share**: shares the selection if there is one, otherwise the visible screen text, via the Web Share API; falls back to copying.
  - **Keep screen on**: a Wake Lock toggle. The browser releases the lock when the page is hidden; re-acquire it on return if the toggle is still on.
- Tapping outside the selection exits it. New output doesn't destroy the selection (AC-5.4).
- Paste reads `navigator.clipboard.readText()` and calls `term.paste()`.

Selection, copy and paste on mouse-and-keyboard devices keep xterm's and the browser's defaults; this ADR doesn't change them.

### 6. Status and notices

- **Connection status**:
  - `compact` shows nothing while connected. When not online, a thin banner overlays the top of the terminal with the state and a retry countdown. It's absolutely positioned over the terminal and doesn't change its geometry: a network blip shouldn't SIGWINCH the PTY.
  - `wide` keeps a status dot at the right of the tab bar and shows the same banner when not online.
  - The `conn-text` element stays in the DOM, visually hidden while online, with `aria-live` intact. Screen readers still announce changes and E2E references keep working.
- **Kept**: the "resumed, caught up N KB" toast (AC-2.10); "older output truncated" becomes a toast (AC-2.6); the IME preview `ime-preview`; `fatal` errors become a banner.
- **Session end** (replaces `ExitedBar`): when the shell exits, write a local line at the end of the terminal saying the process exited, with its exit code, and that Enter closes the session.
  - It's a plain `term.write()`. xterm writes are FIFO, so it lands after the last output.
  - It **doesn't count toward seq**; it's a purely local write.
  - Pressing `Enter` in that session (a terminal key, or an empty Enter on the text page) closes it.
  - No "restart": new sessions come from ☰ or `+`.
  - The agent's emulator doesn't contain this line (the browser wrote it), so after a reload or reconnect delivers a snapshot, it's written again based on session state. There is always exactly one.
- **Removed**: the 28px status strip, and the `degraded` (integration not working) and `unmarked` (this shell has no integration) banners. They explained automatic composer/raw switching and whether command blocks worked; both are gone.
- **Bell** (m10): `navigator.vibrate(50)`. Android only; iOS doesn't support it, so nothing happens there.

### 7. Keyboard shortcuts

The `Ctrl+Shift+*` convention stays (see the design constraints in keymap.md):

- Kept: `Ctrl+Shift+Enter` new session, `Ctrl+Shift+W` close, `Ctrl+Shift+↑/↓` previous / next, `Ctrl+Shift+,` settings.
- `Ctrl+Shift+B` toggles the session drawer on `compact` and does nothing on `wide` (there is no sidebar any more).
- Removed: the Composer keys (`Enter` / `Shift+Enter` / `↑↓` history / `Esc` clear / `Tab` insert spaces) and arrow-key resizing of the sidebar divider.
- **Removed `Ctrl/Cmd+F` in-session search** (AC-5.2). It was never implemented: `keymap.ts` returned a `'search'` action that nothing handled, and `SearchAddon` was loaded but never called. Termux has no search either. Both are removed and `Ctrl/Cmd+F` is no longer intercepted; it goes to the browser or the terminal.

### 8. Where we don't copy Termux

| Termux | webterm | Why |
|---|---|---|
| Vertical swipe on the alternate screen sends `↑` / `↓` | Becomes wheel events only with mouse tracking; otherwise nothing | Ruled out by ADR-0024 §4: in claude it walks input history, in vim it moves the cursor, and in tmux the wheel pushes the pane into copy-mode — and users run claude / codex inside tmux |
| `Ctrl+Alt+*` shortcuts | `Ctrl+Shift+*` | On Windows and European layouts `Ctrl+Alt` is AltGr and swallows typed characters |
| Drawer swiped in from the left edge | ☰ button | With Android gesture navigation the left edge is system back, and a web page can't claim it (native apps can request gesture exclusion; pages can't). The user wanted an entry point that is simple and reliable |
| Swipe left is the only way to the text input | ✎ button; swiping is a shortcut | Same reason: primary entry points must be visible |
| Volume key as Ctrl | Not done | Browsers can't see volume keys, and the extra keys have CTRL |
| "Reset terminal" | Not done | A local `term.reset()` would disagree with the sticky modes the agent tracks (ADR-0019). If the terminal is garbled, type `reset` in the shell |
| `~/.termux/termux.properties` config file | Settings panel + `localStorage` | Preferences belong to the browser, not the server |

### 9. Frontend: removal and restructuring

**Principles**:

- No compatibility layer, no flags, no "kept for history" doc sections, no commented-out code.
- Reuse a testid only when its meaning is identical: `conn-text` `terminal` `new-session` `ime-preview` `settings` `font-size` `font-family` `theme-select`.
- New components only wire things together; logic goes into unit-testable pure modules. The old `app.tsx` reached 1271 lines because this rule wasn't kept.

**Deleted**:

| File | Purpose |
|---|---|
| `input/composer.tsx` `input/sheet.tsx` `input/chips.ts` `input/complete.ts` `input/history.ts` | Edit panel, completion, history |
| `input/modes.ts` | composer/raw state machine |
| `input/keybar.tsx` | Context-dependent key row |
| `commands/api.ts` `commands/history.tsx` | History panel, snippet bar |
| `ui/sidebar.ts` `ui/sessionlist.tsx` `ui/reveal.ts` | Desktop sidebar, session list, scroll-selected-into-view |
| `ui/status.tsx` | Status strip |
| `term/pinch.ts` `term/hswipe.ts` | Visual zoom, swipe to switch sessions, gesture arbitration |
| `term/interactive.ts` | Screen-owner detection, only used to swap key sets |
| `ui/app.tsx` `style.css` | Rewritten from scratch |
| In `keymap.ts`: `PROMPT_KEYS`, the per-program key sets, `programOf`, `EDIT_INSERT`, Composer bindings, the `'search'` action | — |
| `SearchAddon` in `term/terminal.ts` | Search with no caller |

Their unit tests go too: `commands` `complete` `composer` `history` `hswipe` `interactive` `keymap-ai` `modes` `pinch` `reveal` `sidebar` `submit`.

**Kept**:

- `conn/*`, `protocol/*`.
- `sessions/store.ts` (minus the `modes` and `interactive` fields).
- `term/terminal.ts`, `userinput.ts` (`outputqueue.ts`, `budgetwriter.ts`, `inertia.ts` and the WebGL mount are deleted per [ADR-0026](0026-agent-holds-terminal-state.md) §7).
- `input/raw.ts`, `input/inputstats.ts`, and the byte mapping and app shortcuts in `keymap.ts`.
- `ui/drawer.tsx`, `ui/swipe.ts`, `ui/pair.tsx`, `ui/gate.tsx`, `ui/paircode.ts`, `ui/fonts.ts`.
- `ui/settings.ts` (font size stored per form) and `ui/viewport.ts` (breakpoints become form detection).

**Target layout**:

```
web/src/
  main.tsx
  app/      app.tsx (wiring: form, sessions, connection) · form.ts (form detection) · tabs.tsx (wide)
            · sessions.tsx (compact drawer content) · notices.tsx (connection banner / toasts / process exit) · settings.tsx
  keys/     extrakeys.tsx (key page + text page) · keymap.ts · raw.ts · inputstats.ts
  term/     terminal · userinput · gestures.ts (tap; pinch / long-press in m10) · selection.ts (m10)
  ui/       drawer · swipe · pair · gate · paircode · fonts · viewport · prefs.ts (was settings.ts)
  conn/  protocol/  sessions/
```

The remaining files in `input/` move to `keys/`. Today's `ui/` mixes entry-point wiring with generic components; it splits into `app/` and `ui/`.

**E2E**:

| Action | Specs |
|---|---|
| Delete | `sheet` `inputmodel` `swipe` `sidebar` `tablet` `pinch` `control` `escape` `commands` `integration` |
| Rewrite for the new design | `drawer` (phone session drawer), `mobile` (compact geometry and extra keys), `keyboard` (on-screen keyboard geometry), `sessionactive` (selected state of tabs and list items), `sessions`, `sessionmgmt`, `reading` |
| Scaffolding only | `basic` `continuity` `ime` `input` `inputalive` `liveness` `pairdigits` `redraw` `reexec` `replay-echo` `scrollperf` `security` `subscribe-reset` `zombie` |

Scaffolding: 33 places typed commands through `composer`; they all switch to one helper that types into the terminal.

### 10. Backend and protocol that become dead code

Once the UI changes, command history, path completion and prompt state have no consumer in the frontend. [ADR-0026](0026-agent-holds-terminal-state.md) §6 removes that whole layer: shell integration (rcfile, OSC 133 / 1701 / 7 parsing), the command history stack (`commands` table, `/api/commands*`, `/api/fs`, `/api/settings`, `--no-history`), and the related protocol messages and session fields. The working directory is read from `/proc/<foreground process group>/cwd` once per second. This lands in the same PR as this ADR.

### 11. Documentation

- **ADRs are a decision log and are never deleted.** A superseded ADR gets a banner under its title pointing here.
- **`docs/40-frontend/` is rewritten** to describe only the current design:
  - `layout-responsive.md` → `layout.md` (forms, geometry, on-screen keyboard, rendering);
  - `input-modes.md` → `input.md` (extra keys, text page, IME fallback, input path troubleshooting);
  - `keymap.md` and `session-ux.md` are rewritten in place;
  - `commands-ux.md` is deleted.
- **Requirements, acceptance criteria and E2E scenarios**: obsolete entries are **deleted outright**, not struck through, and their numbers are **never reused**. The list of deleted numbers lives only in [this ADR's Consequences](#removed-acceptance-criteria-and-e2e-scenarios), the single place for traceability.
- `docs/90-roadmap/milestones.md` gets the steps below.

### Rollout

| Step | Branch | Content | Exit criteria |
|---|---|---|---|
| m8 | `feat/40-termux-shell` | This ADR together with [ADR-0026](0026-agent-holds-terminal-state.md): doc rewrite; §9 frontend removal; new skeleton (§1 forms, §2 static extra keys without swipe-up and auto-repeat, §3 text page, §4 both session switchers, §5 tap, §6 without the bell, §7); output path rebuild and backend cleanup (ADR-0026); E2E scaffolding | `go test ./...`, `npm test`, `npm run e2e` all green; byte-level continuity (incremental) and screen-level consistency (snapshot) both pass; `TestHandoffByteLevelContinuity` passes |
| m9 | `feat/40-termux-keys` | §2 swipe-up secondary keys, auto-repeat, configurable layout | Same |
| m10 | `feat/40-termux-gestures` | §5 pinch to change font size, long-press selection and its menu; §6 bell | Same; real-device gestures go in the manual checklist |

The user asked for **one PR for everything**: UI, output path and dead backend code. So UI and output problems can't be told apart by PR boundary; instead each side has its own observability (input: `inputStats()`; output: per-segment counters, see [ADR-0026](0026-agent-holds-terminal-state.md)).

## Consequences

- **Two rows of extra keys take 80px**, versus 56px for the old single row: about one and a half fewer terminal lines on a phone. In return all 14 keys are visible, never move, and need no horizontal swipe.
- **No context keys**: less's `q`, vim's `:wq` and top's `k` are typed on the on-screen keyboard.
- **claude loses its fixed 43 columns**: changing the font size reflows, and claude gets SIGWINCH and redraws. Termux behaves the same.
- **Tapping the terminal toggles the on-screen keyboard**: a tap while it's open closes it. That's Termux muscle memory; accepted.
- **No command history**: cross-device history, snippets and same-directory history are gone. The shell's own `↑` and `Ctrl+R` remain. This is the direct cost of the clean sweep, and the user accepted it.
- **The form follows screen size**: a desktop browser window dragged very narrow still gets the tab bar, and so does an iPad in 320px split view, with scrolling tabs. Both work; accepted.
- **No text page on mouse-and-keyboard devices**: a physical-keyboard IME types straight into the terminal (`RawIme`), and editing long CJK text is worse than with the old Composer. If it's ever needed, add a shortcut that opens the text page on `wide`.

### Removed acceptance criteria and E2E scenarios

Numbers are never reused.

- **Deleted**:
  - AC: AC-3.1 and 3.2 (Composer, replaced by AC-3.19), 3.5, 3.7, 3.9, 3.12, 3.13, the AC-3.14 about the key row not covering the terminal, AC-4.7, 5.2, 5.12, AC-6.4, 6.6, 6.7, 6.11 (history and snippet UI), plus the long-obsolete AC-3.6, old 3.12–3.16, 5.6–5.8 and 6.8.
  - E2E: E2E-8, 9, 13, 14, 19, 24, 25, 29, 32, plus the long-obsolete 11b, 12b, 20, 23.
- **Deleted by [ADR-0026](0026-agent-holds-terminal-state.md) in the same PR**: the rest of AC-6, AC-7.1–7.7, and the output-path criteria AC-2.7, 2.16–2.19, 5.5, 5.9, 5.10, 5.15–5.17.
- **Rewritten in place, numbers kept** (same subject):
  - AC: AC-2.10 (connection indicator), the wording of AC-3.3 / 3.4 / 3.14 ("raw mode" becomes "direct terminal input"), AC-3.8 (on-screen keyboard), AC-4.5 (session end), AC-4.8 (focus follows the session), AC-4.9 (selected state: tab / list item), AC-5.3 (font size per form), AC-5.11 (overlays: settings and the phone session drawer), AC-6.5 / 6.9 (drop E2E-14), AC-7.6 (drop the UI degradation notice).
  - E2E: E2E-5, 6, 7 (drop the Composer part), 10, 11, 12 (drop search), 21, 28, 34, 35.

### New acceptance criteria and E2E scenarios

| ID | Content | E2E |
|---|---|---|
| AC-5.18 | **Form**: `.app[data-form]` is decided by the screen's short side. Opening the on-screen keyboard or rotating doesn't change it and doesn't send `resize` | E2E-39 |
| AC-3.18 | **Extra keys**: shown on `compact` or `pointer: coarse`; the 14 default keys match the diagram exactly and don't change with the foreground program; no horizontal scrolling at 393px; arrows send `ESC O A` with DECCKM on; pressing a key doesn't move focus | E2E-10 |
| AC-3.19 | **Text page**: both ✎ and swiping switch pages without changing terminal rows/cols; Enter with content sends it without a carriage return; empty Enter sends `\r`; Enter during composition sends nothing; content with newlines uses bracketed paste; sends are counted in `inputStats` | E2E-40 |
| AC-3.20 | **Tapping the terminal**: reports a click when mouse tracking is on; otherwise toggles the on-screen keyboard (focus in / out of the terminal) | E2E-10 |
| AC-4.10 | **Session switching in both forms**: on `compact`, ☰ shows the unread dot, the drawer closes with the system back button among others, and after choosing a session focus is restored according to whether it was in the terminal before the drawer opened; on `wide`, the tab bar can switch, close, rename and create sessions, and switching doesn't change terminal geometry | E2E-28, E2E-41 |

Session end (AC-4.5) and the connection banner (AC-2.10) are rewritten under their existing numbers. Criteria for pinch-to-zoom and long-press selection (m10) and extra-key enhancements (m9) are added on their own branches.
