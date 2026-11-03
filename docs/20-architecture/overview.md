# Architecture overview

> Status: Accepted

## The big picture

```
┌──────────────────────────────────────────────────────────┐
│ Browser (PWA)                                            │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ drawer/tabs  │  │ xterm.js     │  │ extra keys /   │  │
│  │ unread dots  │  │ display only │  │ text page      │  │
│  └──────────────┘  └──────────────┘  └────────────────┘  │
│         └─────────────────┬──────────────────┘           │
│                    ┌──────▼───────┐                      │
│                    │ connection   │  seq accounting,     │
│                    │ layer        │  resend queue,       │
│                    │ (one WS)     │  UTF-8 stream        │
│                    │              │  decoding, backoff   │
│                    └──────┬───────┘                      │
└───────────────────────────┼──────────────────────────────┘
                            │  WSS (same origin, one port)
┌───────────────────────────▼──────────────────────────────┐
│ webterm agent (single Go binary)                         │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ HTTP layer                                         │  │
│  │  GET  /              → go:embed static assets      │  │
│  │  POST /auth/pair     → pairing                     │  │
│  │  *    /api/devices*  → device management REST      │  │
│  │  GET  /ws            → WebSocket upgrade           │  │
│  │                        (auth + Origin)             │  │
│  │  TLS: autocert (production) | plain HTTP (--dev)   │  │
│  └───────────────┬────────────────────────────────────┘  │
│                  │                                       │
│  ┌───────────────▼─────────────┐   ┌───────────────────┐ │
│  │ Session Manager             │   │ Store (SQLite)    │ │
│  │  sid → Session              │   │  devices          │ │
│  │  limit / naming / lifecycle │   │  pairings         │ │
│  └───────────────┬─────────────┘   │  settings         │ │
│                  │                 └───────────────────┘ │
│  ┌───────────────▼────────────────────────────────────┐  │
│  │ Session                                            │  │
│  │                                                    │  │
│  │   PTY ──read──┬──> ring buffer (out_seq) ──> delta │  │
│  │    ▲          └──> emulator (vterm) ──> snapshot   │  │
│  │    │               (same lock, same bytes)         │  │
│  │    └──write── input queue (in_ack)                 │  │
│  │                                                    │  │
│  │   bash -l -i      CWD ← /proc/<fg pgrp>/cwd        │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

## Key data flows

### Output path (PTY → browser)

```
PTY.Read()
   ↓  raw bytes (may be split anywhere); not a single byte is changed
under lock ┬─> ring buffer append        out_seq += len
           └─> terminal emulator Write   bytes consumed == head_seq; its query replies are discarded
   ↓
subscribed WS connections: OUTPUT frames
   ↓
browser: streaming TextDecoder → term.write(string)
```

**Key invariant**: `out_seq` = the session's cumulative PTY output bytes; the agent doesn't rewrite the output stream; `SNAPSHOT` frames don't count toward `out_seq` (CLAUDE.md invariant 4). See [ADR-0026](adr/0026-agent-holds-terminal-state.md).

### Input path (browser → PTY)

```
keys / extra keys / text page
   ↓  assign in_seq (cumulative bytes)
append to the local resend queue (kept until acked)
   ↓
WS binary frame → agent
   ↓  check in_seq continuity
PTY.Write()
   ↓
in_ack += len  →  ack control message → client trims its resend queue
```

### Resume path (reconnect, switch back, reload)

```
client reconnects (cookie auth)
   ↓  hello{ client_id, instance_id, resume: [{sid, out_seq}, ...] }
agent decides per session:
   ├─ instance_id mismatch                     → gone: the agent restarted and sids were reallocated
   ├─ out_seq > 0 and ∈ [base_seq, head_seq]   → ok: resend raw bytes from out_seq (incremental)
   └─ anything else (reload, out of window, …) → snapshot: the emulator exports the current screen + up to 2000 lines of history
   ↓  welcome{ instance_id, sessions, resumed: [{sid, status, from_seq, in_ack}, ...] }
client trims its resend queue by in_ack and resends the input after it
(in_ack is tracked per (client_id, sid) and survives reconnects — otherwise every reconnect would hit input_gap)
```

Switching back to a session uses `subscribe{out_seq, cols, rows}` with the same decision; a column change always takes the snapshot path (the agent's reflow wins). Details in [`../30-protocol/websocket-protocol.md`](../30-protocol/websocket-protocol.md) §5.

## Layers and directories

```
cmd/webterm/            main, CLI subcommands (install / serve / pair / devices / doctor / reload / update)
internal/
  agent/                HTTP routes, TLS, lifecycle
  auth/                 pairing, devices, cookie sessions, rate limiting
  session/              Session Manager, Session, PTY, CWD polling
  ringbuf/              ring buffer (sequence numbers, byte-based trimming, slicing)
  vterm/                agent-side terminal emulator (wraps tuios.dev/vt): write, resize, snapshot, export / import state
  handoff/              session snapshot for the hot-upgrade handoff
  protocol/             message types, binary frame codec (Go side of the contract)
  store/                SQLite schema, migrations, queries
  wsconn/               WebSocket connection layer
  webui/                go:embed mount point for the frontend build
web/
  src/
    app/                wiring: form detection, tab bar / session drawer, connection banner and toasts
    keys/               extra keys and text page, keymap, IME fallbacks for direct input, input path counters
    term/               xterm wrapper, replay gate, gestures
    sessions/           session state, switching, unread
    conn/               WebSocket connection layer, seq accounting, resend queue, backoff
    ui/                 shared components: sheets, pairing page, viewport
    protocol/           message types, codec (TS side of the contract)
  tests/                Vitest
  e2e/                  Playwright
docs/                   this directory
```

**`internal/protocol` and `web/src/protocol` must match exactly**, and both follow [`../30-protocol/websocket-protocol.md`](../30-protocol/websocket-protocol.md). A change to only one side is a bug.

## Concurrency model (agent)

Each Session runs four goroutines:

| goroutine | Responsibility |
|---|---|
| `readLoop` | `PTY.Read()` → ring buffer + terminal emulator (same lock) → broadcast to subscribers |
| `writeLoop` | take data from the input channel → `PTY.Write()` → update `in_ack` |
| `waitLoop` | `cmd.Wait()`; when the process exits, set the `exited` state and the exit code |
| `cwdLoop` | read `/proc/<foreground process group>/cwd` once a second; on change, update the session name and broadcast |

Each WebSocket connection has two goroutines (read and write). **Both queues are bounded and neither blocks** — when one fills up, the connection is dropped and the client resumes on reconnect.

- A blocked write side backpressures into `PTY.Read()`, so one slow client could slow down the real work running on the server
- A blocked read side is worse: one connection carries all sessions, so a foreground program that doesn't read stdin would stall the whole connection's read loop (ping, resize and every other session's input all stop)

`Session.mu` is an RWMutex. Appending to the ring buffer and writing to the emulator must happen under the same lock, on the same bytes; otherwise a snapshot's `seq` won't match its content and resume will compute the wrong slice.

## Session and process lifecycle

```
create ──> running ──(shell exits)──> exited ──(user closes)──> destroyed
              │
              └──(user closes)──> SIGHUP ──2s──> SIGKILL ──> destroyed
```

In the `exited` state a session keeps its ring buffer and emulator: it can be viewed, resumed and snapshotted, but accepts no input.

**Agent process exit = every session destroyed** (the PTY master closes → the shells get SIGHUP). This is an accepted trade-off; see [ADR-0003](adr/0003-no-tmux.md). A hot upgrade re-execs in place and doesn't exit ([ADR-0016](adr/0016-hot-reexec.md)).

## Decision records

| ADR | Decision |
|---|---|
| [0001](adr/0001-agent-first-no-ssh.md) | Agent first: no SSH in the path |
| [0002](adr/0002-self-contained-binary.md) | A self-contained single binary with no external platform |
| [0003](adr/0003-no-tmux.md) | No tmux; the agent owns the PTYs |
| [0004](adr/0004-acme-only-tls.md) | TLS via ACME only |
| [0005](adr/0005-sqlite-pure-go.md) | Pure-Go SQLite for storage |
| [0006](adr/0006-agent-side-osc-parsing.md) | The agent parses and strips OSC (superseded by 0026) |
| [0007](adr/0007-dual-mode-input.md) | Dual-mode input (Composer / Raw) (superseded by 0013, 0025) |
| [0008](adr/0008-pinned-history-as-snippets.md) | Quick commands = pinned history (superseded by 0025) |
| [0009](adr/0009-hybrid-ws-framing.md) | Hybrid WebSocket framing: binary data + JSON control (amended by 0026: SNAPSHOT frame added, ATTR_PREFIX removed) |
| [0010](adr/0010-bash-rcfile-injection.md) | Shell integration through an injected temporary rcfile (superseded by 0026) |
| [0011](adr/0011-read-first-layout.md) | Read-first three-state layout (mobile part superseded by 0013) |
| [0012](adr/0012-ai-cli-conversation-first.md) | Conversation-first reading and writing for claude / codex (mobile part superseded by 0013) |
| [0013](adr/0013-terminal-only.md) | The terminal is the only display surface (§2–§5 superseded by 0025) |
| [0014](adr/0014-input-toggle.md) | Input toggle key in the bottom bar (superseded by 0025) |
| [0015](adr/0015-bottom-keyrow.md) | Single key row in the bottom bar (superseded by 0025) |
| [0016](adr/0016-hot-reexec.md) | Hot upgrade: re-exec in place and hand over the sessions |
| [0017](adr/0017-numeric-pairing-code.md) | Numeric pairing code that can be typed in when the QR code can't be scanned |
| [0018](adr/0018-one-drawer-primitive.md) | One sheet primitive for all secondary UI (the ⋯ menu and history sheet were removed with 0025; settings and the centered dialog were removed with 0030, then brought back by 0037 and split by form) |
| [0019](adr/0019-altscreen-redraw-not-replay.md) | The alternate screen is redrawn, not replayed (superseded by 0026) |
| [0020](adr/0020-input-never-silently-dropped.md) | The input path never drops input silently |
| [0021](adr/0021-drag-preview-not-live-relayout.md) | Gestures that follow the finger only preview; layout changes wait until release (its subject was removed with 0025; the principle stands) |
| [0022](adr/0022-drop-command-palette.md) | Drop the command palette |
| [0023](adr/0023-terminal-font-list.md) | A probed list of terminal fonts (superseded by 0030) |
| [0024](adr/0024-scrollback-layered-model.md) | Layered scrollback model: keep content in the append stream first (§2–§4 superseded by 0026; §1 stands) |
| [0025](adr/0025-termux-style-ui.md) | Termux-style UI: full-screen terminal + two rows of extra keys, with session switching by device (§3 Enter amended by 0027, §5 vertical drag amended by 0029, settings removed by 0030 with two brought back by 0037, tab width amended by 0031, `+` moved out of the tab strip by 0035, §3 text page made per-session by 0036) |
| [0026](adr/0026-agent-holds-terminal-state.md) | Output path: the agent holds the terminal state, the browser only displays it |
| [0027](adr/0027-text-page-enter-submits.md) | Text page: Enter sends and submits |
| [0028](adr/0028-settings-without-notes.md) | No explanatory text in the settings panel (panel removed by 0030) |
| [0029](adr/0029-touch-drag-to-wheel.md) | A vertical touch drag becomes wheel events when the program tracks the mouse (calibration removed by 0032) |
| [0030](adr/0030-no-settings.md) | No settings: theme follows the system, font size and font use defaults; the session button shows the session count (theme, font size and sheet forms superseded by 0037) |
| [0031](adr/0031-tabs-equal-width.md) | Tab bar: equal-width tabs that scroll horizontally when they don't fit (position of `+` amended by 0035) |
| [0032](adr/0032-drag-wheel-per-row.md) | Touch drag to wheel: no calibration, one event per row height of finger movement |
| [0033](adr/0033-own-fit.md) | Compute terminal rows and columns ourselves instead of using FitAddon (fixes the column count flipping at some widths) |
| [0034](adr/0034-system-service-oom-priority.md) | System service running as a normal user: the agent is no longer OOM-killed before its sessions |
| [0035](adr/0035-tabbar-new-button-pinned.md) | The tab bar's `+` moves out of the scrolling strip: always visible, set apart from the tabs, aligned with the status dot |
| [0036](adr/0036-text-page-per-session.md) | The text page follows the session: each session keeps its own page and draft |
| [0037](adr/0037-settings-theme-and-font-size.md) | Settings come back with only theme and terminal font size; sheets split by form; the session drawer gets a minimum height and bottom padding |
| [0038](adr/0038-close-confirm-sheet.md) | Close confirmation uses our own sheet instead of the browser's `confirm()`; a closing session receives nothing more |
| [0039](adr/0039-drawer-row-swipe-actions.md) | Swipe actions on the phone session list; rename in a small sheet; sheets follow the visual viewport |
| [0040](adr/0040-session-order-drag.md) | Sessions can be reordered by dragging, and the order lives on the agent (protocol adds `session.move` / `session.order`) |
| [0041](adr/0041-tab-index-and-edit-icon.md) | Tab names carry an index `[n]` (as in the drawer, renamed tabs included); the text page button is an SVG pencil sticking out of a rounded box |
| [0042](adr/0042-red-means-error-and-line-icons.md) | The unread dot uses the accent color and red means errors only; line icons for the tab / sheet ✕ and the pin marker; drawer paths no longer reversed, name first |
| [0043](adr/0043-terminal-title-as-auto-name.md) | A terminal title set by the foreground program (not the shell) becomes the session's automatic name, ahead of the directory name; titles set at the shell prompt are ignored |
| [0044](adr/0044-ip-address-certificates.md) | Deploy without a domain: Let's Encrypt IP certificates |
| [0045](adr/0045-install-from-the-binary.md) | The install script ships inside the binary (`webterm install`) |
| [0046](adr/0046-guided-install.md) | Guided install: the installer walks you through the manual steps and re-checks them |
| [0047](adr/0047-review-fixes.md) | Edge cases from the full review: hot upgrades follow the installed command line, a page's newest connection owns its input, changes wait for a handoff, `nohup` survives closing |
