# ADR-0033 Compute terminal rows and columns ourselves instead of using FitAddon

Status: Accepted (2026-10-31). Rewrites AC-3.11. When sizing runs (only when `ResizeObserver` sees the container size change), the 100ms debounce on `resize`, and the agent resending a snapshot when columns change are unchanged.

## Context

Switching E2E-42 to change columns by narrowing the window exposed a bug: in a 900px-wide window, **changing only the height made the column count flip between 104 and 103**.

The cause is xterm 5.5's DOM renderer (`DomRenderer._updateDimensions`):

```
css.canvas.width = Math.round(device.canvas.width / dpr)    // round the whole row width first
css.cell.width   = css.canvas.width / cols                   // then divide by the *current* column count
```

FitAddon divides the available width by `css.cell.width`, which depends on the current column count:

| Current cols | `css.cell.width` | Columns that fit in 877px |
|---|---|---|
| 104 | 877 / 104 = 8.4327 | 103.99… → **103** |
| 103 | 868 / 103 = 8.4272 | 104.07 → **104** |

The glyph is actually 8.4287px wide, so 877px really fits 104 columns. But at this width every `fit()` returns the opposite of the previous one. Row height (`css.cell.height`) uses the same arithmetic, so when `dpr` isn't an integer (true on many phones) the row count flips at certain heights as well.

The effect: opening the on-screen keyboard changes only the height, but if the width happens to sit on a flip point, the column count changes too. The agent sees new columns and resends a snapshot, redrawing the whole screen (AC-2.22). The bug was already on main; E2E used a 1280px width, which isn't a flip point.

## Decision

**Rows and columns = available size ÷ a stable cell size, rounded down.** The cell size is `dimensions.device.cell.width / dpr` and `dimensions.device.cell.height / dpr`, which come from measuring glyphs and don't depend on the current rows and columns.

- The available size is computed as FitAddon does: the parent's width and height, minus the `.xterm` padding, and minus the scrollbar width for the width. Minimum 2 columns and 1 row.
- `resize` only when rows or columns change.
- The implementation is a small function in `term/terminal.ts`. The pure part, `proposeSize`, is unit-testable; the DOM-reading part, like FitAddon, reads an xterm internal (`_core._renderService.dimensions`). `@xterm/addon-fit` is no longer a dependency.

### Rejected alternatives

- **Keep FitAddon and add hysteresis** (e.g. ignore a one-column change when the width didn't change). That suppresses the symptom, and also blocks real one-column changes.
- **Patch xterm.** Worth upstreaming, but we can't wait for a release.

## Consequences

- Near a flip point, the canvas width (`cols × glyph width`, rounded) can exceed the available width by less than half a pixel. `.term` has 4px of padding, so it's invisible.
- AC-3.11 adds "rows and columns are stable while the container size is unchanged, and a height-only change doesn't change the columns"; adds UT-fit-1; E2E-42 adds ⑤: for window widths from 860 to 940px in 4px steps, change only the height once, and the column count must not change.
