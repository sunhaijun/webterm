# ADR-0039 Phone session list: swipe a row left for actions; rename in a small sheet; overlays follow the visual viewport

Status: Accepted (2026-10-31). Revises the `compact` parts of [ADR-0025](0025-termux-style-ui.md) §4 and of the session menu in [session-ux.md](../../40-frontend/session-ux.md): the drawer no longer pops up an anchored session menu. The `wide` tab menu is unchanged.

## Context

The user asked for session actions such as renaming to be reached by swiping a row left on narrow screens, and pointed out that the rename field got covered while editing, asking for something simpler and more reliable.

How it worked:

- Long-pressing a row in the phone drawer opened a small menu anchored next to the finger (Rename · Pin · Close). "Rename" turned that row's name into an input in place.
- As soon as the input got focus the on-screen keyboard opened. The drawer is `position: fixed` against the bottom of the **layout viewport**. Android Chrome only shrinks the **visual viewport** for the keyboard (`resizes-visual`), so the drawer didn't move and its lower half, input included, ended up behind the keyboard. iOS sometimes pushes the page up (`offsetTop > 0`); then `.app` gets a `translateY` and the drawer follows it, but when it doesn't push, it's covered just like on Android. The drawer's `max-height: 80vh` was also computed against the layout viewport, so with the keyboard up it was taller than the visible area.
- An input inside a row had to coexist with list scrolling, row taps and long-presses, and blur-to-cancel: several code paths.

## Decision

### 1. Swipe a row left to reveal three buttons

```
┌─────────────────────────────────────┐
│ [1] webterm     ~/github/webterm    │
│ [2] api   • ~/srv/a │ Pin │Rename│Close│  ← revealed by swiping left; 72px each, full row height
│ [3] build       exit 1              │
└─────────────────────────────────────┘
```

- From right to left: **Close** (`--err` background, white text), **Rename** (`--accent` background, white text), **Pin** (`--line-strong` background; reads "Unpin" when on). testids `row-close`, `row-rename`, `row-pin`, inside the row.
- **Gesture**: take over once horizontal movement exceeds 10px and dominates; the row follows the finger (0 to −216px). On release, stay open if past halfway, otherwise spring back. Swipe an open row right to close it. Vertical swipes scroll the list as usual (rows have `touch-action: pan-y`).
- **Long-pressing a row opens its buttons**, the same result as swiping. The drawer no longer pops an anchored menu: one UI, two gestures.
- **Only one row open at a time**: opening another row, tapping elsewhere in the list, or tapping the open row's body closes it. Tapping the body **only closes, it doesn't switch**, so trying to close the buttons doesn't accidentally switch sessions.
- After a button is tapped, the row closes first, then acts: Pin toggles in place; Rename opens the rename sheet (§2); Close goes through close confirmation ([ADR-0038](0038-close-confirm-sheet.md)), stacked on the drawer if the session is running.

Why a hidden gesture is acceptable on phones: swipe-left-for-actions is a common pattern (iOS Mail, WeChat), so users try it, and long-press opens the same buttons. On PCs and tablets, the tab bar still uses right-click / long-press for a menu, plus double-click to rename.

### 2. Rename in a small sheet, not in place in the row

```
┌─────────────── ═══ ───────────────┐
│ Rename                          ✕ │
├───────────────────────────────────┤
│ ┌───────────────────────────────┐ │
│ │ webterm                       │ │  ← all selected on open, keyboard up
│ └───────────────────────────────┘ │
├───────────────────────────────────┤
│  ┌─────────────┐ ┌─────────────┐  │
│  │   Cancel    │ │    Save     │  │
│  └─────────────┘ └─────────────┘  │
└───────────────────────────────────┘
```

- A `Drawer` with `data-testid="rename-sheet"`, stacked on the session drawer; the input keeps `rename-input`, buttons are `rename-cancel` and `rename-ok`.
- The input is full width with a 16px font (iOS zooms the page when focusing inputs under 16px). The placeholder says that leaving it blank uses the directory name.
- `Enter` or "Save" confirms; blank restores the automatic directory-based name. `Esc`, ✕, tapping the backdrop, swiping down and "Cancel" all cancel. **Blur no longer cancels**: the keyboard's "Done" or a tap on empty space in the sheet shouldn't throw away a half-edited name.
- On `wide`, tabs still rename in place on double-click (the tab bar is at the top of the screen and never under the keyboard).

### 3. Overlays follow the visual viewport

- **`.app` becomes the containing block for its `position: fixed` descendants** (`contain: layout`). `.app`'s height already follows `visualViewport`, and it `translateY`s to keep up when the keyboard opens ([layout.md, Height](../../40-frontend/layout.md#height-ac-38)). An overlay backdrop with `inset: 0` then covers exactly the visible area, and a sheet's bottom edge is the top of the keyboard.
- Sheet heights are percentages of the backdrop: at most 80%, the session drawer at least 50%. No more `vh`.
- The bottom safe area uses `--sa-bottom` on `.app` rather than `env()` directly: with the keyboard up it's set to 0, since the keyboard already covers the home indicator.

§3 alone keeps the rename sheet visible: it sits on top of the keyboard, with the input at the top of the sheet.

### Rejected alternatives

- **Keep in-place rename and scroll the input into view on focus.** The visual viewport keeps changing while the keyboard animates, so scrolling has to wait for it to settle; and an input inside a row still has to be separated from taps, long-presses and list scrolling.
- **Rename with `prompt()`.** Like `confirm()`, it doesn't match the rest of the UI (ADR-0038's reasons).
- **Put only Close behind the swipe**, keeping Rename and Pin in the long-press menu. The user wanted rename reachable by swiping; one UI per row is simplest.
- **Also reveal buttons on a right swipe** (e.g. right swipe toggles Pin). Two directions with different meanings to remember, and accidental triggers cost more.

## Consequences

- The drawer no longer uses `SessionMenu` or in-place rename; `SessionList` no longer takes `onMenu` or `renaming`.
- Adds AC-4.12; E2E-28 ⑥ becomes swipe left, long-press, rename sheet, pin and close; the manual checklist gets two items: on a real device the rename sheet sits above the keyboard, and swiping left and scrolling vertically don't interfere.
- `swipe.ts` swipe-down-to-close only takes over when vertical movement dominates, so swiping a row left doesn't drag the whole sheet down.
