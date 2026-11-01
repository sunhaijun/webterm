# ADR-0007 Dual-mode input (Composer / Raw)

Status: Accepted (2026-09-06). User-visible Composer/Raw modes and manual switching/locking superseded by [ADR-0013](0013-terminal-only.md) (input is routed by where you touch: tapping the terminal sends keystrokes, the input bar sends edited text). The internal "is a command running" state machine that remained, used only to show the key bar, was removed by [ADR-0025](0025-termux-style-ui.md) once the key rows became static.

## Context

The top complaint was typing in the terminal, especially non-English text.

The root cause: terminal input is pass-through. Every keystroke becomes bytes written to the PTY immediately. An IME needs a composition buffer that produces nothing until a candidate is chosen. The two are architecturally at odds.

xterm.js bridges this with a hidden `textarea` and composition events, but candidate window placement, wide-character cursor alignment and screen state during composition have been chronic problems. **IME can't be fixed within the pass-through model.**

## Decision

**Two input modes, switched automatically from the shell's prompt state.**

**Composer (default).** The terminal becomes a read-only output view with a separate multi-line `textarea` below.

- IME composition happens entirely in a native `textarea`, so the candidate window is placed correctly and text can be edited, pasted, spread across lines and undone.
- Submit writes the whole text wrapped in bracketed paste, plus `\r`.
- The input box can offer history, snippets and completion like any web form.

This sidesteps the IME problem instead of patching it.

**Raw.** Keystrokes go straight to the PTY, for vim, htop and interactive prompts. IME still gets care here: hidden textarea plus composition events, committed **once on `compositionend`**, with an inline preview overlay at the cursor during composition.

**Automatic switching** from OSC 133 marks:

| Received | Meaning | Mode |
|---|---|---|
| `133;B` | Prompt drawn, waiting for input | **Composer** |
| `133;C` | Command started | **Raw** |
| `133;D` | Command finished, back at the prompt | **Composer** |

A manual switch locks the mode; automatic switching pauses until unlocked.

Why "Raw while a command runs" is right: there's no need to detect whether the foreground program is a TUI. Any running command may need `Ctrl+C`, a `y/n` answer, paging in `less` or editing in vim, and all of those need pass-through. At a prompt the user can **only** be typing a command, which is what the Composer is best at. So the rule needs no program names: **at a prompt → Composer; running a command → Raw.**

Rejected alternatives:

- **Raw only, and fix xterm.js IME.** Upstream hasn't fully solved it in years. Even with IME fixed there would be no multi-line editing, undo or mid-text edits, which a 300-character prompt needs.
- **Composer only.** vim, htop and `Ctrl+C` stop working.
- **Dual mode with manual switching.** Users would have to understand and manage a "mode", switching dozens of times a day. Automatic switching is what makes the design work, and it is also what made shell integration a v0.1 requirement.

## Consequences

Positive:

- CJK and long-text input goes from unusable to better than a local terminal.
- The Composer avoids per-keystroke round trips on high-latency links: one round trip per line.
- The input box is plain DOM, so history, snippets and completion aren't constrained by the terminal grid.

Negative:

- Automatic switching **depends on shell integration**. Without it, fall back to "Composer by default, switch manually", and say so clearly in the UI (AC-3.7 / US-7.1).
- Two input code paths, two test suites.
- The mode state machine has edge cases:
  - `133;C` immediately followed by `133;D` (an instant command) shouldn't flash Raw; debounce it.
  - A manual switch while a command prints output locks the mode.
  - Mode state follows the session being switched to; it is not global.
  - Integration going inactive (e.g. the user runs `exec zsh`) stops automatic switching.

State machine details are in [`../../40-frontend/input.md`](../../40-frontend/input.md).
