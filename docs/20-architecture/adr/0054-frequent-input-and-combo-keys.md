# ADR-0054 Frequent input and combo keys at the end of the extra keys

Status: Accepted (2026-11-07). §3–§4 superseded by [ADR-0057](0057-command-strip-and-history.md) (2026-11-08): ⟲ is now recent history and ⌘ a command strip for claude and codex only; §1 and §2 stand. Amends [ADR-0025](0025-termux-style-ui.md) §2: the fourteen extra keys stay static, and two keys are added at the end whose places never change but whose menus follow the foreground program. Adds `program` to session info and `session.updated`, and `GET /api/frequent`. §3's shell-history line is revised by [ADR-0055](0055-webterm-setup.md) (2026-11-07): `webterm setup` adds it, with consent.

## Context

On a phone, two things are slow when talking to claude or codex:

1. **Sending the same few inputs again.** In the user's own claude history (`~/.claude/history.jsonl`, 1879 entries), five of the ten most repeated entries in the last 3000 are slash commands, the most repeated sent 114 times; the other five are a few characters of text, the most repeated sent 39 times. Each one means opening the keyboard and typing, often in Chinese through an IME.
2. **Keys the phone can't send.** claude switches modes with `Shift+Tab`, which neither the extra keys nor a phone keyboard can produce. Its double `Esc` (rewind), `Ctrl+O` (transcript), `Ctrl+T` (todos) and `Ctrl+B` (run in background) need the sticky CTRL key and two taps each, if you remember them.

Checked against claude 2.1.317's built-in key bindings: `shift+tab` cycles the mode ("Press shift+tab to switch modes"), `Esc Esc` opens `/rewind`, `ctrl+o` is `app:toggleTranscript`, `ctrl+t` `app:toggleTodos`, `ctrl+b` `task:background`, `ctrl+r` `history:search`, `meta+p` `chat:modelPicker`, `ctrl+c` `app:interrupt`. codex 0.166's bindings aren't in a table its binary exposes; the set below is the commonly documented one and is confirmed on a real run (manual checklist).

The history behind this: per-program key rows existed before (ADR-0013 §2, ADR-0015) and were removed by ADR-0025 because keys that move with the program never become muscle memory. Command history and its panel were removed by ADR-0026 with shell integration, and the command palette by ADR-0022, because there were too many concepts for a handful of candidates.

## Decision

### 1. Two keys at the end, in fixed places

A new right column in the extra keys, on every form that has them (`compact`, and `wide` with a coarse pointer):

```
┌────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┬────┐
│ [3]│ ESC  │  /   │  -   │ HOME │  ↑   │ END  │ PGUP │ ⟲  │  frequent input
├────┼──────┼──────┼──────┼──────┼──────┼──────┼──────┼────┤
│ ✎  │ TAB  │ CTRL │ ALT  │  ←   │  ↓   │  →   │ PGDN │ ⌘  │  combo keys
└────┴──────┴──────┴──────┴──────┴──────┴──────┴──────┴────┘
```

- **Frequent input** (`key-frequent`, a clock-with-arrow line icon) and **combo keys** (`key-combos`, a two-keys line icon). Their places and icons never change; only the menu each opens follows the program. The fourteen keys don't change at all.
- The column is a key column like the others, so at 393px every key goes from about 50px to about 44px wide.

### 2. The agent says which program is in front

`program` on a session: `shell`, `claude`, `codex`, or `other`. The agent works it out in the once-a-second poll, only when the foreground process group changes:

- `shell`: the foreground group is the shell itself.
- `claude`: `/proc/<pgrp>/exe` is under a `claude/versions/` directory or is named `claude`, or `argv[0]` / `argv[1]` is named `claude` or lies under `@anthropic-ai/claude-code` (the npm install runs node).
- `codex`: the same with `codex` and `@openai/codex`.
- `other`: anything else, and exited sessions.

Not the process name: one claude process is called `claude` and another `2.1.316` on the same machine (the version file is the executable). Not the terminal title: claude replaces it with the conversation's topic.

It's in `welcome.sessions[]` / `session.created` and in `session.updated` when it changes. It isn't handed over on upgrades; the first poll after one sets it again.

### 3. Frequent input: the program's own history, read on request

`GET /api/frequent?program=<shell|claude|codex>` (authenticated like every route) returns `{"items": [...]}`, at most ten:

| Program | Source |
|---|---|
| `claude` | `~/.claude/history.jsonl`, field `display` |
| `codex` | `~/.codex/history.jsonl`, field `text` |
| `shell` | the session shell's history file: `~/.bash_history` for bash (lines starting `#<digits>` are timestamps), `~/.zsh_history` for zsh (`: <time>:<n>;` prefix removed) |

- Read at most the last 1 MiB of the file, take the last 1000 entries, keep single-line entries of 1–80 characters after trimming, drop claude's placeholders (`[Pasted text #N …]`, `[Image #N]`), and for the shell drop entries shorter than 3 characters (`ls` is faster typed). Rank by count, ties by the most recent; return the top ten.
- `other`, a missing file or an unreadable one → an empty list.
- **webterm stores nothing**: no copy, no log line, no cache in the agent. The browser keeps the last list per program in memory only, to show it while the new one loads.
- bash writes its history when the shell exits, so commands from a shell that has been open for days show up late; `PROMPT_COMMAND="history -a${PROMPT_COMMAND:+;$PROMPT_COMMAND}"` in `~/.bashrc` writes each command as it runs. webterm doesn't change the user's shell config ([troubleshooting.md](../../80-ops/troubleshooting.md#frequent-input-is-empty-or-old)).

### 4. The menus

Both open a popover above the extra keys (`frequent-menu`, `combo-menu`), closed by a tap outside, `Esc` (taken before the terminal) or switching sessions. They never take focus from the terminal or the text box.

- **Frequent input**: one row per item (`frequent-<i>`), the text on one line. **Tapping a row sends it and Enter** the way the text page sends ([ADR-0027](0027-text-page-enter-submits.md): a bracketed paste, then a separate `\r`), to the current session. The row's ✎ (`frequent-insert-<i>`) pastes without Enter, to edit before sending. No search, no pinning, no editing the list. An empty list shows one muted row, "No history".
- **Combo keys**: a grid of tiles (`combo-<id>`), each a key name and a short action name. A tap sends the bytes on the same path as the extra keys (counted in `inputStats`, past the replay gate), bypassing an armed CTRL / ALT, and closes the menu.

| Program | Tiles |
|---|---|
| `claude` | `⇧Tab` Mode · `Esc Esc` Rewind · `^O` Transcript · `^T` Todos · `^B` Background · `^R` History · `⌥P` Model · `^C` Interrupt |
| `codex` | `Esc` Interrupt · `Esc Esc` Edit previous · `^T` Transcript · `^J` Newline · `^L` Clear · `^C` Quit |
| `shell` | `↵` Enter · `^C` Interrupt · `^D` EOF · `^R` Search · `^L` Clear · `^Z` Suspend · `^W` Delete word · `^U` Delete line |
| `other` | `↵` Enter · `Esc` · `^C` Interrupt · `^D` EOF · `^Z` Suspend · `^L` Clear |

`Esc Esc` is two writes 120 ms apart, so it reads as a double tap and not as Alt+Esc. `⌥P` is `ESC p`.

### Rejected alternatives

- **Rows of keys that change with the program** (what ADR-0013 / ADR-0015 had). Removed by ADR-0025 for good reason; the change here is behind one fixed key.
- **webterm keeps its own command history.** It would bring back what ADR-0026 removed, and store input on disk. The programs already keep theirs.
- **Search, pinning, labels in the list.** The history panel had them and went with ADR-0025; ten items need none.
- **Reading claude's or codex's transcripts** for smarter suggestions. Private formats ([ADR-0013](0013-terminal-only.md)). The history files are read for one field each, and a format change empties the list rather than breaking anything.
- **Long-press for the menus.** Visible keys, per the project's rule that the main way in is a button.
- **Settings for the lists.** There are none ([ADR-0030](0030-no-settings.md)).

## Consequences

- ADR-0025 §2's "static" now reads: the fourteen keys are static; the two at the end are static in place, and their menus follow the program.
- Docs: [input.md](../../40-frontend/input.md#history-and-commands-ac-324) (layout, the two menus), protocol (`program`), [http-api.md](../../30-protocol/http-api.md#history), [session-manager.md](../../50-backend/session-manager.md), [privacy-history.md](../../60-security/privacy-history.md), AC-3.24, AC-3.25, troubleshooting.
- Tests: UT-program-1 (classification), UT-frequent-1 (each format, filters, ranking, the 1 MiB tail), IT-program-1 (`session.updated{program}` for a shell, a program named `claude`, and back), IT-frequent-1 (the route: authentication, a temporary `HOME`), UT-combos-1 (tile sets and bytes), E2E-51 (the column's geometry, both menus, sending).
