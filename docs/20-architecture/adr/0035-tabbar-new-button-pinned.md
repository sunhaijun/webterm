# ADR-0035 Move the tab bar's `+` out of the scrolling strip: always visible, set apart from tabs, aligned with the status dot

Status: Accepted (2026-10-31). **Revises [ADR-0031](0031-tabs-equal-width.md)'s "`+` follows the last tab" and its Implementation section.** Equal-width tabs, the 120–240px range, horizontal scrolling on overflow and wheel-to-horizontal scrolling are unchanged.

## Context

After trying ADR-0031, the user raised three problems, all with `+`:

1. **With many tabs, `+` disappears.** `+` sat inside the horizontally scrolling tab strip after the last tab. When tabs overflow it scrolls out of view with them, so creating a session means scrolling the strip to the end first. Measured at 600px with 5 sessions: after the current (last) tab is scrolled into view, 36px of `+` is still outside the strip.
2. **`+` sits right next to the current tab's ✕.** The current tab always shows ✕; to its right are only the tab's 4px padding and a 1px divider, then `+`. With 5px between the two buttons, aiming for "new" can hit "close" (a running session asks for confirmation first, but an exited one closes immediately).
3. **The connection status dot and `+` aren't on the same horizontal line.** The dot is an 8px circle, geometrically centered; `+` is an 18px text glyph whose vertical position depends on font metrics. With Chromium's default font the center of the `+` strokes measured 1.5px below the dot, and it shifts again on other platforms and fonts.

## Decision

### 1. `+` is not inside the scrolling tab strip

The top bar, left to right: **tab strip** (tabs only, scrolls horizontally on its own) · gap · **`+`** · space · **status dot**.

- When tabs fit, the strip is exactly as wide as the tabs and `+` follows it, looking as before ("right after the last tab"), just with the gap.
- When tabs overflow, the strip shrinks to "top bar width minus `+`, the gap and the status dot" and scrolls inside that; `+` stays to its right, **always visible and never moving**.
- Scrolling the current tab into view works as before: the strip's rectangle is the tabs' visible area, and `+` never covers a tab.

### 2. A non-clickable gap before `+`

Leave **12px (mouse) / 16px (touch)** of empty space between the strip's right edge and `+`'s hit area. The gap belongs to the top bar itself; tapping it does nothing and doesn't take focus from the terminal (all presses on the top bar `preventDefault`, like tabs). Together with the tab's own 4px right padding, the current tab's ✕ hit area is at least 16px (mouse) / 20px (touch) from `+`'s hit area.

Why not larger: the gap is only there so a slightly-off finger or pointer doesn't cause harm. Any wider and `+` drifts away from the tabs and no longer reads as "add a tab".

### 3. `+` is an icon, centered on the same line as the status dot

`+` becomes a 14px inline SVG (two 1.75px strokes with round caps), centered in a 36px (touch: 40px) button. The status dot is also centered on the top bar's height. Their geometric centers share a horizontal line, independent of font metrics.

E2E measures the vertical centers of the SVG and the status dot's rectangle; they must be within 0.5px.

### Implementation

Pure CSS, no JS measuring:

```css
.tabbar   { flex: 0 1 auto; min-width: 0; overflow-x: auto }   /* fits: total tab width; overflow: shrinks */
.tab      { flex: 0 1 auto; width: 240px; min-width: 120px }   /* equal width: same 240px basis, shrink together, stop at 120px */
.tab-new  { flex: none; margin: 0 auto 0 12px }               /* 12px gap on the left (16px on touch); auto on the right pushes the dot to the far right */
.conn-dot { margin: 0 10px }                                   /* at least 10px from `+` on overflow */
```

The strip's max-content width is the sum of the tabs' `width` (240px each), so when tabs fit it doesn't stretch across the whole top bar.

### Rejected alternatives

- **Keep `+` in the strip with `position: sticky; right: 0`.** That keeps it visible on overflow, but `+` would cover scrolling tabs: the strip's rectangle would no longer be the tabs' visible area, so "is the current tab fully visible" and `scrollIntoView` would have to subtract `+`'s width, and the gap would need an opaque background to hide the tabs underneath. Moving `+` out of the strip avoids all of this.
- **Pin `+` to the far right of the top bar, next to the status dot.** With few sessions it's far from the tabs and no longer reads as related to them.
- **Shrink ✕, or show the current tab's ✕ only on hover.** Touch has no hover, and the current tab's ✕ is the visible way to close a session on touch ([ADR-0025](0025-termux-style-ui.md) §4).

## Consequences

- AC-4.10: `+` is not inside the tab strip, stays visible on overflow, has a non-clickable gap from the strip, and is vertically centered with the status dot.
- E2E-41 ① asserts `new-session` is in the top bar and not inside `tabbar`; ⑧ asserts `+` is 12px past the strip's right edge when tabs fit, and fully inside the top bar, visible and still 12px apart when they overflow; a new step checks vertical alignment of `+` and the status dot.
