# ADR-0019 Alternate screen: redraw instead of replaying history

Status: Accepted (2026-09-13), implemented (the `internal/termstate` observer, the `redraw` message, size jiggle and fallback, handoff fields, E2E-31; the [implementation gaps](#implementation-gaps-found-along-the-way) were fixed first). Superseded by [ADR-0026](0026-agent-holds-terminal-state.md): the agent holds the terminal state and sends a snapshot whenever a client falls out of the window, so `redraw`, sticky-mode tracking, size jiggling and the 300 ms fallback are gone.

## Context

### Symptom

Switch away from a session running claude and come back a few minutes later: the terminal shows **many copies of claude's logo and header**, and the status line that should update in place on the last row **turns into many consecutive lines**. Reloading the page, or reconnecting after a longer outage, shows the same thing.

### What a full-screen TUI actually writes to the PTY

Captured from claude 2.1.270 on a pty (100×30, `TERM=xterm-256color`, the same as the agent sets for sessions):

| Observation | Value | Meaning |
|---|---|---|
| `ESC[?1049h` (enter alternate screen) | **Exactly once**, in the first 20 bytes after start | Once total output exceeds `ring_bytes`, the switch is never in the buffer window again |
| LF (`0x0a`) | **0** | It never "prints", it only paints |
| Steady-state frame | ~40 B: `ESC[?25l` `ESC[H` `CR` `ESC[23B` one character `ESC[30;1H` `ESC[27;3H` `ESC[?25h` | Pure diff with **absolute row positioning**; assumes the previous frame is on screen |
| After SIGWINCH | `ESC[?1000h…` + **`ESC[2J` `ESC[H`** + full screen ≈ **1.2 KB** | The only self-contained full redraw; **`?1049h` is not resent** |
| Same-size `TIOCSWINSZ` | 43 B (the kernel sends no SIGWINCH) | Forcing a redraw requires an actual size change |
| Rate during a conversation | 0.5–0.8 KB/s (tool output extra) | A 1 MiB ring buffer wraps every few to tens of minutes in an active session |

vim, less, htop and codex are the same kind of program: alternate screen, absolute positioning, differential redraws, a full redraw only on SIGWINCH.

### Why the byte-window model must fail

The ring buffer keeps a **window of the byte stream**. For streams like the above, bytes out of context are meaningless:

1. **One-shot mode switches get trimmed.** `ESC[?1049h` appears once. `ringbuf.Slice` cuts the window by bytes, and once the window slides past it, a reset replay paints the alternate screen's diff stream onto the main screen.
2. **Diff frames aren't self-contained.** The replay start almost never lands on one of the program's full redraws, so patches are applied to the wrong base, and it **doesn't heal**: the next full redraw waits for a SIGWINCH.
3. **Replay size ≠ production size.** A background session's PTY doesn't follow layout changes. On switch-back, `activate()` first `fit()`s xterm to the new size, then `subscribe` immediately pours in backlog laid out for the old size, while `resize` has a 100 ms trailing debounce, so the PTY finds out last.

Reproduced with the real bytes in real xterm.js (replaying the same capture minus the leading `?1049h`):

```
terminal 100×30 (same as the PTY) → 0 lines of scrollback, no duplicates, just stale content
terminal  45×24 (narrower)        → 10 extra lines of scrollback, the same content 4 times
```

In the narrow terminal, over-wide box lines wrap at the bottom of the screen and push content into scrollback, **leaving a ghost per frame**. That is the "many logos" and the "status line turned into many lines".

### Implementation gaps found along the way

Not decisions of this ADR, but fixed in the same batch:

- `Session.Subscribe` **never sent** the `reset` control message when it decided on a reset (protocol §4.2 defined it, and nothing in the repo sent it). The `attrPrefix` branch in the client's `connection.ts` neither cleared the screen nor deduplicated, so every switch-back **appended** the whole ring buffer again.
- `Connection.subscribe()` didn't set `catchupTo`, so the backlog filled in on switch-back didn't count as replay; xterm answered historical DSR/DA queries again and sent the answers to the PTY as user input.
- A comment in `web/src/term/interactive.ts` classified claude / codex as "redraw in place on the main screen, no alternate buffer", which no longer held for 2.x.

## Decision

Refine the resume model by splitting session output in two. The main screen is an **append stream**: the bytes are the truth, and replaying them is correct. The alternate screen is **state**: historical bytes are worthless, and replay must deliver the current screen. Unchanged: `out_seq` accounting ([CLAUDE.md](../../../CLAUDE.md) invariant 4), incremental resume (`resumed[].status == "ok"`), and [ADR-0006](0006-agent-side-osc-parsing.md)'s OSC stripping. No full terminal emulator.

### 1. The agent tracks sticky terminal modes per session

A CSI/ESC **observer** sits after OSC stripping and before `ring.Append`. It only reads and changes no bytes, so [ADR-0006](0006-agent-side-osc-parsing.md)'s `out_seq` invariant holds.

Tracked modes ("sticky" = set once, effective for a long time, gone for good once trimmed):

| Sequence | Meaning | Restore |
|---|---|---|
| `?1049` | Alternate screen | ✅ Must be first |
| `?1` | DECCKM application cursor keys | ✅ |
| `?7` | Autowrap | ✅ (only if turned off) |
| `?25` | Cursor visible | ✅ |
| `?1000/1002/1003/1006/1015` | Mouse tracking and encodings | ✅ |
| `?2004` | Bracketed paste | ✅ |
| `?1004` | Focus reporting | ✅ |
| `CSI > flags u` / `CSI < u` | Kitty keyboard protocol stack | ✅ Restore the top of the stack |
| `CSI > n ; m m` | modifyOtherKeys | ✅ |
| `CSI t ; b r` | DECSTBM scroll region | ✅ |
| `?2026` | Synchronized output | ❌ **Never restore**: it wraps a single frame, and restoring it as "on" would stall the client's renderer |
| SGR / character sets | Colors, G0 | ❌ Not tracked; the prefix always sends `ESC[0m` `ESC(B` for a clean base, and the program repaints the content itself |

This state **must go into the [`internal/handoff`](0016-hot-reexec.md) session snapshot**. It can't be re-derived from the ring buffer (that's the whole reason for this ADR), so losing it in a hot upgrade means losing the alternate-screen state.

### 2. Reset splits by screen

The incremental path is untouched. The split happens only **at the moment of a reset**:

```
out_seq ∈ [base, head]  → status "ok"     incremental resume (unchanged, byte-level continuity as before)
out_seq <  base_seq     → session on the main screen      → existing reset replay (ESC[0m + window contents)
                        → session on the alternate screen → redraw (this ADR)
```

The alternate screen has no scrollback, so those historical bytes are worth **nothing** to the user. Dropping them isn't lossy; it removes noise.

### 3. Force a redraw with SIGWINCH, after aligning the size

`subscribe` carries `cols` / `rows`, and the agent **applies the size before choosing between replay and redraw**. That closes off "bytes laid out for the old size poured into a terminal of the new size" in one step.

- The client's size differs from the PTY's → `TIOCSWINSZ` directly; the natural SIGWINCH is the redraw request (measured at 1.2 KB).
- Same size → **jiggle**: `rows-1`, wait 80 ms, set it back. Rows rather than cols, because changing the width reflows xterm's main-screen scrollback.

The jiggle needs the gap; measured:

| Approach | Program output | Full redraw |
|---|---|---|
| Two `ioctl`s back to back | 43 B | ❌ The SIGWINCHes coalesce; the program sees no size change |
| 80 ms apart | 2509 B | ✅ Two redraws |
| One real size change | 1174 B | ✅ One redraw |

The jiggle path draws twice (~2.5 KB), and the frame in between is laid out one row short, so it flickers. Still two orders of magnitude cheaper than replaying 1 MiB.

**The order can't be reversed**: under the lock, take `seq = head_seq` and enqueue `redraw` first, **then** trigger the redraw. Reversed, the redraw's bytes would enter the ring buffer before `seq` and be skipped; the client would never get that screen and would fall through to §6's fallback for nothing.

### 4. Protocol additions

A new agent → client control message (`websocket-protocol.md` §4.2):

```json
{ "t": "redraw", "sid": 1, "seq": 991337, "modes": "<ESC>[0m<ESC>(B<ESC>[?1049h<ESC>[?1h<ESC>[?1000h<ESC>[?1006h<ESC>[?2004h" }
```

(`<ESC>` is `\u001b` on the wire; ordinary JSON string escaping, no base64.)

- `seq`: the client **jumps** the session's `out_seq` straight here (= `head_seq` when sent). The skipped bytes are dropped on purpose.
- `modes`: ASCII escape sequences the agent generates from §1's table. Only mode switches the agent composed itself, **never any program output**. A few dozen bytes.
- `modes` bytes **don't count toward `out_seq`**, the same rule as `ATTR_PREFIX` (protocol §3; added to the exceptions to CLAUDE.md invariant 4).
- **Ordering guarantee**: `redraw` and the OUTPUT frames after it go through the same ordered write queue, and setting the subscriber's start to `seq` happens under the same lock, the same discipline `Session.Subscribe` already followed.

No new `resumed[].status` value: the reconnect path still reports `"reset"`, followed by a `redraw`. The protocol's only **explicit** forward-compatibility promise is "ignore unknown `t`", and relying on it is the safest way to degrade (old frontends behave as before and don't crash). A client that understands `redraw` withdraws the "history truncated" notice that `reset` shows: the alternate screen has no history, so the notice would mislead.

`subscribe` gains two fields:

```json
{ "t": "subscribe", "sid": 1, "out_seq": 483920, "cols": 90, "rows": 30 }
```

When they're absent (old clients), the agent keeps the session's current size, as before.

### 5. Client behavior

On `redraw`: (1) clear the output write queue and resume following; (2) `terminal.reset()`; (3) write `modes`; (4) `outSeq = catchupTo = seq`; (5) treat what follows as ordinary live frames. The first live frames are the program's own full redraw.

Session switching changes order too: in `select()`, **`resize` comes before `subscribe`**, without the 100 ms debounce (the debounce is for continuous drags; a session switch is a single event). Since the size travels to the agent with `subscribe`, the local step is just `fit()`.

### 6. Fallback: replay bytes if the program doesn't redraw

Betting that the program responds to SIGWINCH is risky: if it doesn't redraw, the client stares at a cleared, blank screen.

After requesting the redraw, the agent starts a **300 ms timer**. The test is **whether `head_seq` has moved past `redraw.seq`** (not "did this session produce any output"). If not, the program isn't redrawing, so send the window contents under the **existing reset rules** (`ESC[0m` prefix + `flags` bit 0). The worst case is pinned at "no worse than before".

### 7. Not doing

- **No full VT screen model.** Running a headless terminal on the server, with replay = serialize the current screen, is the complete solution (what tmux and mosh do). It would also fix the known limitation of hard trimming cutting escape sequences, and the first subscribe pulling 1 MiB. But it brings a new dependency, tens of KB of memory per session, one more parse per byte, and the handoff would have to carry the whole screen state. **Recorded as a v0.2 candidate, to be decided after seeing how this ADR works out.** (ADR-0026 did it.)
- **Main-screen in-place redrawers stay as they are** (progress bars, older claude versions, scripts refreshing with `\r`). Their output is an append stream, so replaying bytes is the right model; misalignment after width changes is an accepted limitation in the [ring buffer doc](../../50-backend/ring-buffer.md).
- **Incremental resume doesn't change.** Not one byte of the `status == "ok"` path changes; AC-2.1 is unaffected.

## Consequences

- **History is dropped (accepted).** Switching back to an alternate-screen session no longer fills in the bytes from while you were away. This contradicted AC-2.11 ("switch-back fills in via resume, no output lost"), so **AC-2.11 was reworded**: for alternate-screen sessions it delivers the current screen, not historical bytes. The alternate screen has no scrollback, so the user couldn't have scrolled back to those bytes anyway.
- **Two extra redraws** when the size hasn't changed (~2.5 KB). Acceptable.
- **The agent learns a little terminal semantics.** [ADR-0003](0003-no-tmux.md) has the agent own the PTY without emulating a terminal; this ADR teaches it about a dozen mode switches. That's remembering switch states, not emulating the screen. The line is drawn here: **once we start tracking the cursor position or cell contents, it's time for §7's full VT.**
- **The jiggle depends on timing.** 80 ms is a heuristic; programs that don't respond to SIGWINCH are covered by §6.
- **One more protocol message**, `redraw`, which degrades via "ignore unknown `t`".
- New acceptance criteria: **AC-2.16** (with an alternate-screen program running, switch away until the backlog exceeds `ring_bytes`, then switch back: the terminal shows the program's **current** full screen, and scrollback contains no copies of its UI); **AC-2.17** (that switch-back transfers < 8 KiB, instead of the whole `ring_bytes`); **AC-2.18** (if the program doesn't redraw within 300 ms, fall back to the existing reset replay, with no blank screen); **AC-2.19** (the observer is read-only, bytes identical before and after; its state goes into the hot-upgrade snapshot; `?2026` is never restored).
- Tests: unit tests for the observer (arbitrary splits, malformed sequences, DECRST, `?2026` never restored, **output bytes identical to input**) and for deterministic `redraw.modes` excluded from `out_seq`; integration tests for the reset split (alternate screen → `redraw` and no window push; main screen → unchanged) and the jiggle (different size → one resize; same size → `rows-1`, 80 ms, restore; no output within 300 ms → fallback); a handoff test that alternate-screen state survives, in addition to `TestHandoffByteLevelContinuity`; byte-level continuity (AC-2.1) on the untouched incremental path as the regression red line; E2E with a `--ring-bytes 65536` instance, asserting the program's UI appears exactly once in the serialized terminal.
- Code: `internal/session` (observer, split, jiggle, fallback timer), `internal/protocol` (`redraw`, `subscribe` fields, `testdata/vectors.json`), `internal/handoff` (snapshot fields), `web/src/conn/connection.ts` (`redraw` handling, `catchupTo`), `web/src/sessions/store.ts` and `web/src/ui/app.tsx` (resize before subscribe, withdraw the "truncated" notice).
