# ADR-0056 Collapsible extra keys, and taps that stay put

Status: Accepted (2026-11-08). Revises [ADR-0025](0025-termux-style-ui.md) §2 (the extra keys are no longer always shown) and §3 (the text page is reached by swiping up, not sideways). Adds AC-3.26 and a fifth thing that changes terminal geometry at runtime.

## Context

On a phone the two rows of extra keys take 80px under the terminal: at 14px that is 4–5 rows, a tenth of the screen. Reading long output from claude, you want them gone; writing, you want them back.

While designing this, the user pointed out a defect in the keys themselves: during a swipe the key under the finger stays highlighted (`:active`), and worse, any drag that isn't a page swipe (vertical, diagonal, or sideways under 40px) **sends the key it started on** when the finger lifts. A new swipe gesture on the keys would press a key every time.

The user's decisions (2026-11-08):

- Collapse with a gesture only, as an exception to "the main way in is a visible button": what comes back is a visible button, so nobody gets stuck.
- Swipe **right** collapses, toward the floating button in the bottom-right corner. Moving between the keys and the text page becomes **vertical** (up to write, down to come back), swapped from Termux's sideways swipe.
- When collapsed, swiping **left** where the keys were brings them back, the same as tapping the button.
- Tablets with touch behave the same as phones.

## Decision

### 1. A tap is a release in place

Every control in the extra keys (the 14 keys, the last column's two, the session button, ✎) acts only when the finger lifts **within 10px of where it went down**, over the same control (the terminal's tap rule, [input.md](../../40-frontend/input.md#tapping-the-terminal-ac-320)).

- The pressed look is `data-pressed`, set on press and dropped as soon as the finger has moved 10px; no `:active`. A swipe never highlights a key and never sends one.
- Long-pressing CTRL / ALT to lock them is unchanged (it already cancels on movement).

### 2. Gestures on the extra keys

| Gesture (travel > 40px, mostly in that direction) | Keys page | Text page |
|---|---|---|
| Right | Collapse | Collapse |
| Up | To the text page | — |
| Down | — | To the keys page, **only when the text box is scrolled to its top** (or doesn't scroll); otherwise it scrolls the text |
| Left | — | — |

✎ still switches pages; it's the visible way. Swiping sideways no longer switches pages.

### 3. Collapsed

- The bar leaves the grid: the terminal takes its 80px, and **one** `resize` follows (the program redraws once; with ADR-0050's rule this device takes the size).
- A **restore button** (`keys-restore`) floats in the bottom-right corner: a 44×44 touch target, 16px from the right edge and above the bottom safe area (and the on-screen keyboard), translucent until pressed, drawn as a keyboard line icon. It carries the waiting-for-you dot when another session has `attention` ([ADR-0052](0052-waiting-for-you-replaces-unread.md)), since the session button is hidden with the bar.
- **Restoring**: tap the button; or swipe left in the **bottom band**, the 80px where the bar was, starting at least 24px from either screen edge (an edge swipe is Android's Back and Safari's Forward, which a page can't stop); or drag the button to the left. The bar comes back on the page it left, with one `resize`.
- Nothing else collapses or restores it: not the on-screen keyboard, not switching sessions, not a reload. The state is per device, kept in `localStorage` like the theme, and isn't a setting.
- Open key menus and the link popover close when it collapses.

### 4. Following the finger

While a horizontal drag is under way, the bar moves with it (`transform: translateX`, no relayout): right to collapse, in from the right edge to restore. Released past 40px it commits, and only then does the layout change; short of that it goes back. ADR-0021's rule: preview while dragging, relayout on release.

### Rejected alternatives

- **Swipe down to collapse.** The user found the swap more natural: the bar slides into the corner where its button waits.
- **Hide while scrolling, show when scrolling stops** (browser-toolbar style). Every scroll would resize the terminal and make claude redraw.
- **Collapse without resizing** (the bar as an overlay). The point is more rows, and the agent's emulator, the PTY and the program must agree on how many there are ([ADR-0026](0026-agent-holds-terminal-state.md) §4).
- **A visible collapse button.** No room in the left column without crowding the session button and ✎; the user accepted a gesture-only collapse because restoring is visible.
- **Restore by an edge swipe.** System gestures own the edges.

## Consequences

- AC-3.18 (the tap rule), AC-3.19 (switching pages vertically), AC-3.26 (collapsing); [input.md](../../40-frontend/input.md#collapsing-the-extra-keys-ac-326); [layout.md](../../40-frontend/layout.md#geometry) (the extra-keys row can be 0, the restore button floats).
- Tests: UT-keygesture-1 (classifying a release: tap, collapse, to text, to keys, nothing), UT-restore-1 (where a restore swipe may start), UT-prefs (the collapsed state), E2E-52 (collapse, restore three ways, one resize each, the dot, persistence, edge starts ignored, tablet), E2E-40 (vertical page switching), E2E-10 (a drag sends nothing and leaves no pressed key).
