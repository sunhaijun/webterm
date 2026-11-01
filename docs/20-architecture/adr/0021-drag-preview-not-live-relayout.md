# ADR-0021 Drag gestures only preview; layout changes wait for release

Status: Accepted (2026-09-13). Its subject, the desktop sidebar, was removed by [ADR-0025](0025-termux-style-ui.md); the principle "a drag only previews, the layout changes on release" carries over to ADR-0025's pinch to change font size.

## Context

The user reported that dragging was janky in desktop browsers but not on phones. Measured, the issue wasn't "desktop is slow". **The only drag on desktop happened to be the most expensive kind of change in the layout**: dragging the sidebar splitter changes the terminal's geometry every frame. Every drag on mobile moves an overlay ([ADR-0018](0018-one-drawer-primitive.md) §4) and never touches the terminal.

Real binary + Chromium, a 120-step drag (2 px per step, 8 ms between steps):

| Per pointer move | Sidebar splitter (1440×900) | Sheet grabber (390×844) |
|---|---|---|
| Style recalc | 1.6 ms | 0.21 ms |
| Layout | 0.68 ms | 0.21 ms |
| JS (including re-rendering the whole App) | 0.4 ms | 0.6 ms |
| Janky frames (> 25 ms) | 116 / 243 | **0 / 322** |

A microbenchmark bypassing Preact (one change, then forced style recalc and layout, no paint; ms per change):

```
① no-op (floor)                                0.002
② change a CSS variable NOBODY uses            1.363   ← the cost isn't changing the column width,
③ change --sidebar-w (the original approach)   1.14       it's dirtying the whole subtree from the root
④ set grid-template-columns directly           0.542
⑤ resize an overlay (like the sheet)           0.095
```

Three findings:

1. **JS isn't the bottleneck.** Re-rendering the whole `App` costs 0.4 ms per frame, and Chrome coalesces `pointermove` to once per frame. Batching with rAF or memoizing components can't fix this.
2. **Half the cost is "writing the width as a CSS variable on the root".** ② costing more than ④ shows the cost comes from Chromium's invalidation strategy for custom properties (changing one on `.app` dirties the styles of the whole subtree), whether or not anyone reads the variable.
3. **The other half is terminal relayout and repaint.** With `.term` set to `visibility: hidden` (still laid out, just not painted), the same drag dropped from 116 janky frames to 70.

The test machine has no GPU (headless + SwiftShader software rasterization), so **janky-frame counts are more pessimistic than on real devices**: in the same window even a pure `transform` animation manages only 30 fps. The main-thread milliseconds transfer to real devices; frame counts are only for comparisons on the same machine.

## Decision

1. **Continuous drag gestures may only change properties the compositor handles on its own (`transform` / `opacity`) per frame. Real layout changes wait until the gesture ends.** For the sidebar splitter:

   | Moment | Before | Now |
   |---|---|---|
   | `pointermove` | `setSidebarW()` → write `--sidebar-w` → grid columns change → terminal relayout and repaint | Only write a `transform: translateX()` on `.sidebar-resizer` |
   | `pointerup` | Settle the width | Settle the width (unchanged), clear the `transform` |

2. **The preview position equals the release result.** Both use one pure function, `settleSidebarWidth()`: clamping, snapping back to 240 and collapsing past the threshold are **all visible during the drag**. Before, they only showed after release (drag to the far left and the width stuck at 200, with no hint that releasing would collapse it). This is a testable invariant: the preview position matches the boundary after release (UT-sidebar-1, E2E-32).
3. **No Preact state during the drag.** Calling `setSidebarW` every frame re-rendered the whole `App`. That took only 0.4 ms, but it was the source of a guaranteed layout-property change per frame. Writing the `transform` of that **one** element directly means zero re-renders during the drag (one on press and one on release, for `data-sidebar-drag`).
4. **The principle applies to all drag gestures, but paths that are already cheap needn't be rewritten.** The write sheet grabber changes `.bottom`'s `height` per frame (0.095 ms), and `.bottom` is absolutely positioned inside the fixed-height `.bottom-slot`, so changing it never touches terminal geometry. It already meets the substance of the rule (no terminal relayout) and stays as is. **New gestures follow this ADR.**

Rejected alternatives:

- **Only replace `--sidebar-w` with a direct `grid-template-columns`** (1.14 → 0.54 ms). Saves half the main-thread time, but the terminal still relayouts and repaints every frame, so the other half of the jank remains. Half a fix is harder to explain.
- **`contain` on `.canvas` / `.sidebar` to shrink the repaint area.** Useful, but it lightens "relayout every frame" instead of not doing it. Relayout once after the drag is negligible; it doesn't need to happen every frame at all. This optimization can be done separately later and doesn't conflict with this ADR.
- **Update less often during the drag (every 2 frames).** Trades jank for lag; neither follows the finger.

## Consequences

- **The sidebar content no longer widens live during the drag**; you see a drop line (the whole column highlighted) in exchange for compositor-level tracking. To be clear, the old "live" behavior only reached the CSS layer anyway: during a drag `ResizeObserver` was short-circuited, cols / rows weren't recomputed, and the canvas was clipped or padded until release (the first hard constraint in [layout.md](../../40-frontend/layout.md) §desktop). What's lost is the sidebar list narrowing live, not terminal liveness; the terminal was never live.
- **Dragging out from the collapsed state no longer expands the sidebar before release.** It used to expand first and settle on release; now it's uniformly "preview line → land on release". One fewer special case.
- Keyboard steps (`←` / `→` / `Home` / `End`) **still change the width immediately**: discrete, one step at a time, no per-frame budget, so a preview would be redundant.
- Docs and tests: AC-5.12 rewritten in [acceptance-criteria.md](../../10-requirements/acceptance-criteria.md); a third hard constraint for "sidebar width can be dragged and collapsed" in [layout.md](../../40-frontend/layout.md); E2E-32 in [e2e-scenarios.md](../../70-testing/e2e-scenarios.md) asserts that `.sidebar`'s width **doesn't change** during the drag, the splitter follows the pointer visually, and the width lands at the preview position on release. Code: `previewEdge()` in `web/src/ui/sidebar.ts`, the three pointer callbacks in `web/src/ui/app.tsx`, `.sidebar-resizer` in `web/src/style.css` (whole-column highlight + `will-change`).
- Protocol, reconnect, connection layer and session state untouched. Terminal geometry doesn't change during the drag at all, so the old assertion "a drag sends exactly one `resize`" is stronger than before.
