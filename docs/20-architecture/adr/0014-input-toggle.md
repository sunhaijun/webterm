# ADR-0014 Bottom bar input toggle (terminal input ⇄ edit panel)

Status: Accepted (2026-09-11). Refines the input surface of [ADR-0013](0013-terminal-only.md) §2, replacing "no input mode, routed by touch location, edit panel always in the bottom bar" with an **explicit toggle** that defaults to terminal input. Superseded by [ADR-0025](0025-termux-style-ui.md): the toggle and the edit panel were removed in favor of Termux-style extra keys and a text page.

The terminal as the only display surface, tap-the-terminal-to-type, and whole-text sending from the edit panel were unchanged.

## Context

ADR-0013 kept the edit bar permanently in the bottom bar and routed input by touch location: tap the terminal = direct input, tap the input bar = edit then send. On real devices this had two problems:

- **The permanent edit panel took space and felt redundant.** Most of the time users just want to tap the terminal and type (read output, answer y/n, pick a number, single-key shortcuts). The edit box at the bottom was a distraction and took screen space that could go to the terminal.
- **Users couldn't find the input bar in claude.** The bar changed shape with what was running, so users weren't sure whether they could edit a whole prompt right now (one report: after starting claude the bar didn't show until a reload).

What the user wanted: the most space-efficient direct terminal input by default, and **one tap** to bring up the edit panel for long prompts.

## Decision

1. **The first key in the bottom bar toggles** between terminal input and the edit panel. **Terminal input is the default.**
   - **Terminal input (default)**: the terminal fills the screen; tapping it sends keystrokes directly to the PTY. The bar holds only the toggle `⌨▸Edit` and ⋯; the key bar appears only when a command is running, a program owns the screen or integration is degraded (Esc ^C arrows; AI keys for claude / codex). Most space-efficient and most direct.
   - **Edit panel**: raises the Composer (same-directory history, path completion, multi-line); edit the whole text and send it at once (`xterm.paste` with bracketed paste, plus Enter). The first key in the panel header, `✎▸Terminal`, switches back. The panel drags between half and full height. Sending, Esc on an empty box after clearing, or collapsing all return to terminal input.
2. **Full-screen TUIs (alternate buffer: vim / top / less) force terminal input**, and the toggle gives way to exit / arrow keys. An edit panel makes no sense for keystroke-driven TUIs.
3. **The internal "is a command running" signal is unchanged** (ADR-0007's composer/raw state machine) and only drives the key bar. It is **orthogonal** to the user-visible toggle.
4. **"Fill" from history, the command palette or chips** first raises the edit panel when in terminal input (otherwise the Composer isn't mounted).
5. **The desktop classic bottom bar is unchanged** (Composer always visible, no toggle).

## Consequences

- **Direct per-keystroke input is the default, so typing lags on slow networks.** The edit panel exists for exactly that case (edit locally, send once, no per-keystroke round trips), and the toggle is the escape hatch: one tap for slow networks or long text. Only the default changed; no capability was lost.
- **One more control to understand than ADR-0013's "zero modes".** But it is **visible, has a default, and has two states**, which is more predictable than automatic routing by touch location. The real-device feedback was precisely that automatic routing left users unsure of the current state, so this is a clearer expression, not a step back.
- Touched the bottom bar in `web/src/ui/app.tsx`, a `lead` slot in `WriteSheet` for the toggle in the panel header, and `KeyBar`; E2E `inputmodel.spec` / `sheet.spec` rewritten for the toggle model. See [input.md](../../40-frontend/input.md).
