# ADR-0029 Touch vertical drag: convert to wheel events when the program tracks the mouse

Status: Accepted (2026-10-31). **Revises the "vertical drag" row of the gesture table in [ADR-0025](0025-termux-style-ui.md) §5**; adds AC-3.21. Main-screen touch scrolling, doing nothing on the alternate screen without mouse tracking ([ADR-0024](0024-scrollback-layered-model.md) §4), and the meaning of a tap are unchanged. 2026-11-07: webterm no longer documents running programs inside tmux; the tmux trap under Consequences is kept as history.

Later: **§1 (auto-calibration) was removed by [ADR-0032](0032-drag-wheel-per-row.md)** because it felt too slow. Now one wheel event is sent per row of finger movement, and the program decides how many lines each one scrolls. §2's conditions, direction, dispatch and throttling are unchanged. The measurement table under Consequences no longer applies.

## Context

ADR-0025 §5 said vertical drag uses xterm's built-in touch scrolling, and "on the alternate screen with mouse tracking, xterm reports per its own rules".

That assumption was wrong. xterm 5.5's touch handlers return immediately when `areMouseEventsActive` (`touchstart` / `touchmove` in `Terminal.ts`). The browser only synthesizes mouse events for a tap; a drag produces neither `mousemove` nor `wheel`.

So as soon as a program enables mouse tracking, a vertical drag on a phone **does nothing at all**. Users run claude / codex inside tmux with `set -g mouse on` in `~/.tmux.conf`, which makes tmux enable mouse tracking; claude enables it too (2.1.316: 1000 / 1002 / 1003 / 1006). Both tmux and claude run on the alternate screen and keep their history to themselves. The web terminal has nothing to scroll, and the only way to scroll is to hand the wheel to them.

[ADR-0024](0024-scrollback-layered-model.md) §4 planned the same mechanism (accumulate by line, synthesize a `WheelEvent` for xterm to encode) but it never shipped, and [ADR-0026](0026-agent-holds-terminal-state.md) superseded it. The UI before m8 couldn't scroll these programs on a phone either.

Measured on 2026-10-31 (Pixel 5 device profile, real tmux with `mouse on`): a 300px vertical drag sent **zero** INPUT frames and tmux stayed out of copy-mode. The same tmux with a desktop mouse wheel: xterm sends `ESC[<64;…M`, tmux enters copy-mode and scrolls back.

## Decision

**When the foreground program has mouse tracking on, webterm converts vertical drags on the terminal into wheel events, and tracks the finger: content moves as many lines as the finger does.**

### 1. Track the finger by auto-calibration

How many lines one wheel event scrolls is up to the program: 5 in tmux copy-mode, 3 in vim (`mousescroll`), and it varies with claude's renderer. webterm can't know in advance, so each drag measures first:

1. When the drag is recognized, send the **first** wheel event and record the screen lines.
2. After each write is parsed (`onWriteParsed`), compare the screen: for non-empty lines that appeared exactly once before, count how far each moved. The offset with the most votes, agreed by at least 2 lines, is the **step**.
3. Until a step is measured (up to 300ms), accumulate the finger's movement without sending, so several wheel events don't overlap and spoil the measurement.
4. Once measured, send one wheel event per "step × row height" of finger movement, subtracting the step already scrolled by the measured event.

**A measurement that sees no movement counts as zero, and the next event measures again.** With tmux `mouse on`, the first wheel only puts the pane into copy-mode (tmux 3.5a's root binding is `copy-mode -e`) and the screen doesn't move; real scrolling starts with the second. A drag measures at most twice; if that still finds nothing (already at the top, or the program doesn't scroll by lines), it continues with the known step without waiting.

The step is remembered on the session's terminal, and the next drag measures again. If it has never been measured, assume 3 lines. If the program changes its step (another tmux pane, a changed `mousescroll` in vim), the next drag picks it up.

### 2. Everything else

- **Direction** matches touch scrolling: dragging the finger down shows earlier content, i.e. wheel up (`deltaY < 0`).
- **Dispatch**: each event is a synthetic `WheelEvent` on xterm's root element with `deltaMode = DOM_DELTA_LINE`, `deltaY = ±1`, and the finger's current coordinates. In xterm's mouse-tracking path one wheel event is one report, and xterm computes the encoding (X10 / SGR / URXVT) and row/column for the program's protocol. tmux uses the coordinates to pick the pane.
- **Throttle** (from ADR-0024 §4): at most 3 events per `touchmove`; the excess is dropped, not carried to the next frame. Browsers coalesce `touchmove` to one per frame, so this is roughly 3 per frame, which keeps a fast flick from flooding the PTY with reports.
- **What counts as a drag**: movement of at least 10px (the same threshold as a tap) with the vertical component dominant. Horizontal drags still do nothing.
- **No second scroll by the browser**: call `preventDefault` on `touchmove` while converting.
- **User input**: the synthetic `wheel` is `window.event` while it's dispatched, and it's in the user-input event list (`userinput.ts`), so it passes the replay gate as usual.

Without mouse tracking nothing changes: on the main screen, xterm's built-in touch scrolling moves through scrollback; on the alternate screen nothing moves, and **no** arrow keys are sent (ADR-0024 §4).

### 3. Limits

- **Not pixel-smooth.** A full-screen program draws frame by frame, so the finest movement is one line; a program with a step of 5 jumps 5 lines at a time, only the average speed matches the finger. To scroll line by line in tmux, make the copy-mode wheel scroll 1 line, and calibration follows:

  ```
  bind -T copy-mode    WheelUpPane   select-pane \; send -X -N 1 scroll-up
  bind -T copy-mode    WheelDownPane select-pane \; send -X -N 1 scroll-down
  bind -T copy-mode-vi WheelUpPane   select-pane \; send -X -N 1 scroll-up
  bind -T copy-mode-vi WheelDownPane select-pane \; send -X -N 1 scroll-down
  ```

  The cost: a desktop wheel notch in tmux also scrolls only 1 line.
- **One network round trip behind.** Every step waits for the program on the server to redraw, so the content trails the finger by one RTT.

### Rejected alternatives

- **Encode wheel reports ourselves.** That means handling three encodings (X10 / SGR / URXVT), three modes (1000 / 1002 / 1003) and the row/column math, all of which xterm already has. Handing it a synthetic `WheelEvent` also keeps us in step if xterm changes encoding details.
- **One wheel event per row of finger movement, as Termux does.** With a program that scrolls N lines per event, content moves N times faster than the finger: one row of drag in tmux scrolls 5 lines, and a single swipe flies far past. (ADR-0032 later chose exactly this.)
- **Assume 3 lines per event** (the common default). tmux's default is 5, still 1.7× too fast, and claude's step changes with its renderer.
- **Measure every wheel event.** Each measurement waits a round trip with no event in flight, so scrolling speed would be capped by network latency (one line per round trip). Once per drag is enough: the program doesn't change mid-drag.
- **Fling (inertial scrolling).** ADR-0026 §7 removed our custom inertia until measurements justify it.
- **ADR-0024 §4's hint ("scrolling went to the program; if you can't type, press Esc or q").** Its trigger is "after a forwarded wheel, the user types and the screen doesn't change for 1.5 s". But in tmux copy-mode keys move the cursor and redraw the screen, so the trigger never fires in tmux, where it's needed most. tmux already shows a `[12/340]` position indicator in the top right while in copy-mode. And the UI no longer carries explanatory text ([ADR-0028](0028-settings-without-notes.md)).

## Consequences

Measured with the Pixel 5 profile and real tmux 3.5a with `mouse on`, after `seq 1 300`, reading copy-mode's `[N/300]`, with 30ms between finger steps:

| | Drag down 10 rows | Two more drags | Drag back 6 rows |
|---|---|---|---|
| tmux default (5 lines per event) | 10 lines (first event enters copy-mode, second measures 5) | 10 lines each | back 5 lines |
| Binding changed to `-N 1` | 10 lines | 10 lines each | back 6 lines |
| For comparison: one event per row (Termux) | 50 lines | | |

- tmux (`mouse on`), claude, htop, `less --mouse` and similar programs can now be scrolled with a finger on phones.
- The tmux copy-mode trap (then in troubleshooting.md, removed 2026-11-07) can now happen on phones too: if the program in the pane doesn't track the mouse, one drag pushes the pane into copy-mode. The way out is still `q` / `Esc`. It's the same thing a desktop wheel does.
- Each drag starts with a calibration: the first wheel event goes out immediately, the second waits for the program to redraw (one round trip, at most 300ms).
- Adds AC-3.21, E2E-44, UT-touch-1, and two manual checklist items (real-device tmux and claude).
