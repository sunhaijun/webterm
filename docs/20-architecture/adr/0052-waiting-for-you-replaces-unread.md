# ADR-0052 "Waiting for you" replaces the unread dot

Status: Accepted (2026-11-07). Replaces the unread marker of AC-4.3 and [session-ux.md](../../40-frontend/session-ux.md) (the dot keeps its places and its accent color, [ADR-0042](0042-red-means-error-and-line-icons.md) §1). Adds `attention` to session info and `session.updated`, and a client message `session.seen`. The protocol version stays 2.

## Context

The main use of webterm is running claude and codex directly in sessions, several at once, and checking on them from a phone. What you want to know about a session you aren't looking at is one thing: **is it my turn?**

The unread dot answers a different question. `unread = head_seq > out_seq` lights on any output. claude and codex redraw spinners and timers several times a second while they work (claude measured 0.5–0.8 KB/s during a conversation), so a working session is always unread, and a finished one is too. The dot is on almost all the time and can't tell "still working" from "done, waiting for you". The name's `✳` / `◐` ([ADR-0043](0043-terminal-title-as-auto-name.md)) does say it, but only if you open the drawer and read every name.

What the programs already say about themselves:

| Source | What it says | Notes |
|---|---|---|
| claude 2.1 terminal title | `◐` / `◑` while working, `✳` when idle | Measured for ADR-0043 |
| claude `preferredNotifChannel: terminal_bell` | BEL for its notifications (a permission prompt, waiting for input) | Present in 2.1.317 |
| codex 0.166 `[tui]` notifications | OSC 9 or BEL on turn complete / approval request; `notification_condition` is `unfocused` or `always` | Keys present in 0.166; not measured live (codex needs a network login and spends usage), so it's on the manual checklist |
| codex terminal title | The binary carries the braille spinner `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`; title items are configurable (`[tui].terminal_title`) | Same |
| A plain shell | Nothing, but the agent already reads the foreground process group once a second (ADR-0043) | |

The agent-side emulator (tuios.dev/vt) reports BEL (`Callbacks.Bell`) and desktop notifications, OSC 9 / 777 / 99 (`Callbacks.Notify`), with OSC 9;4 progress and OSC 9;9 working-directory reports kept out of `Notify`.

## Decision

### 1. One `attention` flag per session, held by the agent

A session has `attention`: "something happened that is waiting for you, and nobody has looked yet". These set it, only while the session is running:

1. **The title goes from busy to idle.** The title in use (ADR-0043 §2: set by the current foreground program, never the shell) started with a spinner glyph at one poll and starts with anything else at a later poll, still in use. Spinner glyphs: braille `U+2801`–`U+28FF` and `◐ ◓ ◑ ◒`. claude's `◐` → `✳` is this case, and so is codex's if its title carries the spinner. A title that just disappears (the program exited) isn't this rule; rule 3 covers exits.
2. **A bell or a notification in the output**: BEL (not the one that terminates an OSC string), OSC 9 (except 9;4 and 9;9), OSC 777 `notify`, OSC 99. The emulator counts them while it parses, under the session lock; the output path only compares two counters.
3. **A long command finishes**: the foreground process group was something other than the shell for at least 10 s and is the shell again. Covers builds and test runs, and claude or codex exiting.

**All three are applied in the once-a-second poll** (the one that reads the directory and the title). Bells and notifications seen by the output path only mark the session; the poll turns the mark into `attention`. So `attention` is set at most once per second per session, a bell storm costs nothing, and the latency is at most a second.

A signal while `attention` is already set does nothing. An exited session sets nothing new (its exit code is its own marker); an `attention` set before the exit stays until someone looks.

### 2. "Seen" is the viewing client's call

The agent doesn't track who is looking at what. A client that has the session **in front of the user** sends `session.seen{sid}`, and the agent clears the flag and tells everyone.

- **Browser**: the session is the current one, the page is visible (`document.visibilityState == "visible"`) and has focus (`document.hasFocus()`). It sends `session.seen` when the session has `attention` and any of these happens: `session.updated{attention: true}` arrives for it, the user switches to it, the page becomes visible or gains focus, a `welcome` arrives.
- **`webterm attach`**: being attached is looking. It sends `session.seen` after attaching if the session has `attention`, and whenever `attention: true` arrives for its session.

So a session someone is looking at flips to `attention` and back within one round trip. Other devices can see the dot for that moment; that's harmless, and a push notification (later) has to wait a few seconds and drop itself if the flag was cleared.

### 3. Protocol

- `welcome.sessions[]` and `session.created` carry `attention: bool`.
- `session.updated{attention}` is sent whenever it changes, set or cleared, to every connection. The poll already limits sets to one per second per session; clears follow `session.seen`.
- New client → agent message `session.seen {sid}`. An unknown sid gets `error{code: "unknown_session"}`, like `session.rename`. No reply otherwise.
- `session.updated{head_seq}` for unsubscribed sessions stays: the replay gate uses it as `catchup_to` for an incremental subscribe ([protocol §5.3](../../30-protocol/websocket-protocol.md#53-reconnect-and-resume)). It no longer drives anything in the UI.

### 4. UI

- **The unread dot becomes the attention dot**: same places (drawer row, tab, the corner of the session button when any non-current session has it), same accent color. `data-attention="true"`, labeled "Waiting for you". The current session never shows it; it's cleared on sight.
- **There is no unread marker any more.** Output in a background session without a signal shows nothing; the name (`✳` / `◐`) and the directory still update.
- The exit code display is unchanged.

### 5. Hot upgrade

`attention` goes into `internal/handoff.Session`, with a pending bell or notification folded in at export. The busy/idle state of the title is recomputed from the handed-over title at the first poll. The 10-second foreground timer restarts: a command that spans the upgrade counts from the upgrade.

### 6. Setup

- **claude**: nothing; the title does it. Optional: `claude config set --global preferredNotifChannel terminal_bell` so that a permission prompt also rings.
- **codex**: in `~/.codex/config.toml`, under `[tui]`, `notifications = true` and `notification_condition = "always"`.

These go in [troubleshooting.md](../../80-ops/troubleshooting.md#the-waiting-for-you-dot-doesnt-light).

### Rejected alternatives

- **Keep unread next to attention.** Two dots, one always on for AI sessions: the noise this removes.
- **Smarter unread** (byte thresholds, ignoring redraw-only output). Guessing by content which output matters; the next CLI version's redraw style breaks it.
- **Read claude's and codex's session files** to see whose turn it is. Private formats, the reason [ADR-0013](0013-terminal-only.md) removed the transcript view.
- **The agent tracks viewers** (a per-connection "I'm looking at sid N" message). Subscribed isn't looking: a desktop tab left open in the background stays subscribed to its session, and the phone would never see the dot. The state would also have to survive reconnects and upgrades. The seen-ack model needs none of it.
- **Clear on input** (typing into a session means you're looking). Pending input is resent after a reconnect without the user doing anything, and `session.seen` already covers both clients.
- **Strip `✳` / `◐` from names now that the dot exists.** They say "working", which the dot doesn't; ADR-0043 keeps them.

## Consequences

- Docs: AC-4.3 rewritten, AC-4.10's unread dot becomes the attention dot, US-4.3, [session-ux.md](../../40-frontend/session-ux.md#waiting-for-you-ac-43), the protocol (§4.1 `session.seen`, §4.2 `attention`, §6.2), [session-manager.md](../../50-backend/session-manager.md), E2E-6 and E2E-41 ⑥, devices-and-layout.md, troubleshooting.md.
- Tests: UT-vterm-signals (bell / notify counters), UT-attn-spinner, IT-attention-1 (bell in a background session sets it, `session.seen` clears it, both broadcast), IT-attention-2 (title busy → idle), IT-attention-3 (long command finishes; a short one doesn't), IT-attention-4 (exited sessions set nothing new), the handoff test (attention survives), protocol vectors, frontend unit tests (merge, the seen rule), E2E-6 rewritten.
- Web Push and the app badge are a later milestone on top of the same flag.
