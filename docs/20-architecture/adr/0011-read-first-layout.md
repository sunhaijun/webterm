# ADR-0011 Read-first layout with three states (read / write / control)

Status: Accepted (2026-09-08). Mobile display surface superseded by [ADR-0013](0013-terminal-only.md): the terminal became the only display surface, and the block stream, transcript view and view switching were removed. The bottom bar and auto-control rules were revised earlier by [ADR-0012](0012-ai-cli-conversation-first.md).

## Context

On a 390×664 phone the classic terminal layout packed four things into one screen: terminal grid, mode bar, Composer and key bar. Measured heights were `28 / 520 / 26 / 38 / 53` px. **The area for writing a command was 38 px (one line)**, and with the on-screen keyboard up the viewport dropped to ~360 px, leaving the terminal about 200 px.

So reading had 520 px when nobody was reading, and writing had 38 px when someone was writing. Each got in the other's way and neither worked well.

More fundamentally, a terminal grid is designed for a person watching one continuous scroll region. Scrolling 5,000 lines of canvas on a phone to find where the last command ended, or which one failed, was the product's worst experience. Shell integration (ADR-0007 / OSC 133) already delivered command boundaries, exit codes and durations to the client; the main view just threw them away.

## Decision

**Split the screen into three states, each optimized for one job. The system already knows which state it should be in.**

| State | When | Main surface | Signal |
|---|---|---|---|
| **Read** | At a prompt; a command running without taking over the screen | Command block stream (DOM, native scrolling, newest at the bottom) | `prompt_state` = input / running, on the main buffer |
| **Write** | About to type the next command | Bottom sheet: collapsed (one line) / half / full | User touches the input area |
| **Control** | A program owns the screen: vim / top / less / htop, **and main-screen full-screen CLIs like claude / codex** | Full-screen xterm + context key bar | Alternate buffer active, **or the program enters a full-screen input mode**: rich keyboard (Kitty `\e[>…u` / modifyOtherKeys `\e[>…m`), application cursor keys (DECCKM `\e[?1h`, top), mouse tracking, or synchronized output 2026 |

Three constraints:

1. **Read is the only persistent canvas; write is a sheet that rises over it, not a page flip.** Three full-screen pages would flip twice per command, which is heavier than before. At half height the previous block stays in view (validated with a prototype on a real device).
2. **Control triggers when a program owns the screen, not when a command is running.** `sleep 100` and `top` are both running; only the one owning the screen belongs in control. The mechanical signatures: the **alternate buffer** (`\e[?1049h` from vim / top / less), or a program **setting up rich keyboard input**. Main-screen CLIs like claude (Ink) and codex (ratatui) take over keys by pushing Kitty keyboard flags `\e[>…u` or modifyOtherKeys `\e[>…m`, or redraw whole frames with synchronized output 2026. `top` neither switches to the alternate buffer nor sends a keyboard protocol, but it sets **application cursor keys** (DECCKM `\e[?1h`) to take the arrow keys; that counts as a full-screen input mode too, as does mouse tracking. **"Hidden cursor + cursor moving up" is not a signal**: npm / pnpm / cargo / docker multi-line progress bars hide the cursor and redraw upward too, and would throw the user into the terminal mid-typing (reproduced); progress bars never enter these input modes. After a reconnect or session switch, detection re-reads xterm's current modes (`term.modes`), so reloading the page while `top` runs doesn't leave a broken block. A manual way into the terminal stays, for what blocks can't show (aligned tables, colored diffs).
   **Revised by [ADR-0012](0012-ai-cli-conversation-first.md) γ**: when the program is claude / codex, don't enter control automatically; their home is the transcript in the read view plus the Composer. vim / less / top still enter control.
3. **xterm is never destroyed, only hidden.** It still determines the PTY size (`FitAddon` needs the real container size), is the target of "view in terminal", and is the control canvas. In read state it keeps its real size with `visibility: hidden`, not `display: none`.

**Bottom bar** (revised by [ADR-0012](0012-ai-cli-conversation-first.md)): at a prompt, tapping it enters write. While a command runs it is **still the same Composer**, and sending pastes the whole text and presses Enter. The old per-keystroke input line was removed because its echo was unusable on slow networks; `[Y/n]` answers and passwords go through the Composer too.

**Degradation = the block stream collapses to one block.** Without OSC 133 marks (ssh to another host, integration unavailable), all output after the last block is one live-tailed "tail block". When marks return, block splitting resumes from there. There is no "degraded mode" concept; the same renderer handles zero boundaries.

On desktop (`≥ 1024px`) the terminal view stays the default, since the screen is large enough that the problem doesn't exist; the read view remains an option.

Rollout:

| | Scope | Notes |
|---|---|---|
| ① | Block stream as the phone/tablet default; xterm kept alive and hidden; dual-state bottom bar; live tail; tail-block degradation; manual terminal entry | Shipped with this ADR |
| ② | Screen-ownership detection → enter control / return to read automatically; context key bar per foreground program | Shipped. Alternate buffer via `buffer.onBufferChange`; in-place main-screen redraws via `parser.registerCsiHandler` watching cursor-up / positioning / synchronized output (`term/interactive.ts`); command boundaries `reset()` detection; automatic switches don't write preferences, and after a manual switch there is no automatic return; the key bar is chosen by `programOf(running block's command)`: pager / top / vim / nano / generic TUI, with claude / codex getting the generic TUI keys plus the program name |
| ③ | Three sheet heights; write-oriented edit key row; same-CWD history suggestions + real path chips | Shipped. The sheet overlays the block stream without squeezing the canvas, so the PTY size doesn't change between heights; submitting collapses it; chips: empty input = snippets + same-directory history, typed input = path completion + prefix history; `GET /api/fs` runs with the shell's permissions; the mode bar's secondary entries moved into the ⋯ menu; the phone/tablet terminal view uses the same 56 px slot, so switching views never resizes; desktop keeps the classic bottom bar |
| ④ | Block actions (rerun / copy / view in terminal at that block; maximize / restore) | Shipped. "View in terminal": the agent sends `command.*` before the frames, the client splits frames at `out_seq` and registers an xterm marker at the cut, scrolls to the block's first line and highlights it for 1.6 s, falling back to searching for the command text once the marker has left scrollback. Maximize fills the screen and scrolls; "Restore" returns it inline |

Prerequisites, done first because the read state is built on command boundaries and is only as solid as they are: #27 stamps `command.start/end` `out_seq` at each mark's exact position (C and D in the same PTY read each get their own); #28 two-stage handshake (early hello) plus per-command liveness probing (`unmarked_input`); #26 fixed false integration-idle detection and added a direct `^C` key.

## Consequences

- Reading output on a phone goes from flinging 5,000 lines of canvas to a natively scrolling block list, with 500 lines collapsed to one and failures visible at a glance.
- One more layer of view state (read / terminal). E2E tests distinguish the default state by viewport; `__webterm.view()` exposes it.
- Running blocks render as plain text (every 120 ms); finished blocks render once through an offscreen xterm for exact output. Fidelity and smoothness each where they matter.
- Design language: shadcn's token logic (neutral scale, 1 px borders, 6/10 px radii, 44 px hit targets, focus ring) as CSS variables, **without React / Radix / Tailwind** (the project is Preact plus hand-written CSS; fewer dependencies is deliberate). Extra tokens: `--font-ui` (proportional font for chrome; commands and output stay `--font-mono`), `--code-bg` (block output is an inset, rounded dark code panel in both themes, since ANSI colors are tuned for dark backgrounds), `--card-shadow` (a very light card shadow for depth).
- Block actions are spaced **text links** in a light footer, not a row of buttons crammed onto black; "view in terminal" is the primary action. Maximize / restore in the block header are inline SVG icons, not font glyphs that may be missing.
