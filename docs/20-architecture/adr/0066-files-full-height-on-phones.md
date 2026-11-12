# ADR-0066 The file browser on phones: full height; Source as an icon

Status: Accepted (2026-11-12). Amends [ADR-0060](0060-files-maximize-and-markdown.md) §1 ("`compact` has no button") and §2 (the Source button's label), reversing its "Maximize on phones" alternative, and [ADR-0061](0061-markdown-text-size.md) §1 (the size line's buttons). Amends AC-9.13 and AC-9.14, adds AC-9.16 and E2E-57. Neither the HTTP API nor the protocol changes.

## Context

Two requests after reading Markdown on a phone:

- **The file sheets stop at 80% of the screen.** A plan claude wrote is read top to bottom, and the strip of terminal above the sheet is of no use meanwhile. ADR-0060 turned down maximize on phones because "nobody asked"; now someone has, and the gesture people expect from a bottom sheet is to pull it up.
- **Source is a word next to the two "A" buttons.** The size line reads `A A Source`: two symbols and a label, and the label is the widest of the three on a narrow phone.

## Decision

### 1. Full height on `compact`

- **The file list and a file have two heights on a phone**: 80% of the visible area (as now) and all of it. Only these two sheets; the session drawer, settings and the small sheets keep one height.
- **Pull the grab handle or the header up** and the sheet follows the finger up to the full height; released more than 48px above where it rested, it goes to full height, otherwise it settles back. Pulling up on the body still scrolls it.
- **Pull down** from full height and the sheet follows: released more than 48px down it goes back to 80%; dragged more than 90px below the 80% line it closes, as a swipe down closes a sheet at 80%. So one long swipe closes it from either height.
- **The handle and the header always drag the sheet**, wherever its body is scrolled; on the body, a pull down drags the sheet only once the body is scrolled to the top, as before. This holds for every bottom sheet: a long list scrolled halfway can be closed from its header.
- **The same button as on `wide`** (`files-max`, left of ✕, [ADR-0060](0060-files-maximize-and-markdown.md) §1) is there on phones too: a square for full height, two squares for back. The pull is the shortcut; the button is the way that can be seen.
- **One state for both forms**: `webterm.filesMax`, shared by the list and a file and remembered per device, as on `wide`. A file covers the list exactly at either height, and closing it leaves the list at the height the file had.
- **At full height** the sheet has no corner radius and keeps its grab handle, and it pads its top by the top safe area (`--sa-top`), so in a PWA the handle and header sit below the status bar and the notch.
- Like every sheet, it never changes terminal geometry.

### 2. Source as an icon

- **`file-source` becomes a square icon button** the size of the two "A" buttons: `</>`, drawn like the other line icons ([ADR-0037](0037-settings-theme-and-font-size.md) §3). The size line reads `A A </>`, and Source stays rightmost ([ADR-0061](0061-markdown-text-size.md) §1).
- **A toggle, not a label that flips**: its name stays "Source" (`aria-label`, `title`), `aria-pressed` is true while the source shows, and then the icon is in the accent color, which means "this one is selected" ([layout.md](../40-frontend/layout.md#theme)). Tapping it again shows the rendered file.
- End / Start for long files stay words: they name a place, and there is no common symbol for either.

## Alternatives considered

- **Pulling up anywhere expands, as iOS sheets do** (the body scrolls only at full height): reading would expand the sheet with the first scroll, but so would scrolling the file list, and every swipe up in an 80% sheet would move the sheet instead of the content. The handle and header are where people reach for a sheet.
- **Only the gesture, no button**: the step back from full height would have nothing visible, and with full height remembered every file would open that way with no visible way down. A visible button is the main way in; a gesture is a shortcut.
- **Not remembering full height on phones**: every Markdown file would need the same pull again. A phone is always `compact`, so sharing `webterm.filesMax` with `wide` mixes nothing.
- **Full height for every sheet**: the session drawer and settings are short lists, and the confirm and name sheets are a few lines.
- **A segmented Preview | Source control**: clearer about the two states, but twice the width on the line the date already shares with three buttons.
- **An eye icon for Preview while the source shows**: two icons for one button, and which one means "now" or "next" is a guess.

## Consequences

- No new dependency, no API change, no new storage key.
- `files-max` exists on both forms; E2E-54 (2) "no button on a phone" goes, E2E-57 covers the pull and the button on a phone.
- The swipe-down code (`web/src/ui/swipe.ts`) becomes a sheet drag with an optional second height.
- Tests: UT-sheetdrag-1 (where a release lands), E2E-54 (5) checks `aria-pressed`, E2E-57.
