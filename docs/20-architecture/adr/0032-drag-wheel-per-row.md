# ADR-0032 Touch drag to wheel: drop calibration, one wheel event per row of finger movement

Status: Accepted (2026-10-31). **Revises [ADR-0029](0029-touch-drag-to-wheel.md) §1 (auto-calibration)**; rewrites AC-3.21. When the conversion applies (mouse tracking on, at least 10px of movement, vertical dominant), direction, dispatch (a synthetic `WheelEvent` handed to xterm), throttling (at most 3 events per `touchmove`) and `preventDefault` are unchanged.

## Context

To track the finger, ADR-0029 sent one wheel event at the start of each drag, waited for the program to redraw, measured how many lines the screen moved, and from then on sent one event per "step × row height" of finger movement.

After trying it, the user found scrolling far too slow and asked to drop the finger tracking and see what plain behavior is like.

It was slow in two ways:

- **Slow to start**: calibration waits for a network round trip (up to 300ms) while the finger moves and the screen doesn't. In tmux, the first event only enters copy-mode and measures nothing, so it waits for a second round trip.
- **Slow to move**: tracking means one row of finger movement moves content by one row. Paging through long output on a phone, one screen of swipe moves only one screen of content.

## Decision

**Send one wheel event for every row height the finger moves.** No calibration, no remembered step.

- The program decides how many lines each event scrolls. In tmux copy-mode it's 5, so content moves 5 times as fast as the finger; a program with a step of 1 tracks the finger line by line. This is what Termux does.
- Events start as soon as the drag is recognized, without waiting for any round trip.
- Throttling is unchanged: at most 3 events per `touchmove`; the excess is dropped, not carried over to the next frame.

### Rejected alternatives

- **Keep calibration, just wait less.** The wait is a network round trip plus a redraw; the client can't shorten it.
- **Assume a fixed 3 lines per event.** It's still a guess at the step, still wrong when the guess is wrong, and slower than one event per row.

## Consequences

- ADR-0029 §1 and its measurement table no longer hold. With tmux's default config, a 10-row drag scrolls tmux about 50 lines. For line-by-line scrolling, change the copy-mode wheel binding to `-N 1` as in ADR-0029 §3.
- The code drops `detectShift`, the calibration state and the remembered step; `DragWheel` only accumulates by row height.
- AC-3.21, E2E-44, UT-touch-1 and the tmux item in the manual checklist are rewritten for "one event per row".
