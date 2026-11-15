# ADR-0067 Swipe sideways on the terminal to switch sessions

Status: Accepted (2026-11-15). Revises [ADR-0025](0025-termux-style-ui.md) §5 ("Horizontal drag: nothing"). Adds AC-4.15 and E2E-58. Neither the HTTP API nor the protocol changes.

## Context

On a phone, going to the next session takes two taps: the session button, then a row in the drawer. Flipping between two or three sessions (claude in one, a shell in another) is the common case, and the user asked whether the terminal could switch with a swipe.

webterm had this once (AC-4.7), and ADR-0025 removed it in the Termux redesign, not for a bug but to cut concepts. Since then horizontal drags on the terminal have done nothing, so the gesture is free. The drawer and the tabs stay the main way: they are visible and show every session. The swipe is only a shortcut to the neighbours.

The user's condition was that it be **safe** (never switch when you meant to scroll, tap or type, and never fight the system) and **feel right** (follow the finger, show where you are going, settle like a native page swipe).

Single-finger gestures already on the terminal: tap (keyboard, links, a click under mouse tracking), vertical drag (scrollback, or wheel events under mouse tracking, [ADR-0029](0029-touch-drag-to-wheel.md)), and, while the extra keys are collapsed, a swipe left along the bottom 80px to restore them ([ADR-0056](0056-collapsible-extra-keys.md) §3). Screen edges belong to the system: Android's Back, Safari's Back and Forward.

## Decision

### 1. Which touches can become a swipe

- **One finger, on the terminal**, on touch devices, in both forms. Mouse drags stay text selection.
- **Not from an edge**: the touch must start at least 24px from both screen edges, the same rule as the restore swipe.
- **Not in the restore band**: while the extra keys are collapsed, a touch that starts in the bottom 80px belongs to the restore swipe.
- **Decided once, at 10px of travel** (the tap threshold): it is a swipe only if the travel so far is clearly horizontal, `|dx| ≥ 2·|dy|` (within about 27° of horizontal). Otherwise it is not a swipe for the rest of that touch, and the vertical drag rules apply as before. A scroll can't turn into a switch halfway.
- **A second finger cancels** the swipe (it slides back), leaving two-finger gestures free.

### 2. While swiping

- **The terminal follows the finger** one to one, counted from where the swipe was recognized, so it doesn't jump 10px when it starts. It moves with a `transform` only: no `fit()`, no `resize`.
- **The page is seen moving**: while it moves, the terminal shows a line at its left and right edges and the gap behind it is dimmed. Terminal and gap would otherwise share one background, and only the text would seem to slide.
- **The gap shows where you are going**: a label in the uncovered strip, vertically centered, with the neighbour's `[n]` index and name and its waiting-for-you dot. It fades in with the travel and turns the accent color once releasing would switch.
- **Finger left = next session, finger right = previous**, in the order of the tabs and the drawer: the next one is the tab to the right, the row below. **No wrapping**: with no session on that side the terminal moves with resistance (iOS's rubber band, `(1 − 1 / (0.55·d / W + 1)) · W`), shows no label and always slides back.
- **Nothing reaches the program or xterm** once a touch is a swipe: its moves and its release stop at the terminal container, so no scrolling, no wheel events, no mouse reports, no keyboard toggle, and no synthesized click.

### 3. Releasing

- **It switches** when the finger went far enough or flicked:
  - far enough: `|dx|` at least a quarter of the terminal's width, at most 160px (about 98px on a phone), **unless** the finger was heading back at release (at least 0.3 px/ms toward where it started), which is how you change your mind;
  - a flick: `|dx|` at least 40px and at least 0.5 px/ms in the swipe's direction;
  - and in both cases the whole travel is still mostly horizontal (`|dx| > |dy|`).
  
  The speed is measured over the last 100ms of the touch, not the whole of it, so a slow drag ending in a flick counts and a fast drag that stops doesn't. Moves stamped at the same millisecond give no speed.
- **Switching is the drawer's switch**, run in the `touchend` handler: focus follows the session (the keyboard stays up if it was up, which iOS allows only inside the gesture), the text page follows ([ADR-0036](0036-text-page-per-session.md)), open popovers close, and no `resize` is sent. The new terminal comes in from the opposite side (from the right after a swipe left), starting where the old one's edge was (200ms, ease-out).
- **Otherwise it slides back** (180ms).
- A new touch during either animation ends it at once. If the neighbour was closed during the swipe, or the current session changed (closed elsewhere), the release slides back.
- With `prefers-reduced-motion`, nothing moves: the label still appears, and releasing switches at once.

## Alternatives considered

- **Wrap around, like `Ctrl+Shift+↑/↓`**: with the keyboard, the shortcut is pressed on purpose; a swipe that goes from the last session to the first breaks the sense of moving along a row, and with rubber banding at both ends you can feel where the row stops.
- **Show the neighbour's terminal in the gap**: it isn't subscribed while hidden, so its screen is stale until it catches up; showing it would claim to be the live session. Subscribing at the start of every swipe costs bandwidth and can't be taken back if the swipe is cancelled. The name label says enough.
- **Edge swipes** (the old AC-4.7 design): the edges are the system's Back and Forward, which a page can't stop.
- **Swiping on the extra keys**: a swipe right there collapses them, and pages switch vertically ([ADR-0056](0056-collapsible-extra-keys.md)).
- **A looser angle (45°)**: more forgiving of a thumb's arc, but the first 10px of a vertical scroll are often diagonal; reading scrollback is far more common than switching, and a switch in the middle of reading is the worst mistake this gesture can make.
- **Vibration when passing the threshold**: iOS Safari has no Vibration API, and the label's color already says it.

## Consequences

- `web/src/term/sessionswipe.ts` holds the decisions as pure functions and installs the gesture on the terminal container, in the capture phase so it can keep a swipe's events from xterm and the other gestures. The store gets `adjacent(±1)`, which doesn't wrap.
- The terminal host (`.term-host`) gets the terminal background so it hides the label as it slides over it.
- The store mounts and unmounts hosts at rest (no transform). If a host is detached mid-swipe (its session closed elsewhere), the swipe's `touchend` goes to the detached node and never arrives; nothing is left on the host, and the next touch hides the label.
- Tests: UT-sessionswipe-1 (start, lock, release, follow, speed), UT-store (adjacent), E2E-58. E2E-44's horizontal drag (one session) still sends nothing.
- Real-device feel (thumb arcs, Safari's edge swipes, a PWA) goes in the manual checklist.
