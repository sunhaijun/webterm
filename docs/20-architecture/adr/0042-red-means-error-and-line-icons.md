# ADR-0042 Red means error only; the remaining character icons become line icons; drawer paths read left to right and names come first

Status: Accepted (2026-10-31). Revises the color of the unread dot in [ADR-0030](0030-no-settings.md) §3 and AC-4.10. Extends [ADR-0037](0037-settings-theme-and-font-size.md) §3's icon style to the tab ✕, the overlay ✕ and the pin marker.

## Context

A UX review (desktop, phone and tablet; light and dark; screenshots with duplicate names, renamed, exited, unread and pinned sessions) found:

1. **Red means too many things.** Unread dots, the unread dot on the session button, `exit 1`, the Close button and the disconnected status dot all used `--err`. In the drawer, three red unread dots next to a red `exit 1` made "new output" indistinguishable from "something went wrong".
2. **Four character icons remained**: the ✕ on tabs, the ✕ in overlay title bars, the `⇵` pin marker, and the `✓` in the session menu. ADR-0037 §3 said not to use Unicode symbols as icons (glyphs vary by platform, vertical position by font metrics); these were missed. `⇵` was also thin and meaningless to users.
3. **Drawer paths were reversed** (a bug). The path column used `direction: rtl` so overflow truncates from the left (keeping the useful end). The leading `~` and `/` are direction-neutral, so in an rtl paragraph they were moved to the right: `~/github/webterm` displayed as `github/webterm/~`, and `/tmp` as `tmp/`. Most sessions start under the home directory, so on phones nearly every row was wrong.
4. **With a long path, the name was squeezed to one character.** Name and path shrank in proportion to their widths, so a long path left the name as `a…`. The name is the primary information.

## Decision

### 1. Red only for errors and destructive actions

- **Unread dots use the accent color** (`--accent`): on tabs, drawer rows, and the corner of the `compact` session button.
- Red (`--err`) is reserved for non-zero exit codes, Close-type buttons, disconnected / fatal states, and error toasts.
- The current session never has an unread dot (it has no unread output), so it never collides with the current item's accent background.

### 2. The remaining character icons become line icons

Drawn as in ADR-0037 §3 (14×14 box, 1.75px stroke, round caps and joins, `currentColor`), scaled for each place:

| Where | Before | After |
|---|---|---|
| Close on a tab (`tab-<sid>-close`) | `✕` | Two crossed strokes, 12px |
| Close in an overlay title bar (`drawer-close`) | `✕` | The same ✕, 16px |
| Pin marker (`.pin-mark`) | `⇵` | A pushpin: a bar on top, the body, the point, 12px |
| Pin check in the session menu (`.menu-check`) | `✓` | A line check mark, 12px |

A pushpin is the common symbol for "pinned", and the code already calls this state `pinned`; `⇵` tried to say "receives both ways" and nobody could tell.

### 3. Drawer rows: paths read left to right, names get space first

- The path is wrapped in `<bdi dir="ltr">`: the outer element stays `direction: rtl` (truncate from the left, ellipsis on the left), and the content inside is laid out left to right, so `~` and `/` stay put.
- When shrinking, **the path gives way first**: its shrink weight is far larger than the name's, so the name is shown whole when it fits. The path keeps at least `min(6em, 25%)`, enough to see the last directory. Only when the name doesn't fit even then is it truncated.

### Rejected alternatives

- **Gray unread dots.** Too weak, and they blend into the gray CWD in the drawer. The accent color already means "something here".
- **Truncate paths from the right (drop rtl).** That keeps `~/github/web…` and cuts off the most useful part, the last directory.
- **Insert an LRM (U+200E) on each side of the path.** Same effect, but invisible characters end up in the text, which copying and test comparisons then have to work around; `<bdi>` is just markup.

## Consequences

- "Red dot" becomes "unread dot" in AC-4.10, session-ux.md (unread marker, row layout, tabs), layout.md (icons), the glossary, user stories, and devices-and-layout.
- E2E-28 gains two steps: the first character of the path renders to the left of the last (measuring character positions; comparing text content can't detect the reversal), and with a long path the name is fully visible. E2E-41 ⑤ asserts the pin marker is the pushpin SVG; ⑥ asserts the unread dot uses the accent color.
