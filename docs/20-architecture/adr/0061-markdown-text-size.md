# ADR-0061 Markdown previews: text size

Status: Accepted (2026-11-08). Amends [ADR-0060](0060-files-maximize-and-markdown.md) §2 ("Looks"). Adds AC-9.15 and E2E-55. Neither the HTTP API nor the protocol changes.

## Context

Rendered Markdown ([ADR-0060](0060-files-maximize-and-markdown.md) §2) is set at a fixed 15px. That is small for a long plan read on a phone held at arm's length, and small on a maximized desktop window across the room; on a narrow phone a smaller size fits a table without scrolling sideways. Pinch-zooming the page doesn't help: it zooms the whole app, toolbar and sheet included, and scrolls sideways.

## Decision

### 1. Two buttons on the size line

- **Rendered Markdown only.** The size line ([ADR-0059](0059-files.md) §4) gets two buttons left of **Source**: a small "A" (`md-smaller`, "Smaller text") and a large "A" (`md-larger`, "Larger text"), the pair a reader app shows. Source stays rightmost, so it doesn't move when the pair appears or goes. They are absent in Source, for text files and while a file is binary.
- **Eight sizes**: 12, 13, 14, 15, 17, 19, 21 and 24px, default 15. Each tap moves one step; a button is disabled at its end. The steps grow by about a tenth, so each one shows and eight cover a phone in the hand to a screen across the room. The size isn't shown as a number: the text is the indicator.
- **Everything in the preview scales with it**: headings, inline code and code blocks (code at 0.84 of the text), tables, spacing. The column is at most 50em wide (750px at the default), so a line holds about as many characters at every size, as with browser zoom.
- **The place you are reading stays put.** Before the size changes, the first block whose bottom is below the size line, and how far into it the size line falls, are noted; after the change the preview scrolls so the same point of the same block is at the size line again. At the top of the file, nothing moves.
- **Remembered per device** (`webterm.mdSize` in local storage, read inside `try`; any other value reads as 15), like maximize ([ADR-0060](0060-files-maximize-and-markdown.md) §1): it applies to every Markdown file from then on. It is reading state, not a setting ([ADR-0030](0030-no-settings.md)), and stays out of Settings.

### 2. The size line stays at the top

For text and Markdown, the size line sticks to the top of the sheet while the file scrolls (the sheet's background behind it), so text size, Source and End are reachable halfway down a long file. Headings scrolled to by an `#anchor` stop below it. Images, video and audio don't scroll, so nothing changes for them.

## Alternatives considered

- **Pinch to zoom the preview**: a hidden gesture, where the main way in is a visible button, and two fingers on a bottom sheet compete with its swipe-down. It can come later as a shortcut for the same steps.
- **A stepper with the number between − and +**, as Settings has for the terminal: a number of pixels means nothing while reading, and it takes room the date needs on a phone.
- **An "Aa" button opening a sheet with the steps**: the sheet would cover the text being sized, and every change would take two taps.
- **The terminal's font size**: a different thing at a different scale (14px monospace for a grid of cells), changed in Settings and applied to every session. Tying the two would make the terminal reflow when you read a file.
- **Text files too**: they're logs and source, read in monospace at 12px with wrapping; nobody asked. The same pair can be added there if they are.
- **Scaling by the scroll ratio** instead of an anchor block: a document with a big table or image near the top drifts by screens.

## Consequences

- No new dependency, no API change. One local-storage key.
- `scroll-margin-top` on headings grows to clear the sticky size line.
- Tests: UT-files-8 (the steps and the remembered size), E2E-55.
