# ADR-0015 One bottom key row: the toggle always comes first, program keys never cover the terminal

Status: Accepted (2026-09-11). Refines the bottom bar of [ADR-0014](0014-input-toggle.md): the toggle, ⋯ and the key bar merge into **one key row**, and the edit panel's header merges into its own key row. Superseded by [ADR-0025](0025-termux-style-ui.md): the single context-dependent key row became two static rows of extra keys.

The terminal as the only display surface (ADR-0013), the toggle model, direct keystrokes from the terminal and whole-text sending from the edit panel were unchanged.

## Context

After ADR-0014 we screenshotted and measured every state on a Pixel 5 (393×727), in landscape (802×293) and on an iPhone SE (320×568):

- **The toggle had a row to itself, 72% empty.** In terminal state the first row held only `⌨▸Edit` (65 px) and `⋯` (44 px): 284 px of 393 px empty, 693 px of 802 px in landscape.
- **With a command running or a program owning the screen, two stacked rows covered the bottom ~3 terminal lines.** The `.bottom-slot` was fixed at 56 px; the bar grew to 109 px, and the extra 53 px were absolutely positioned over the terminal (≈3.2 rows at 16.5 px per row). That's where less's `:` status line, vim's command line, and the bottom edge and shortcut hints of claude's input box live; likely part of "can't find the input bar in claude" from ADR-0014.
- **The toggle differed in position and size between states.** A 65×44 key in terminal state; 69×34 squeezed into a 24 px grabber row in edit state, sticking out 5 px above and below over the panel's rounded corner.
- **Edit state with a running command had two key rows again.** Edit keys 52 px + program keys 56 px = 108 px. With the keyboard up (520 px viewport emulation), the input box had 92 px (≈3.8 lines) and the chrome below it 140 px.
- **The full-height edit panel's input didn't fill it.** `.composer`'s `max-height: 40vh` still applied inside the sheet: given 614 px, the box grew to 291 px and left 323 px empty.
- **In terminal state claude / codex got the generic key bar.** Terminal state passed `altScreen` to `KeyBar`, edit state passed `interactive`; the same claude showed 21 generic keys without the program name in terminal state, and AI keys only after opening the edit panel.

What the user wanted: the most out of every pixel, simple and efficient, with the toggle first in the button row.

## Decision

1. **The bottom bar is always exactly one key row**, with a fixed structure: **toggle · context label · horizontally scrolling key area · fixed trailing key**. The trailing key is `⋯` in terminal state and `Send` in edit state. Row height = slot height (56 px; 40 px in the `short` layout). **In terminal state `.bottom` must not be taller than the slot**, so the bar never covers the terminal.
2. **The key area changes with who owns the screen; its height doesn't:**
   - at a prompt → **prompt keys** `Tab ↑ ↓ ^C ^L | ~ / - _ ← →` (the row is there anyway, so fill it with what on-screen keyboards lack most);
   - command running / integration degraded → generic keys `Esc ^C Tab Ctrl ↑ ↓ ← → Alt …`;
   - program owns the screen → per foreground program (less / top / vim / nano / AI / generic TUI). **Both states decide by `interactive`**, so claude / codex get the same AI keys in both.
3. **Edit panel**: the header is just a 16 px grabber strip (drag anywhere on it; tap to toggle half ⇄ full). **No "collapse" button** (drag to the bottom, Esc again on empty input, or the toggle all close it). The input box fills the remaining height (no 40vh cap inside the sheet); empty chips take no height. The bottom is the same kind of key row: `✎ Terminal` · `Esc ^C` (while a command runs) · edit keys · `Send`. Other program keys (arrows, ⇧Tab, Enter) are per-keystroke interactions and belong to terminal state.
4. **The toggle is the same 44 px-tall key in both states and is always the first key in the row.**
5. **The no-scroll promise drops from the first 8 keys to the first 5** (at 393 px; 4 at 320 px). `^C` stays in second place.
6. **Touch devices use the key row even at ≥ 1024 px**, not the classic bottom bar (iPad mini in landscape is 1133 px). Width decides only the **grid** (permanent sidebar or drawer); touch capability (`pointer: coarse`) decides the **input layer**: `classic = desktop && !coarse`. iPad landscape therefore gets "permanent sidebar + key row / edit panel" rather than "mode bar + permanent input box + key bar". The latter was designed for mouse and keyboard: on touch, the keyboard leaves 14 terminal rows and there is no default direct terminal input.
7. **On tablet / desktop, ⋯ is a 280 px popover anchored above the end of the key row** (no dimming scrim, no grabber). Only phones get the full-width bottom action sheet; a 258 px-tall, full-width four-row sheet on a 744 px tablet is a waste.
8. **Half height is capped at 420 px**: `max(190, min(46% × main area height, 420))`. On phones 46% is under 420 anyway. On a portrait tablet 46% is 521 px, more than the 443 px input box needs, and the rest goes to the terminal. With the keyboard up the main area shrinks and 46% naturally falls under the cap.

## Consequences

- **Three fewer keys in the no-scroll zone**, in exchange for three more visible terminal rows, a consistent toggle position and an always-reachable ⋯. Scrolling the key area to the end still reaches every key.
- **No "collapse" button.** "Collapse" closed the panel and the keyboard; `✎ Terminal` closes the panel and focuses the terminal. To just read the terminal, drag down or press Esc on empty input. Keeping the button would cost another 44 px slot or a spot back in the grabber row.
- **Edit state only adds `Esc ^C`.** The edit panel's job is writing a whole message and sending it once; driving claude's menus key by key belongs to terminal state, one toggle away.
- **An extra row of keys at the prompt.** Visually denser than two keys, but no taller, and those keys (Tab completion, ↑↓ history, `|` `~`) are exactly what on-screen keyboards lack for shell commands.
- **Wide touch screens lose the classic bar's permanent input box**, in exchange for the same mental model as phones (direct terminal input by default, one tap for the edit panel) and two fewer chrome bars when the keyboard is up. iPads with an external keyboard (`pointer: fine`) are unaffected and keep the classic bar.
- Docs touched: [input.md](../../40-frontend/input.md) (bottom bar, key bars, edit key row), [layout.md](../../40-frontend/layout.md) (bottom bar height, `short` overlay), [acceptance-criteria.md](../../10-requirements/acceptance-criteria.md) (AC-3.9 changed to the first 5 keys, new AC-3.14), [e2e-scenarios.md](../../70-testing/e2e-scenarios.md) (E2E-10, new E2E-25; new `tablet.spec` for iPad mini in both orientations).
- Protocol, reconnect and connection layer untouched. Canvas geometry still never resizes because of the bottom bar (ADR-0011's constraint, ADR-0013).
