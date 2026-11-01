# ADR-0041 Tabs carry the session number, as in the drawer; the text page button becomes a line icon

Status: Accepted (2026-10-31). Extends [ADR-0031](0031-tabs-equal-width.md) (tab content) and [ADR-0037](0037-settings-theme-and-font-size.md) §3 (icon style).

## Context

After trying the UI, the user raised two points:

1. **Tabs with the same name can't be told apart on `wide`.** The automatic name is the CWD's basename, so several sessions opened in the same directory (typically one running claude, one building, one tailing logs) all show the same name and can only be told apart by position. The phone's session drawer prefixes each row with its number `[n]`, so same-named sessions are distinguishable there; tabs had no number.
2. **The ✎ in the extra keys' left column looks flimsy.** It's a Unicode character; at 18px its strokes are about 1px, right below the session button's rounded square with its 2px border, so it looks weightless. Its glyph also varies with the platform font (ADR-0037 §3 replaced ⚙ with an SVG for exactly this reason and missed ✎).

## Decision

### 1. Every tab name is prefixed with `[n]`, as in the drawer

- `[n]` is the same number as in the drawer: the position in the current display order, starting at 1, updated by drag reordering and by closing a session in the middle ([ADR-0040](0040-session-order-drag.md)).
- **Renamed sessions get it too.** Both forms show the same numbering, so "number 3" on the phone is still number 3 on the big screen; with the number always present, a tab's content and width don't jump when it's renamed.
- Styled as in the drawer: monospace, `--muted`, not bold; in the current tab it takes the accent color. The number is never truncated; an overlong name is truncated instead.

### 2. The text page button is drawn as "a pencil coming out of a rounded square"

- Inline SVG, 22×22, 2px stroke, the same size and weight as the session button's square above it (22px, 2px border, rounded), so the two buttons in the left column look like a set.
- The drawing: a rounded square with its top-right corner open, and a pencil running diagonally from the middle of the square out through the gap. A pencil is the common symbol for "edit", and the square echoes the session button.
- Otherwise as ADR-0037 §3: stroke only, `currentColor`, round caps and joins. Color follows the button: `--fg` normally, the accent color while the text page is open (`aria-pressed=true`).
- One size larger than the top bar's 14px / 1.75px icons: top bar buttons are 36px tall, while this one is 44×40 and sits next to the session count square; a 14px icon here would be noticeably smaller than its neighbor.

### Rejected alternatives

- **No number on renamed tabs.** That was the first version (the rename already distinguishes them, so the number is noise). After seeing it, the user asked for consistency with the phone and an always-visible number: matching numbers across forms matter more, and a number that comes and goes makes people think twice.
- **Number only same-named tabs.** The number would come and go, and a tab would suddenly grow or shrink because another session changed directory, shifting widths and positions.
- **A keyboard icon** ("typing"). The text page is mainly for writing a paragraph and sending it (prompts for claude), which a pencil fits better; a keyboard icon also reads as "show the on-screen keyboard".

## Consequences

- AC-4.10: tab content adds "the tab name is prefixed with `[n]`, as in the drawer".
- session-ux.md (`wide`), input.md, and layout.md (icons) are updated to match.
- E2E-41 ④'s rename step asserts `tab-<sid>-idx` is `[n]` before and after renaming; E2E-45 ① checks numbers follow the new order after dragging.
