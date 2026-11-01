# ADR-0031 Tab bar: equal-width tabs, horizontal scrolling when they don't fit

Status: Accepted (2026-10-31). **Revises the tab width of the `wide` tab bar in [ADR-0025](0025-termux-style-ui.md) §4** (previously sized to the name, 72–200px). Horizontal scrolling when tabs don't fit and scrolling the current tab into view are unchanged, as are the actions on a tab (select, ✕, middle-click, double-click rename, right-click / long-press menu).

Later: **"`+` follows the last tab" and the Implementation section are revised by [ADR-0035](0035-tabbar-new-button-pinned.md).** `+` moves out of the scrolling tab strip and stays visible when tabs overflow, behind a non-clickable 12px gap (16px on touch); equal widths are implemented as `width: 240px` plus `flex-shrink`.

## Context

In m8 a tab was as wide as its name:

- **Uneven widths.** A tab named `~` was 72px, a long name 200px. Click targets varied in size and the row looked messy.
- **Wasted width.** In a wide window with few sessions, tabs crowded to the left and the right side sat empty.

The user proposed splitting the available width equally and dealing with tabs that get too narrow separately. One option discussed was collapsing overflow into a button that opens a list; after comparing, the user chose horizontal scrolling.

## Decision

### 1. Equal widths, with limits

Every visible tab is **the same width**: available tab-strip width ÷ number of sessions, **at most 240px, at least 120px**. `+` follows the last tab.

- **Why a maximum**: at 1440px with two sessions, an even split makes each tab about 700px. The name sits at the far left and ✕ at the far right, so closing a tab means crossing half the screen, and the row looks more like a toolbar than tabs. Chrome caps its tabs too (around 240px).
- **Why 120px**: after ✕ and padding, it still fits a name of about 10 Latin letters (5 CJK characters). On touch, tabs are 40px tall, and the width is far above the 44px hit target.

### 2. Scroll horizontally when they don't fit

When tabs would get narrower than 120px, they stay at 120px and the tab strip scrolls horizontally, as in m8. When the current tab changes, scroll it into view; leave it alone if already fully visible; no `smooth`.

### 3. The mouse wheel scrolls the tab strip sideways

The tab strip's scrollbar is hidden. In m8, mouse users could only scroll it with `Shift + wheel`, which almost nobody discovers. Now a vertical wheel over the tab strip scrolls it horizontally (intercepted only when the strip actually overflows). Trackpads already scroll horizontally and are unaffected.

### Implementation

Pure CSS: `.tab { flex: 1 1 0; min-width: 120px; max-width: 240px }`, inside the existing horizontally scrolling tab strip. No JS measuring. The wheel conversion is one `wheel` listener on the tab strip.

### Rejected alternatives

- **Equal split with no maximum.** See §1.
- **Collapse overflowing tabs into a "more" button with a list.** The idea: the current tab is always visible, the button shows how many are hidden with a red dot if any have unread output, and opens a list. The user chose horizontal scrolling instead: all sessions stay in one row in a stable order, with no extra button or list. The cost is that unread output in a tab scrolled out of view isn't visible until you scroll to it.
- **Shrink the font to fit more.** The real cause is the number of sessions; a smaller font only delays the problem and makes names harder to read.

## Consequences

- AC-4.10 adds equal widths and wheel scrolling; AC-4.9 (scroll the current tab into view) is unchanged.
- E2E-35 ⑥ no longer needs to `cd` into a long directory name to widen tabs: in a 600px window, 5 sessions at 120px already overflow. E2E-41 adds ⑧ (equal widths, limits, scrolling, wheel).
