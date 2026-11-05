# Session UX

> Status: Accepted. UI decisions: [ADR-0025](../20-architecture/adr/0025-termux-style-ui.md); output path: [ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md).

## Client-side session model

```ts
type Session = {
  sid: number
  name: string
  nameIsManual: boolean
  cwd: string | null
  status: 'running' | 'exited'
  exitCode: number | null
  cols: number; rows: number
  createdAt: number

  // Local state, not from the server
  term: Terminal               // xterm instance; kept when switching away
  outSeq: number               // output bytes received so far
  headSeq: number              // output bytes the agent has produced for this session (unread = headSeq > outSeq)
  inSeqNext: number            // next input seq to assign
  pending: PendingInput[]      // unacked input
  pinnedSubscription: boolean  // pinned (below)
}
```

**Switching away doesn't destroy the xterm instance.** Its DOM is only detached from the container, so switching back needs no replay: screen contents, scroll position, and selection are all preserved.

The cost is memory: each instance holds 5000 lines of scrollback, which is acceptable at the 20-session limit. If it ever becomes a problem, destroy the instances of the **least recently used** sessions and rebuild them from a snapshot on switch-back. That's an optimization we don't do yet.

## Subscriptions

**Only the visible session is subscribed.** Unsubscribed sessions keep running on the agent and keep feeding its terminal emulator; the agent sends only `session.updated{head_seq}` so the client can work out unread. **This is the key bandwidth saver on mobile**: a background session running `tail -f` sends nothing over the network.

```
switch to session X:
  1. unsubscribe(current session)
  2. mount X.term's DOM → fit()
  3. subscribe(X, out_seq: X.outSeq, cols, rows)   ← the size goes IN this message
```

The agent answers in one of two ways ([protocol §5.1](../30-protocol/websocket-protocol.md)):

| Agent decides | Browser receives | Browser does |
|---|---|---|
| **Incremental**: `out_seq > 0` and still inside the 256 KiB ring buffer window | OUTPUT frames starting at `out_seq` | Keeps writing; screen, scrollback position, and selection stay put |
| **Snapshot**: first open, refresh, away too long, disconnected too long, column count changed | One SNAPSHOT (current screen + up to 2000 lines of history + modes), then OUTPUT frames | In-stream RIS (`ESC c`) reset → fresh UTF-8 decoder → write the snapshot → `outSeq = seq` |

There's no main/alternate screen distinction and no "history truncated" notice: the snapshot is the full picture in the agent's emulator, so vim / codex / claude come back showing their current screen.

**The size must be in the same message as `subscribe`.** Under the lock the agent first decides what to send (if the column count changed, it resizes the emulator and sends a snapshot), and only after releasing the lock calls `TIOCSWINSZ`. So the bytes a program redraws on SIGWINCH always come after the snapshot or incremental output, never before it where they'd be skipped.

**Pin** (pinned subscription): when a session is pinned, the session stays subscribed after you switch away, at the cost of bandwidth. Off by default; toggle it from the session menu (below). Switching back is then always incremental: the screen and scrollback position stay exactly as they were.

## Switching sessions (AC-4.10)

This is the only place the two forms differ (form rules in [layout.md](layout.md#form-ac-518)).

### compact (phone): session button and bottom drawer

The top cell of the extra keys' left column is the **session button** (`data-testid="open-sessions"`), modeled on the tabs button in mobile browsers: a rounded box with the number of sessions in it, updated immediately on create and close. Tapping it opens the session drawer. When any **non-current** session has unread output (`headSeq > outSeq`), an unread dot appears at the box's top-right corner (`data-unread="true"`, accent color, [ADR-0042](../20-architecture/adr/0042-red-means-error-and-line-icons.md)). Why not ☰: [ADR-0030](../20-architecture/adr/0030-no-settings.md) §3.

```
┌────┐
│ ┌─┐•     rounded box + session count; • is the unread dot
│ │3│
│ └─┘
├────┤
│ ✎  │     pencil coming out of a rounded box (SVG, same size and weight as the box above)
└────┘
```

```
┌─────────────── ═══ ─────────────────┐
│ Sessions                          ✕ │
├─────────────────────────────────────┤
│▎[1] webterm     ~/github/webterm    │  ← current: accent left bar + tint
│ [2] api       • ~/srv/api           │  ← unread dot
│ [3] build       exit 1              │  ← exited (nonzero in the warning color)
│                                     │  ← at least half the screen: extra height goes to the list
├─────────────────────────────────────┤
│  ┌───────────────────────┐ ┌─────┐  │  ← pinned to the bottom, closest to the thumb
│  │     + New session     │ │  ⚙  │  │
│  └───────────────────────┘ └─────┘  │
│                                     │  ← bottom padding max(16px, safe area)
└─────────────────────────────────────┘
```

- The drawer is the `Drawer` primitive ([layout.md](layout.md#sheets)): a full-width bottom sheet, `data-testid="session-drawer"`. **At least half the visible area tall** (50%, at most 80%); with few sessions the extra height goes to the list.
- The list (`session-list`) has one row per session (`session-<sid>`): index `[n]` (current order, starting at 1; closing a session renumbers the ones after it; reorderable, see [Ordering](#ordering-ac-413)), name, CWD or exit code, unread dot. Pinned sessions show a pin icon before the name (drawn as `⇵` in the diagrams). Rows are 52px.
- **Paths** are laid out left to right as is (`<bdi dir="ltr">`); when they don't fit they're cut from the left, with the ellipsis on the left, so the last directories stay visible. **The name gets space first**: the path gives way first, and the name is shown in full if it fits; the path keeps at least `min(6em, 25%)`, and the name is truncated only when it doesn't fit even then ([ADR-0042](../20-architecture/adr/0042-red-means-error-and-line-icons.md) §3).
- Pinned bottom row: `+ New session` (`new-session`, fills the remaining width) and settings (`open-settings`, a 48px square button with a ⚙ icon). Both are rounded blocks with a thin border and margins all around, not touching the sheet's edges ([layout.md §Sheets](layout.md#sheets)). Settings closes the drawer and opens settings ([layout.md §Settings](layout.md#settings-ac-53)).
- Tap a row = switch to it and close the drawer. **Swipe a row left or long-press it = reveal its buttons** (see [Row actions](#row-actions-compact)).
- **Closing the drawer**: tap the backdrop, pick a session, `Esc`, ✕, the system back button; swiping down is just a shortcut.
- **System back button**: on open, `history.pushState({drawer: true})`; on `popstate`, close the drawer. When it's closed any other way, call `history.back()` to remove that entry so entries don't pile up. Without this, the back button exits the app in an Android PWA.
- **On-screen keyboard**: opening the drawer moves focus into it (modal), so the keyboard hides and the drawer gets the full height. Before opening, remember whether focus was in the terminal, and restore based on that after a session is picked (see [Focus follows the session](#focus-follows-the-session-ac-48)).
- `Ctrl+Shift+B` opens / closes the drawer.
- **No card list, no output previews**: those would require the client to hold output for inactive sessions, and **subscribing only to the current session** is the most important bandwidth optimization on mobile. The unread dot already answers "which session has activity".

### wide (PC / tablet): tab bar

```
┌ ▎[1] webterm ✕ │ [2] api •   │ [3] ⇵ logs  │ [4] build   │   + ──────── ● ⚙ ┐   equal width, 120–240px
┌ │ [2] api •   │ [3] ⇵ logs  │ [4] build   │ ▎[1] webterm ✕ │   + ● ⚙ ┐        overflow: the strip scrolls, + stays put
```

- The top bar `.topbar` is 36px tall (40px with `pointer: coarse`) and always visible. Left to right: the horizontally scrollable tab strip `data-testid="tabbar"` (**tabs only**), `+`, a spacer, the connection dot (`conn-dot`), and settings (`open-settings`). `+`, the dot, and settings are outside the tab strip and don't scroll with it ([ADR-0035](../20-architecture/adr/0035-tabbar-new-button-pinned.md)).
- A tab (`tab-<sid>`) = index + session name + unread dot; pinned sessions show a pin icon before the name (drawn as `⇵` in the diagram); exited sessions are grayed out. Long names are truncated with an ellipsis (the index never is); `title` holds the full name and CWD.
- The **index** (`tab-<sid>-idx`) is the same `[n]` as in the drawer (current order, starting at 1), so tabs with the same name can be told apart. **Every tab has one**, renamed tabs included, matching the drawer ([ADR-0041](../20-architecture/adr/0041-tab-index-and-edit-icon.md)). Monospace, `--muted`, accent on the current tab.
- **Width** ([ADR-0031](../20-architecture/adr/0031-tabs-equal-width.md)): all tabs are equal width, sharing the strip's available width, between 120px and 240px.
- **`+`** (`new-session`) sits right of the tab strip. When the tabs fit, the strip is exactly as wide as the tabs and `+` follows the last tab; when they don't, the strip shrinks to the remaining width and scrolls, and `+` stays to its right, **always visible**.
- A **12px (16px on touch) gap that isn't clickable** separates `+` from the tab strip, so aiming for New doesn't hit the current tab's ✕.
- `+` is an SVG icon, not a text character: it and the status dot are both vertically centered by their geometric centers, on the same horizontal line.
- Far right: the connection dot (`conn-dot`) and settings (`open-settings`, ⚙, the same size and line-icon style as `+`, vertically centered with the dot).
- **Click a tab** = switch. **Middle-click a tab** = close.
- **✕** (`tab-<sid>-close`): with a mouse, shown on hover and on the current tab; on touch, only on the current tab, to avoid accidental taps.
- **Right-click (mouse) / long-press (touch) a tab** = session menu (on touch it opens when you **release in place** after the long press; moving after the long press drags to reorder, see [Ordering](#ordering-ac-413)). **Double-click a tab** = rename it directly.
- Tabs follow the current order and can be dragged to reorder ([Ordering](#ordering-ac-413)). When they don't fit (each would be narrower than 120px), tabs stay at 120px and the strip scrolls horizontally; when the current tab changes, it's scrolled into view (no-op if it's already fully visible; no `smooth`).
- The scrollbar is hidden. A **vertical mouse wheel** over the strip scrolls it horizontally (not intercepted when everything fits); horizontal trackpad swipes work as usual.
- Switching tabs doesn't change terminal geometry.

### Row actions (compact)

Swiping a drawer row left reveals three buttons ([ADR-0039](../20-architecture/adr/0039-drawer-row-swipe-actions.md)):

```
│ [2] api   • ~/srv/a │  ⇵   │Rename│Close │
                      └ 72px ┴ 72px ┴ 72px ┘
```

| Button | testid | Background | Action |
|---|---|---|---|
| Pin / Unpin | `row-pin` | `--line-strong` | Toggle the pinned subscription |
| Rename | `row-rename` | `--accent` | Open the rename sheet (below) |
| Close | `row-close` | `--err` | See [Closing a session](#closing-a-session); a running session asks for confirmation first, stacked on the drawer |

- **Gesture**: takes over once horizontal travel > 10px and is mostly horizontal; the row follows the finger (0 to −216px); release past halfway and it stays open, otherwise it springs back; swipe an open row right to close it. Vertical swipes scroll the list as usual (rows have `touch-action: pan-y`). **A long press on a row also opens it.**
- Only one row is open at a time: opening another row, tapping elsewhere in the list, or tapping the open row's body closes it; tapping the body **only closes it, it doesn't switch sessions**.
- Tapping a button closes the row first, then acts.
- **Swallow the `click` the browser fires after a swipe or long press**: once a long press has pushed the row open, the finger is over a button, and that synthetic `click` would land on Rename or even Close. The flag clears on the next pointer down.

**Rename sheet** (`rename-sheet`): a small sheet stacked on the drawer, with one full-width input (`rename-input`, 16px, all text selected on open) and Cancel / Save (`rename-cancel` / `rename-ok`). `Enter` or Save confirms; an empty name restores automatic naming from the directory; `Esc`, ✕, the backdrop, swiping down, and Cancel all cancel. Losing focus doesn't cancel. The sheet sits right on top of the keyboard ([layout.md §Sheets](layout.md#sheets)), so the input is never covered.

### Ordering (AC-4.13)

Sessions can be dragged into a different order. The order lives on the agent, is the same on every device, and survives refreshes and hot upgrades ([ADR-0040](../20-architecture/adr/0040-session-order-drag.md), protocol `session.move` / `session.order`).

| Where | How to start a drag |
|---|---|
| `wide` tab bar, mouse | Press a tab and move > 5px horizontally |
| `wide` tab bar, touch | Long-press a tab and move without lifting (releasing in place still opens the session menu) |
| `compact` drawer | Press the drag handle at the right end of a row (`≡`, `session-<sid>-grip`, 44px wide) |

```
│ [1] webterm     ~/github/webterm   ≡ │  ← ≡ is the drag handle; the rest of the row still taps, swipes, and long-presses as before
```

- The dragged item follows the pointer, lifted with a shadow, and the others move aside; on release it's inserted at the pointer. No message is sent if the position didn't change.
- The `click` after a drag is swallowed (no session switch); `Esc` cancels the drag.
- The scrollable tab strip and drawer list auto-scroll when the pointer is within 32px of an edge.
- On release the new order shows immediately and `session.move` is sent; a received `session.order` is authoritative.
- `[n]`, `Ctrl+Shift+↑/↓`, and the auto-switch after closing the current session all follow the current order.

### Session menu (wide)

Opened by right-click (mouse) or long-press (touch) on a tab, `data-testid="session-menu"`. The `compact` drawer doesn't use it; it has the row actions above.

| Item | testid | Action |
|---|---|---|
| Rename | `session-rename` | The name on the tab turns into an input in place (`rename-input`); `Enter` confirms, `Esc` cancels; an empty string restores automatic naming |
| Pin | `session-pin` | Toggle the pinned subscription, with a check mark |
| Close | `session-close` | See [Closing a session](#closing-a-session) |

Click outside the menu or press `Esc` to close it.

### Current session styling (AC-4.9)

The current session (current tab / current drawer row) gets: **an accent left bar or underline + an accent background tint + the name in bold `--accent` + `aria-current="true"`**. Tabs use a 2px underline; drawer rows use a 3px left bar.

- **Hover must not look like selection.** Selection is marked by **hue** (`--accent`); hover stays a neutral gray (`--fg` at low opacity), and the two still read correctly when combined.
- Status dot / unread dot / exit code colors keep their meanings; they answer other questions (is it running, is there new output, how did it exit).
- **The current item must be in view.** With up to 20 sessions, neither the tab bar nor the drawer may fit them all, and `Ctrl+Shift+↑/↓` or the auto-switch after closing can make an off-screen item current. If it's already fully visible, **do nothing**; otherwise `scrollIntoView({ block: 'nearest', inline: 'nearest' })`, **without `smooth`**.
- **Current-session styling doesn't depend on focus.** Per AC-4.8, focus goes back to the terminal along with the session, so only this styling can say which session is current.

## Focus follows the session (AC-4.8)

Step 2 of switching (mounting the new session's DOM) hides a trap: `activate()` first removes the previous session's DOM from the document, and **at that moment focus falls back to `body`**. Nothing gives the newly mounted terminal focus, so after switching, typing does nothing at all, with no hint why.

Rule (terminal only; the text page is covered in the last bullet):

```
hadFocus = document.activeElement was inside the terminal area before the drawer opened (or before the switch)
after the switch: hadFocus || no touch  →  term.focus()
```

- **Focus was in the terminal** → give it to the new session's terminal. The user was typing, and the on-screen keyboard is open. When a session is picked in the drawer, `focus()` runs inside that tap's handler, so iOS shows the keyboard again.
- **Desktop (no touch): always focus the terminal.** There's no on-screen keyboard to worry about, and typing right after clicking a tab is the natural expectation.
- **On touch devices, if focus wasn't in the terminal, leave it alone.** An unprompted `focus()` pops up a keyboard that covers half the screen; the user asked to switch sessions, not to type. To type, tap the terminal.
- **The text page also follows the session** ([ADR-0036](../20-architecture/adr/0036-text-page-per-session.md)): each session remembers its own page and textarea draft. "Focus was in the terminal" above becomes "focus was in the terminal **or the textarea**", and focus goes to **the new session's input**: the textarea (holding that session's own draft) if it's on the text page, the terminal if it's on the keys page.

```
typing = focus was in the terminal or the textarea before the switch
after the switch: typing || no touch  →  new session on text page ? textarea.focus() : term.focus()
```

## Unread (AC-4.3)

- **Unread is derived on the client; it isn't server state**: `unread = headSeq > outSeq`.
- When an unsubscribed session produces output, the agent sends `session.updated{head_seq}` (at most once per second per session; when throttling swallows an update, the latest value is sent afterwards).
- The server stores no `unread` flag: unread is inherently per client, and two browser tabs would clear each other's.
- Shown as an unread dot on drawer rows and tabs; on `compact`, also on the corner of the session button (lit when any non-current session is unread).
- **The unread dot uses the accent color** (`--accent`), not red: red is reserved for errors and destructive actions (nonzero exit, close, disconnected), so "new output" doesn't look like "something broke" ([ADR-0042](../20-architecture/adr/0042-red-means-error-and-line-icons.md) §1).
- An exited session also needs attention: show `exit <code>`, in the warning color when nonzero.

## Auto naming (AC-4.4)

```
name = nameIsManual ? manual name
     : terminal title set by the foreground program ?? (cwd ? basename(cwd) : "shell")
```

- The agent computes the name: `~` when `cwd` is the home directory, `/` when the basename is empty (`/`).
- **Terminal title** ([ADR-0043](../20-architecture/adr/0043-terminal-title-as-auto-name.md)): a title the foreground program (claude, vim, ssh…, not the shell itself) sets with OSC 0 / 2 takes priority and is shown as is (claude's `✳` idle / `◐` working). Titles the shell sets at the prompt, like `user@host: dir`, are ignored; when the program exits the name goes back to the directory. tmux doesn't forward inner programs' titles by default ([troubleshooting.md](../80-ops/troubleshooting.md#tab-name-doesnt-follow-claudes-title)).
- The CWD shown in lists is abbreviated by the browser: `~` when it equals or is under `welcome.home`; shown as is when there's no `home`, without guessing `/home/<user>`.
- **No dedup suffixes** for duplicate names: two sessions in a `webterm` directory should both be called `webterm`; the index / order and the full CWD tell them apart.
- After a manual rename, `nameIsManual = true` and automatic naming stops (neither the title nor the CWD is followed). Renaming to an empty string turns it back on.

## New session

Entry points: `+ New session` at the bottom of the `compact` drawer; `+` in the `wide` tab bar; `Ctrl+Shift+Enter`.

- `cwd` defaults to the **current session's** CWD (usually you want another shell in the same project); with no current session, home.
- `cols`/`rows` come from the current terminal size.
- The new session becomes current.
- At the limit (AC-4.2), `+` is disabled and its `title` / a toast says `Session limit reached (20)`, rather than doing nothing when tapped.

## Closing a session

Entry points: Close in the session menu, ✕ or middle-click on a tab, `Ctrl+Shift+W`, `Enter` in an exited session.

| Session state | Behavior |
|---|---|
| `running` | **Requires confirmation**, then sends `session.close`. The confirmation is our own sheet, not the browser's `confirm()` (below) |
| `exited` | Closes immediately, no confirmation |

After closing, switch to an adjacent session (the next one first); if none are left, show the empty state (with a New session button).

### Close confirmation (AC-4.11)

Uses the `Drawer` primitive ([ADR-0038](../20-architecture/adr/0038-close-confirm-sheet.md)), shaped like settings: a bottom sheet on `compact`, a centered dialog on `wide`.

```
┌─────────────── ═══ ───────────────┐
│ Close "webterm"?                ✕ │
├───────────────────────────────────┤
│ Programs running in it will be    │
│ terminated.                       │
├───────────────────────────────────┤
│  ┌─────────────┐ ┌─────────────┐  │
│  │   Cancel    │ │    Close    │  │  close-cancel · close-ok (warning color)
│  └─────────────┘ └─────────────┘  │
└───────────────────────────────────┘
```

- `data-testid="close-confirm"`. Opens with focus on Close: `Enter` confirms, `Esc` cancels.
- The backdrop, ✕, swiping down, and Cancel all cancel.
- Closing from the session drawer: the confirmation stacks on the drawer, which stays open; `Esc` closes only the top layer.
- Focus: if the user was typing (terminal or text page) before it opened, or the device has no touch, focus goes back after confirm or cancel. On confirm, **restore focus first, then send `session.close`**; otherwise the switch to the adjacent session would judge the user as "not typing" (see [Focus follows the session](#focus-follows-the-session-ac-48)).
- If the session disappears while the sheet is open (closed elsewhere, agent restarted), the sheet closes too: `sid`s get reused, so it can't stay open.

## Session exit (AC-4.5)

When the shell exits, the session becomes `exited` and a **local notice** is written at the end of the terminal:

```
[Exited (code 1) · Enter to close]
```

Without an exit code: `[Exited · Enter to close]`.

- When to write it: the session is `exited` **and `out_seq` has caught up to the `head_seq` in the exit message** (the agent guarantees that message comes after the last OUTPUT, protocol §4.2). Then a plain `term.write()`; xterm writes are FIFO, so the line lands after the last output.
- **Not counted in seq**: it's a purely local write; `outSeq` doesn't change.
- **The buffer is kept**: scrollable, selectable, copyable. "The build failed and I need to read the last error" is a common case.
- Typing `\r` in this session (`Enter` in the terminal, or Enter on the text page) closes the session. Other input is dropped: the PTY is gone, and the notice already says what to do.
- There's no "reopen". Create a new session with `+`; it inherits this session's `cwd`.
- The line **isn't in the agent's emulator** (the browser writes it locally), so after every snapshot write it's written again if the session has exited. After a refresh or reconnect there's **always exactly one**.

## Connection status (AC-2.10)

Every connection message is in **one place: the banner at the top of the terminal** ([ADR-0049](../20-architecture/adr/0049-connection-status-in-one-place.md)).

| State | Banner | `wide` also |
|---|---|---|
| Page loading (gate checks pairing) | `Connecting…`, over a skeleton of the app (empty tab bar on `wide`), so it's already in its final position | — |
| Agent unreachable at startup | `Can't reach the agent · retrying` (error color); re-checks every 3 seconds and on `online` | — |
| Connecting / reconnecting | `Connecting…` / `Reconnecting · retry in 3s` (live countdown), warning color | Pulsing orange dot |
| Online | Hidden | Green dot; `title` adds `320ms` when RTT > 300ms |
| Resumed | `Resumed · caught up 48 KB`, ok color, gone after 3 seconds | Dot turns green |
| Agent restarted | `Session ended (agent may have restarted)`, warning color, 3 seconds | — |
| Action refused offline | The state plus a note, e.g. `Reconnecting · retry in 3s · Can't create a session until reconnected`, 3 seconds | — |

- The banner **floats over the terminal** ([layout.md](layout.md#floating-over-the-terminal)); showing or hiding it never changes terminal geometry, so network blips don't send the PTY a SIGWINCH.
- The state text lives in `data-testid="conn-text"`, which is **always in the DOM**: visually hidden while online, still announced through `aria-live="polite"`. The note is `data-testid="conn-note"`.
- Toasts are only for messages that aren't about the connection (session limit, input too large, agent notices).
- "Caught up N KB" may look redundant, but it **assures the user nothing was lost** — visible evidence for the "never disconnects" promise.

## Scrollback after refresh (AC-5.14)

A refresh clears browser state and every session's `outSeq` goes back to 0. `subscribe{out_seq: 0}` always takes the snapshot path: the agent exports the current screen + up to 2000 lines of history from its emulator, and once the browser writes it you can scroll back. The browser **doesn't store** any local snapshot ([ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) §7).

- A snapshot is at most ~170 KiB (2000 lines of colored output); the browser parses it in 11–24 ms.
- If the agent restarted (`instance_id` changed), there are no old sessions to subscribe to, so output can't end up attached to the wrong session (AC-2.13).
