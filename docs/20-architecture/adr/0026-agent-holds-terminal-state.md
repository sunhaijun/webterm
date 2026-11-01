# ADR-0026 Output path: the agent holds terminal state, the browser only displays it

Status: Accepted (2026-10-30). Shipped in the same PR as [ADR-0025](0025-termux-style-ui.md) (m8).

Supersedes:

- [ADR-0019](0019-altscreen-redraw-not-replay.md) (redraw instead of replaying the alternate screen) entirely.
- [ADR-0024](0024-scrollback-layered-model.md) §2 (budgeted writes, pausing follow while reading back), §3 (client snapshot) and §4 (alternate-screen drag to wheel). §1 (inject an environment variable to keep claude on the main screen) stays.
- [ADR-0006](0006-agent-side-osc-parsing.md) (agent parses and strips OSC) and [ADR-0010](0010-bash-rcfile-injection.md) (rcfile-injected shell integration) entirely. The agent no longer rewrites the output stream, and shell integration is gone.
- The "keep OSC 7" sentence in [ADR-0025](0025-termux-style-ui.md) §10, and its rollout: the first two steps merge into one PR.

Amends [ADR-0009](0009-hybrid-ws-framing.md) (hybrid framing): adds the `SNAPSHOT` frame type and removes the `ATTR_PREFIX` flag. Protocol version 1 → 2.

Unchanged: byte-level continuity of incremental resume (AC-2.1 ★); input `in_seq` / `in_ack` (AC-2.4 / AC-2.12); hot upgrade keeps sessions ([ADR-0016](0016-hot-reexec.md); what's handed off changes); input is never silently dropped ([ADR-0020](0020-input-never-silently-dropped.md); the replay gate stays).

## Context

Output display was "nearly unusable", and there was no way to tell where the problem was.

### The old model: the agent stores bytes, the browser stores the screen

The agent only had output bytes (the ring buffer); screen state existed only in the browser's xterm. Whenever the browser missed part of the byte stream (switched away, disconnected past the window, reloaded), the screen had to be rebuilt. Four patches accumulated for that:

| Patch | What it covered for | Source |
|---|---|---|
| Reset replay: an `ATTR_PREFIX` frame clears the screen and replays the whole window | The window doesn't line up with the screen the browser has | Protocol §3 / §5 |
| Replay gate: swallow xterm's automatic replies to historical queries during replay | Queries in old bytes get answered again, and the answers reach the program as keystrokes | ADR-0020 |
| Alternate-screen redraw: the agent tracks sticky modes, jiggles the window size to force a redraw, 300ms fallback | A byte window can't rebuild vim's or codex's current screen | ADR-0019 |
| Client snapshot: save to IndexedDB before reload | After a reload the browser has nothing | ADR-0024 §3 (never merged; blocked on a protocol bug) |

Add the performance layer (per-frame coalescing, pause while reading back, 64 KiB budgeted writes) and shell integration (OSC stripping, command records, integration state machine), and every failure looked the same: the screen is wrong. Nothing could be attributed.

The root cause is a **model mismatch**. Alternate-screen output is a series of mode-dependent diffs; once the byte window slides past `ESC[?1049h`, the screen can't be rebuilt (see the context of [ADR-0019](0019-altscreen-redraw-not-replay.md)). Termux and tmux don't have this problem because the terminal emulator sits next to the PTY and the screen state is always there.

### Offline experiment (2026-10-30)

Of the candidates, only [tuios.dev/vt](https://pkg.go.dev/tuios.dev/vt) (v0.3.2, MIT, a fork of charm `x/vt`) can export **complete state**. Its `snapshot.Capture` + `snapshot.Replay` produce bytes any xterm can consume, carrying terminal modes, the current pen, scroll region, character sets, tab stops, cursor shape, a pending soft wrap, and even **a partially parsed sequence**. charm `x/vt`, `vt10x` and `midterm` can only export the picture and weren't tested further.

**Consistency**: 17 real recordings (claude in both renderers, codex, vim, tmux, less, top, python, long logs, colored CJK output) × 23 cut points each, some deliberately inside escape sequences and multibyte characters. With xterm.js (headless 5.5, unicode11) as the judge, compare "xterm consumes the raw bytes" against "xterm consumes the snapshot, then the bytes after the cut", cell by cell: character, width, color, attributes, cursor, modes.

- Identical: claude ×3, codex, vim, tmux, python, long logs, colored CJK output, a synthetic alternate-screen TUI.
- Only three visible differences:
  - top's header loses reverse video in its last cell. The program fills the line and then sends `EL`; xterm.js doesn't erase the last cell, while real xterm, ghostty and tuios do. This is an xterm.js deviation.
  - SGR 53 (overline) is dropped by `Replay`.
  - With autowrap off, a cursor parked in the last column is recorded differently (100 vs 99). Invisible on screen.
- Visible only on reflow: lines rewritten by programs like less carry the soft-wrap flag on different sides (xterm marks the next line, tuios the previous one, so `EL` clears different things).
- **After a resize, each side reflows on its own and the results differ.** Changing columns produced hundreds of differing history lines. Changing only rows differed in a few aligned blank lines in some cases, and where the program didn't receive SIGWINCH in others.

**Performance** (one core of a Xeon E5-2697 v2):

| Item | Value |
|---|---|
| Parse throughput | 13–52 MB/s, about 22 MB/s mixed. claude produces only 0.5–0.8 KB/s |
| Resident per session | < 1 MiB with 5000 lines of history; 0.06 MiB empty |
| Snapshot, current screen only | 0.3–3 KiB, < 0.5 ms |
| Snapshot with 2000 lines of history, ordinary content | 108–169 KiB, about 35 ms (limit in §3) |
| Snapshot of a running claude / vim / tmux | ≤ 4 KiB |
| Browser applying a 2000-line snapshot | 11–24 ms (vs 60–75 ms to replay a 1 MiB window) |
| Binary size | +1.8 MB, builds with `CGO_ENABLED=0` |

**A bug found along the way**: xterm.js `write(Uint8Array)` (5.5 and 6.0.0) drops the whole character when a 3-byte UTF-8 character is split across two writes right after its second byte and that byte is `0x80`. Measured with `…` and `。`; the same pattern covers U+2000–203F and U+3000–303F (`— “ ” ‘ ’ • 、「」《》`). Both PTY read boundaries and the 64 KiB budgeted writer split characters, so CJK output occasionally lost punctuation, and byte-level continuity tests couldn't catch it.

## Decision

### 1. The agent runs a terminal emulator per session

- Use `tuios.dev/vt`, **pinned at v0.3.2**, wrapped in `internal/vterm`. Session code goes through a handful of methods: write, resize, snapshot, export / import state (for hot upgrade). Replacing the implementation touches only that package.
- **All PTY output is fed to it**, whether anyone is subscribed or not, under **the same lock** as the ring-buffer append. At any moment the number of bytes the emulator has consumed equals `head_seq`.
- **2000 lines** of history, the same as a snapshot carries; storing more couldn't be sent anyway.
- Query replies generated by the emulator are **discarded**; queries are still answered by the browser's xterm (§5).

### 2. The agent no longer rewrites the output stream

Shell integration is gone (§6), so there's no OSC to strip. **`seq` = cumulative PTY output bytes for the session**, with not one byte changed. `ATTR_PREFIX` is removed.

### 3. Subscribing has two paths: incremental or snapshot

`hello.resume` (reconnect) and `subscribe` (first open, switching back) use the same decision:

| Condition | Path | What is sent |
|---|---|---|
| Client `out_seq > 0` and still inside the ring-buffer window (`base_seq ≤ out_seq ≤ head_seq`) | **Incremental** (`status: "ok"`) | Raw bytes from `out_seq` on (`OUTPUT` frames), as before |
| Anything else: first open, page reload (`out_seq == 0`), fell out of the window | **Snapshot** (`status: "snapshot"`) | A `SNAPSHOT` frame: `seq` = `head_seq` at generation time, payload = `Replay` bytes (current screen + up to 2000 lines of history + modes + pen + partial sequence); then `OUTPUT` from `seq` on |

- **The ring buffer shrinks to 256 KiB** and serves only the incremental path. Beyond 256 KiB of backlog, a snapshot (≤ 170 KiB, 11–24 ms in the browser) is smaller and faster than replay. The buffer trims by byte, no longer at `\n` boundaries: a client that falls out of the window always gets a snapshot, so the trim position no longer affects what's displayed.
- **Removed**: the `reset` message, the `redraw` message, `ATTR_PREFIX`, `internal/termstate`, window-size jiggling, the 300ms fallback, `notifyReset`.
- **Snapshots are capped at 1 MiB.** Over the cap, regenerate once with proportionally fewer history lines. The "≤ 170 KiB" from the experiment holds only for ordinary content: a 400-column terminal with output changing color every 10 cells measured about 1.6 MiB and 330 ms for 2000 lines, and about 4 MiB at 1000 columns, which hits the connection's write-queue limit.
- A snapshot larger than the per-frame limit (256 KiB) is split across frames with the same `seq`; all but the last carry `FLAG_MORE` (bit0). The browser applies it once all parts arrive.
- On `SNAPSHOT`, the browser writes RIS (`ESC c`) into the write stream to reset → switches to a fresh UTF-8 decoder → writes the snapshot → sets `outSeq = seq`. **Reset with in-stream RIS, not `term.reset()`.** `reset()` is synchronous and doesn't clear the write buffer. When the column count changes, the agent resends a snapshot immediately, and old output that hasn't been parsed yet would be drawn after the reset and before the snapshot. RIS goes into the write buffer together with the snapshot, so ordering is correct by construction (xterm's own comment on `reset()` recommends RIS for this case). The "older output truncated" notice is gone: a snapshot is a complete picture, and nothing was truncated.

### 4. On a column change the agent's reflow wins, and a snapshot is resent

The experiment showed independent reflows disagree, so when the column count changes, the agent's reflow is the single source of truth:

```
cols from resize / subscribe differ from the current value:
  under the lock: emulator.Resize(cols, rows) → generate a snapshot (seq = head) → send to every subscriber of the session
  after the lock: TIOCSWINSZ (the program's SIGWINCH redraw lands after the snapshot)
rows only:
  emulator.Resize + TIOCSWINSZ, no snapshot
```

A rows-only change skips the snapshot because of the on-screen keyboard: on a phone every open and close changes the row count, and resending a hundred-odd KiB each time and wiping the browser's scroll position costs too much. The two sides can only differ in screen areas the program didn't redraw on SIGWINCH, and they converge at the next snapshot (switching back, reconnecting, a column change).

### 5. The browser still answers queries; the replay gate stays with a smaller scope

- The agent's emulator replies are always discarded. The browser's xterm.js remains the one that answers: its capabilities (no kitty keyboard protocol, no kitty graphics, no sixel) and theme colors are authoritative, so what a program detects is what the browser can actually display. If the agent answered, tuios would claim those capabilities and claude would switch to encodings the browser doesn't understand.
- While the browser writes a `SNAPSHOT` or incremental catch-up bytes, xterm's automatic replies **don't reach the PTY**; user input passes through as usual. The criterion is still "who produced it", see [input.md](../../40-frontend/input.md). Snapshot bytes contain no queries, so only incremental catch-up actually needs guarding.
- The cost is unchanged: while no browser is connected, a program's queries go unanswered until it times out.

### 6. The working directory comes from `/proc`; shell integration is removed

- **CWD** = `readlink /proc/<foreground process group>/cwd` (`TIOCGPGRP` on the PTY master), read once per second for each running session; on change, send `session.updated{cwd, name}`. The default session name is still the CWD's basename (AC-4.4). This works with any shell, not just bash. We only build for Linux (CI ships linux/amd64 and linux/arm64), so `/proc` is always there.
- **"Session idle"** (`--when-idle` and the busy count in the control socket's `status`, [ADR-0016](0016-hot-reexec.md) §5) now means the PTY's foreground process group is the shell itself (`TIOCGPGRP` == shell pid, the same call as the CWD read). It used to rely on prompt state, which couldn't tell busy from idle when integration broke; now it's accurate for any shell.
- **The shell starts normally**: `bash -l -i` by default (a login shell, loading bash's own profile chain); `bash -i` with `--no-login-shell` (loads `~/.bashrc`). No more temporary rcfile.
- **Removed**: `internal/shellinit`, `internal/oscparse`, the `webterm shell-init` subcommand, `--no-shell-integration`, the integration handshake and state machine, per-command liveness probes, the `prompt` / `command.start` / `command.end` / `cwd` messages, the session fields `integration` / `prompt_state` / `unmarked_input`, and the whole command history stack: the `commands` table (dropped by a new migration), `/api/commands*`, `/api/fs`, `/api/settings`, `--no-history`, `internal/store/commands.go`.

### 7. The browser output path is native

```
per session: one TextDecoder('utf-8') in stream mode
OUTPUT frame   → term.write(decoder.decode(payload, {stream: true}))
SNAPSHOT frame → decoder = new TextDecoder(); term.write('\x1bc' + decode(snapshot))   // RIS resets in-stream
```

- **Decode to a string first, then write.** This avoids xterm's dropped-character bug on split UTF-8.
- Removed: per-frame coalescing, pausing follow while reading back and its hint, the 64 KiB budgeted writer, mounting WebGL only for the visible session (now xterm's default DOM renderer), custom touch scrolling and inertia (now xterm's built-in), and the client snapshot. Any of them comes back only if measurements call for it. Measure main-thread long tasks (this machine has no GPU); the baseline scenario is E2E-37 in [e2e-scenarios.md](../../70-testing/e2e-scenarios.md).
- The local session-end line ([ADR-0025](0025-termux-style-ui.md) §6) is a direct `term.write()`. xterm writes are FIFO, so it no longer needs to go "through the same writer".

### 8. Hot upgrade hands off emulator state

The sticky modes (`termstate`) in `handoff.Session` are replaced by emulator state: exported with `snapshot.Capture` (with the full 2000 lines of history) and imported in the new process with `snapshot.Apply`. The ring buffer, `seq` and `in_ack` are handed off as before. Snapshots generated for the same session before and after the handoff must be byte-identical.

**Upgrading from an older version** (no emulator state in the handoff data): the new process creates an emulator and feeds it the handed-off ring buffer as a best effort. This only happens on the one upgrade to this version. If a buffer window happens to start in the middle of an alternate-screen program, that session shows a wrong screen once, until the program redraws (or the user presses a key). Don't abort the upgrade over it; keeping sessions alive matters more than one screen.

Hooks installed in bash by the old rcfile survive the upgrade and keep emitting OSC 133 / 1701 / 7. They now pass through to the browser untouched (xterm ignores them) and disappear once that shell exits.

### 9. Dependencies and build

`tuios.dev/vt v0.3.2` and its dependencies (`charmbracelet/x/ansi`, `ultraviolet`, and others) are pure Go and build with `CGO_ENABLED=0`. Its `ghostty` build tag pulls in cgo; we don't enable it. go.mod records a version of `go.mitchellh.com/libghostty`, but it isn't compiled.

### 10. Testing standards

| Path | Standard | Tests |
|---|---|---|
| Incremental resume | **Byte level**: the serialized terminal after a disconnect and reconnect is byte-identical to one without the disconnect (AC-2.1, unchanged) | E2E-2, `TestByteLevelContinuity` |
| Snapshot | **Screen level**: xterm fed the snapshot and then the following bytes matches, cell by cell, xterm fed all the bytes (character, width, color, attributes, cursor, modes; excluding soft-wrap flags and the three known differences above) | Vitest over recorded fixtures (xterm headless as judge), E2E-30 / 31 / 36 |
| Hot upgrade | Snapshots before and after the handoff are byte-identical; the incremental path stays byte-level continuous | `TestHandoffByteLevelContinuity` |

Recorded fixtures (raw bytes from real programs) live in `internal/vterm/testdata/`. Go tests generate snapshots at each cut point, and Vitest compares them using `@xterm/headless` as the judge.

### CLAUDE.md invariants

- **3. No output on disk**: only device and authentication data is persisted (command history is gone).
- **4. Contiguous sequence numbers**: `seq` = cumulative PTY output bytes; the agent doesn't rewrite the output stream; `SNAPSHOT` frames don't count toward `seq`.

## Consequences

- **New dependency**: tuios is young (5 releases, the latest on 2026-10-26, a single maintainer, a v0 API that will change). Mitigation: pin the version, wrap it in `internal/vterm`, use only five or six methods.
- **Throughput ceiling**: the agent parses every session's output, about 20 MB/s per core. `cat`-ing a large file is capped at that speed (tmux has the same limit); interactive programs produce far less.
- **The three visible differences are accepted.** top's cell becomes correct once the program redraws it.
- **A rows-only resize may leave the two sides briefly different**; they converge at the next snapshot (§4).
- **A page reload downloads one snapshot** (≤ 170 KiB) and in return has 2000 lines of scrollback (AC-5.14 is now served by the agent; the browser no longer stores snapshots).
- **Shell integration is gone**: no command records, no prompt state. After `ssh` to another machine, the CWD shown is the local ssh process's directory, as before.
- **While no browser is connected**, programs' terminal queries go unanswered (as before).

### Removed code

| Location | What |
|---|---|
| `internal/termstate` | Sticky mode tracking |
| `internal/oscparse`, `internal/shellinit` | OSC stripping, rcfile |
| `internal/session` | Integration state machine, liveness probes, command records, prompt, redraw, size jiggling, fallback |
| `internal/store/commands.go` and its migration | Command history |
| `internal/agent` | `/api/commands*`, `/api/fs`, `/api/settings` |
| `cmd/webterm` | `shell-init` subcommand, `--no-shell-integration`, `--no-history` |
| `internal/protocol` | `reset` / `redraw` / `cwd` / `prompt` / `command.*` messages, `ATTR_PREFIX` |
| `web/src` | `outputqueue`, `budgetwriter`, `interactive`, WebGL mount, client snapshot |

### Docs updated

`websocket-protocol.md` (v2: `SNAPSHOT` frame, subscribe decision, removed messages), `http-api.md`, `ring-buffer.md`, `session-manager.md`, `storage-schema.md`, `privacy-history.md`, `shell-integration.md` (deleted), all of 40-frontend, requirements and acceptance criteria, E2E scenarios, and the invariants and test requirements in CLAUDE.md.

### Acceptance criteria and E2E

Numbers are never reused.

- **Deleted**: AC-2.7 (`\n` boundaries and the `ESC[0m` prefix), AC-2.16–2.19 (alternate-screen redraw and sticky modes), AC-5.5, 5.9, 5.10, 5.15, 5.16, 5.17, all of AC-6, AC-7.1–7.7; E2E-37's assertions (it becomes a baseline that only records numbers), E2E-38.
- **Rewritten**: AC-2.3, 2.6, 2.11, 2.14, 2.15, 4.4, 5.14; E2E-2c, 4, 30, 31, 36. AC-7.8 (session environment) stays where it is, and the AC-7 section is renamed "Session environment".
- **Added**: AC-2.21 (snapshot is screen-level consistent), AC-2.22 (column change resends a snapshot), AC-2.23 (split CJK punctuation isn't dropped); E2E-42 (column change resends a snapshot), E2E-43 (split UTF-8 isn't dropped).
