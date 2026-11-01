# ADR-0028 No explanatory text in the settings panel

Status: Accepted (2026-10-31). **Withdraws the requirement in [ADR-0023](0023-terminal-font-list.md)'s consequences that the settings panel must explain missing ligatures**; rewrites AC-5.13. The font list, detection, persistence, and the fact that ligatures don't render are unchanged.

Later: the whole settings panel was removed by [ADR-0030](0030-no-settings.md). The principle of no explanatory text in the UI still applies, including to the two settings [ADR-0037](0037-settings-theme-and-font-size.md) brought back.

## Context

ADR-0023 worried that people with Fira Code installed would report missing ligatures as a bug, so it required a paragraph at the bottom of the settings panel: only installed fonts are listed, ligatures don't render, font size is remembered per form.

After m8 shipped, the feedback was that the settings carried unnecessary explanations. The panel had four rows (theme, font size, font, preview), each self-explanatory. The paragraph was longer than any row and took a large chunk of the phone's bottom drawer.

## Decision

The settings panel contains only settings and the preview, no explanatory paragraphs. "Ligatures don't render" and "font size is remembered per form" are documented in [layout.md, Fonts](../../40-frontend/layout.md#fonts), not shown in the UI.

### Rejected alternatives

- **Shorten it to one line of small print.** The feedback was "unnecessary", not "too long". The preview row already shows exactly how the font renders; missing ligatures are visible right there.

## Consequences

- AC-5.13 no longer requires the panel to state that ligatures don't render; E2E-12 ⑤ no longer asserts the note.
- New settings don't get explanatory paragraphs either. If a setting needs a paragraph to be understood, the setting itself should change.
