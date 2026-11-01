# ADR-0024 Layered scrollback model: keep content in the append stream

Status: Accepted (2026-09-14). **§2–§4 are superseded by [ADR-0026](0026-agent-holds-terminal-state.md)**: output writes and touch scrolling are native xterm again, the agent's snapshot provides history after a reload, and alternate-screen drag-to-wheel was dropped (and later reintroduced differently by [ADR-0029](0029-touch-drag-to-wheel.md)). §1 (inject an environment variable to keep claude on the main screen) still holds.

## Context

### Requirements

| | Requirement |
|---|---|
| **R1 Scrollback** | Scrolling up shows earlier output, **including after a page reload** |
| **R2 No duplicates** | Each piece of output appears once |
| **R3 No corruption** | Wrapping and alignment match what was produced; no screens mangled by diff frames |
| **R4 No jank** | Dragging follows the finger; replay and restore don't monopolize the main thread |

### Symptoms

- After a reload the terminal shows only the last screen and scrolling up shows nothing, even if xterm held thousands of lines before.
- On phones, a vertical drag inside claude does nothing.
- On desktop the wheel "works" in claude, but that's claude scrolling its own conversation, not terminal scrollback. A reload loses it.

Why a reload leaves one screen: the reload resets each session's `outSeq` to 0, so `subscribe{out_seq: 0}` makes the agent send the entire ring buffer. That window contains an `ESC[?1049h`, so everything after it is drawn on the **alternate buffer**, which has no scrollback. Thousands of absolutely positioned diff frames overwrite each other, and replaying 1 MiB ends in exactly the same state as drawing only the last frame. Nothing is lost after loading; it was all drawn on one screen.

### Scrollback exists only for append-stream content

[ADR-0019](0019-altscreen-redraw-not-replay.md) splits session output into two kinds, and the same split decides whether there is history to scroll:

- **Append stream** (main screen, with line feeds): lines scroll off into scrollback. Scrolling back makes sense, and replay and restore have a correct model.
- **State** (alternate-screen diff frames): the terminal never sees history, only screens overwriting each other. Neither scrollback nor the ring buffer can reconstruct it. **tmux, mosh and iTerm can't either**: an alternate-screen program's history lives inside that program.

So R1–R3 don't need a smarter replay algorithm. They need the content to **stay in the append stream**, plus a rebuild discipline for reloads. R4 is orthogonal and needs its own work.

### Measured: claude 2.1.270 renderers

pty 100×30, `TERM=xterm-256color`, cwd at the repo root, with inherited `CLAUDE_*` / `AI_AGENT` variables cleared (otherwise claude runs in a degraded "nested session" mode and the numbers are wrong).

| | Default (fullscreen) | `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` |
|---|---|---|
| Startup bytes | 1383 B | 1430 B |
| `ESC[?1049h` | **once** (within the first 20 B) | **never** |
| LF (`0x0a`) | **0** | **10** |
| DECSET modes | 1000 · 1002 · 1003 · 1004 · 1006 · 2004 · 2031 · 25 | 1004 · 2004 · 2031 · 25 (**no mouse tracking**) |
| Per keystroke | diff frame, absolute positioning (~40 B, see ADR-0019) | 45–66 B, `ESC[A`/`ESC[B` + `ESC[K`: in-place redraw with **relative** cursor moves |
| Window resize | 1.2 KB full redraw | 1402 B full redraw |
| One SGR wheel report | 52 B redraw (claude scrolls itself) | — |

1. With the default renderer claude's output is **state**. There is no terminal-level history to scroll. That's not a webterm defect; a local terminal behaves the same.
2. `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` turns it back into an **append stream**, and in-place redraws use **relative** cursor moves, so replaying from any clean starting point converges. That is the assumption webterm's replay model relies on.
3. The classic renderer still handles SIGWINCH (1402 B redraw), so the fallback in [ADR-0019](0019-altscreen-redraw-not-replay.md) §6 still works.

Two limits on these conclusions:

- The probe used an empty session. The 52 B wheel response only proves claude received the wheel and redrew, not how far it can scroll. The binary contains `CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL` / `CLAUDE_CODE_SCROLL_SPEED`, so alternate-screen scrolling is claude's own virtual scroll.
- `CLAUDE_CODE_*` are **private upstream switches** with no compatibility promise (the binary says: "the next launch will use the classic renderer (`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` forces that any time)"). So the injection must be possible to turn off and possible to verify (see [Verifying step 1](#verifying-step-1)).

### Measured: xterm.js 5.5

- In xterm's mouse protocol table, bit 4 (16) is WHEEL in `VT200` (19), `DRAG` (23) and `ANY` (31). **Once a program enables `?1000` or higher, the wheel belongs to the program** and local scrollback doesn't move. claude enables 1000+1002+1003+1006.
- The alternate buffer has no scrollback, so `.xterm-viewport` has nothing to scroll. That's the mechanical reason the drag does nothing: our touch handler set `scrollTop`, which stays 0 on the alternate screen.

### Sources of jank (independent of the history model)

1. **Touch drag runs as main-thread JS.** `.term` has `touch-action: none` (touches land on `.xterm-screen`, a sibling of the scroll container, so native touch scrolling can't move it). Every `touchmove` set `scrollTop` synchronously and ran a `querySelector`. The compositor isn't involved, and scrolling stops dead on release, with no inertia.
2. **Forced writes interrupt reading.** While follow is paused, the output queue drained everything at once after 2 MiB or 4000 lines, interrupting whoever was reading old output. Step 1 makes claude a real line stream, so this happens more often.
3. **Replay is written in one go.** The replay path bypassed the queue and wrote up to 1 MiB at once. xterm parses in ~12 ms slices so the page doesn't freeze, but it takes dozens of frames, and scrolling stutters meanwhile.

## Decision

Four steps, **shipped in this order**. Steps 1–2 fix everyday use; steps 3–4 cover the edges.

**No step adds a protocol message.** `out_seq` accounting (invariant 4 in [CLAUDE.md](../../../CLAUDE.md)), incremental resume (`resumed[].status == "ok"`), and ADR-0019's two models (main screen = append stream, alternate screen = state) stay exactly as they are.

### 1. Content: keep full-screen TUIs on the main screen

Two new flags:

```
--session-env KEY=VAL     # repeatable; environment variable injected into session PTYs
--no-altscreen-compat     # disable the built-in list below
```

Built-in list, injected when a session is created (`cmd.Env` in `internal/session/manager.go`):

| Variable | Value | Why |
|---|---|---|
| `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` | `1` | claude uses its classic renderer, so output is an append stream again |

- **Never override what the user already set.** If the agent's own environment (or `--session-env`) already has the key, the user's value wins. It's their machine.
- **`--session-env` takes precedence over the built-in list**, and `--no-altscreen-compat` disables the list entirely. Both are in `configKeys`, so they can go in the config file.
- **The list only holds variables that keep full-screen TUIs on the main screen.** Nothing that changes what a program does (model, permissions, telemetry).

On by default because webterm exists to [run AI CLIs from a phone](0012-ai-cli-conversation-first.md), where the alternate screen is pure loss: no scrollback, nothing to drag, one screen after a reload, a forced redraw on every switch back. It must be possible to turn off because upstream promises nothing, and some people prefer the input box pinned to the bottom.

The cost, which [install.md](../../80-ops/install.md) must state: **claude's input box is no longer pinned to the bottom of the screen; it's the last few lines of the output stream.** Measured with the classic renderer at 100×30, running a command that prints 60 lines and feeding the bytes into a minimal VT renderer:

```
scrollback  ……  40  41                    ← the 47 lines that scrolled off: all real output
screen 0-18   42 … 60                     ← the rest of the output
screen 20     ● assistant message
screen 24-26  ───────  ❯ hi  ───────      ← input box: at the bottom while following
screen 27-28  ⏵⏵ auto mode on · status hints
```

- **While following output, the input box is still at the bottom of the screen**, visible and usable. No change from before.
- **It scrolls out of view only when you scroll back** (on the alternate screen you couldn't scroll, so it was always there). Scroll to the bottom and it's back. On phones, typing goes through webterm's own [bottom key row and edit panel](0015-bottom-keyrow.md), which is page UI pinned to the bottom and doesn't depend on claude's box.
- **No stale copies of the input box ended up in scrollback in this run.** The classic renderer erases its active area before appending (the `ESC[K` in each 45–66 B keystroke update), and all 47 scrolled-off lines were real output. That makes R2 cleaner than expected, but it's one observation, not a guarantee; step 5 of E2E-36 asserts it.

### 2. Gestures and rendering: make scrolling follow the finger

Superseded by ADR-0026 §7. Three independent frontend changes:

- **Apply the drag once per frame** in a `requestAnimationFrame` callback, with inertia on release (none under `prefers-reduced-motion`).
- **Drain forced writes in slices**, one budgeted slice per frame, so a reader isn't interrupted by one huge write.
- **Route all large writes through one budgeted writer** (replay, snapshot restore, forced drains; 64 KiB per frame to start). **Order never changes**: xterm can't prepend, so "draw the last screen first, then backfill history" is wrong.

Gate: **no long task over 50 ms** while dragging, at most one `scrollTop` write per frame. This dev machine has no GPU, so only main-thread milliseconds are trustworthy; real-device numbers go in the [manual checklist](../../70-testing/manual-checklist.md).

### 3. Persistence: scrollback survives a reload

Superseded by ADR-0026 §3 (the agent sends a snapshot instead); never merged. The plan was a client-side `SerializeAddon` snapshot of the last 2000 lines, saved to IndexedDB on `pagehide` together with the session's `outSeq` and keyed by `instance_id:sid`, then restored before `subscribe{out_seq}`. The rules that made it safe still explain the snapshot design that replaced it:

- **The snapshot and `outSeq` must come from the same instant**, or nothing is stored. Using a snapshot while reporting `out_seq: 0` makes the agent **append the whole history again**, which is the real source of duplicates (R2).
- **Discard on `instance_id` mismatch**: the agent restarted and sids are reused (same reason as AC-2.13).
- **Don't snapshot alternate-screen sessions.** State isn't a stream; storing it produces ADR-0019-style ghosts.
- **2000 lines, not 5000.** 5000 lines with SGR attributes can reach several MB, too much to serialize in `pagehide`.

### 4. Alternate screen: hand scrolling to the program

Superseded by ADR-0026; the drag-to-wheel part was later reintroduced by [ADR-0029](0029-touch-drag-to-wheel.md). This step serves vim, less, htop, and people who keep the alternate screen.

- When the buffer is alternate **and** `term.modes.mouseTrackingMode !== 'none'`, a vertical drag no longer sets `scrollTop`. It accumulates by line height and dispatches synthetic `WheelEvent`s to `.xterm-screen`, **letting xterm encode the report in whatever protocol is active** (x10 / vt200 / 1006 / 1015). We don't build SGR sequences ourselves; that would re-implement protocol selection.
- **Throttle** to at most 3 lines per 16 ms. One swipe can be dozens of lines; unthrottled, it floods the PTY.
- **Alternate-screen programs without mouse tracking stay as they are** (no drag). **Never** fall back to PageUp or arrow keys: that changes program state (vim moves the cursor), which is worse than doing nothing.

This path satisfies R2/R3 by construction (every screen is a full frame drawn by the program) but **can't satisfy R4**: each scroll costs a round trip plus a redraw (52 B to 1.2 KB measured), so it feels like paging. Only step 1 gives smooth scrolling.

#### Wheel reports can change program state, not just scroll (measured 2026-09-19)

tmux 3.5a's default root binding:

```
WheelUpPane → if -F "#{||:#{pane_in_mode},#{mouse_any_flag}}"
                 { send-keys -M }   # the program in the pane enabled mouse tracking → forward to it
                 { copy-mode -e }   # otherwise → enter copy-mode
```

With `mouse on`, tmux asks the outer terminal for mouse tracking, so webterm forwards the wheel to it. If the pane's foreground program has **no** mouse tracking at that moment, one wheel report puts the pane into **copy-mode**, and **every keystroke after that is a copy-mode command instead of input to the program**.

The user sees "I can't type", and **nothing on the webterm side helps**: clicking the terminal, switching sessions, reloading, reconnecting. The state is in the tmux server. The way out is `q` / `Esc`. This isn't tmux-specific; any program where the wheel enters a mode behaves the same.

**The trap already exists** on desktop, because the wheel there goes through xterm.js's own mouse reporting (see [Measured: xterm.js 5.5](#measured-xtermjs-55)). This step only extends it to touch drags. [Step 1](#1-content-keep-full-screen-tuis-on-the-main-screen) makes it **more frequent**: classic-renderer claude doesn't enable mouse tracking, so with claude inside tmux, every wheel that claude used to consume now pushes tmux into copy-mode.

**Decision: after forwarding the wheel, give the user a visible way out.** This follows directly from [ADR-0020](0020-input-never-silently-dropped.md): nothing may go dead silently.

- After the first time a session's scroll is forwarded as wheel reports, if the user starts typing and **the screen's byte stream doesn't change at all for ~1.5 s**, show one line in the hint slot (bottom right, reusing the "back to bottom" hint): "Scrolling went to the program. If you can't type, press `Esc` or `q` to leave its scroll mode." At most once per session; dismissing it is permanent.
- **A heuristic rather than always showing it:** for vim and less, where the wheel only scrolls, an unconditional hint is noise. "Keys were typed and the screen didn't change by a byte" is itself evidence the input wasn't taken; a TUI always redraws on a keystroke.
- **Never press `Esc` / `q` for the user.** That changes program state (`q` can mean something else elsewhere), the same rule as "never fall back to PageUp or arrows".

### Not doing

- **Server-side headless VT / line-level history.** The thorough fix: it makes scrollback depth a predictable line count instead of a byte count, and also fixes two known limits (hard trimming cutting escape sequences, replay re-wrapping at the client's width). But it adds a dependency, tens of KB of resident state per session, an extra parse of every byte, and the handoff must carry screen plus history. Kept as a v0.2 candidate (already noted in ADR-0019 §7); [ADR-0026](0026-agent-holds-terminal-state.md) later adopted it.
- **Don't change replay width semantics.** On reload, `subscribe` carries the size after the client's `fit()`, and the agent decides the resume branch before applying it (protocol §4.1). Those bytes were produced at the **old** width and re-wrap at the **new** one: rotate, then reload, and box drawing is skewed for one screen until the next full redraw. **Accepted**: no duplicates, self-healing, and eliminating it costs the previous item.
- **Don't touch incremental resume.** The `status == "ok"` path stays byte-for-byte; AC-2.1 is this ADR's regression line.
- **Don't fabricate scrollback for the alternate screen.** Guessing which lines scrolled off from accumulated diff frames means writing half a terminal emulator in the client; one mistake is permanent misalignment.

## Consequences

- **Depends on a private upstream variable** (step 1). If it stops working, claude goes back to the alternate screen; nothing crashes. `--no-altscreen-compat` and the [checks below](#verifying-step-1) are the escape hatches.
- **claude's input box becomes the last lines of the stream** instead of being pinned (step 1). While following it's visible and usable; it only scrolls away when reading back. This is the biggest user-visible change and must be documented.
- **One more client-side store** (step 3, never shipped): up to 2000 serialized lines per session in the browser. Invariant 3 (no output on disk) is about the agent, but a browser-side copy would have had to be stated in the [privacy doc](../../60-security/privacy-history.md).
- **Inertial scrolling feels different** (step 2) from the old stop-on-release. `prefers-reduced-motion` keeps the old behavior.
- **Alternate-screen scrolling still feels like paging** (step 4), and the depth is up to the program. That's the floor of the terminal model, not a shortcut.

### Verifying step 1

Both questions must be answerable in a live session:

1. **Was the variable injected?** Run `env | grep CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` in the session.
2. **Did the program actually stay on the main screen?** Run `__webterm.altScreen()` in the browser console (a debug hook that ships in production builds). `false` means it worked.

**Don't verify by capturing `ESC[?1049h` with `script -c claude`.** When `script` provides no window size, claude falls back to the classic renderer on its own (zero `?1049h`), regardless of the injection. This also shows the classic renderer is a normal, supported upstream path: it's the fallback for limited terminals, not a back door we pried open.

### Docs, criteria and tests

- **Docs updated**: acceptance criteria, session UX, responsive layout, session manager (environment), install (two flags plus the claude change), troubleshooting ("can't scroll back / only one screen after reload"), privacy, E2E scenarios, milestones, architecture overview.
- **New acceptance criteria**: AC-5.14–AC-5.17 and AC-7.8. ADR-0026 later deleted AC-5.15–5.17 (drag per frame, budgeted writer, alternate-screen wheel) and rewrote AC-5.14 (scrollback after reload, now served by the agent). The two that remain:
  - **AC-5.14**: after a reload the user can scroll back through the last 2000 lines (or everything, if shorter); content matches line for line and **appears once**.
  - **AC-7.8**: `--session-env` is injected into session PTYs; `--no-altscreen-compat` disables the built-in list; **a variable the user already set is never overridden**.
- **Tests**: Go UT/IT for `--session-env` parsing and precedence (user over built-in), `--no-altscreen-compat`, and not overriding existing values; E2E-36 / 37 / 38. **Regression lines**: `TestByteLevelContinuity` / E2E-2 (AC-2.1) and `TestHandoffByteLevelContinuity` must pass unchanged. None of the steps touch the incremental path; if those go red, something touched what it shouldn't.
- **Code**: `cmd/webterm/flags.go` and `cmd/webterm/config.go` (flags, `configKeys`); `internal/session/manager.go` (`cmd.Env`). The frontend parts were removed by ADR-0026.
