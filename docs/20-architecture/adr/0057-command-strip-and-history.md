# ADR-0057 The command strip and the history list

Status: Accepted (2026-11-08). Replaces the two menus of [ADR-0054](0054-frequent-input-and-combo-keys.md) §3–§4: ⟲ becomes a **history** list (newest first) and ⌘ a **command strip** with its own editor, shown only while claude or codex is in front. The last key column itself (§1) and the agent's `program` (§2) stay. `GET /api/frequent` is replaced by `GET /api/history`; `/api/commands` is new.

## Context

In use, the user wanted the two keys to do clearly separate jobs (2026-11-08):

- **⟲ is history**: what you sent recently, newest first. ADR-0054 showed the ten most *frequent* single-line entries, so a long prompt sent once yesterday never appeared, and "history" read as a misnomer.
- **⌘ is the tool's commands**, in an order you arrange: all of claude's (or codex's) slash commands and shortcuts, scrolled sideways, tapped to run, with a button to rename, reorder (by dragging, in a vertical list like the session drawer), hide or add. Each tool has its own list; reordering claude's leaves codex's alone. **No automatic ordering**, and no frequent phrases mixed in. In a shell or another program there's nothing to show, so the key is absent.
- The commands must come from the **installed** tool and follow its upgrades: the same day, claude updated itself from 2.1.317 to 2.1.319.

What the tools offer (measured on this machine):

| | claude 2.1.319 | codex 0.166 |
|---|---|---|
| Machine-readable command list | Yes: one of the first lines of `claude -p --output-format stream-json --verbose` is an `init` message whose `slash_commands` lists the available commands (the data the Agent SDK uses); 2.1.319 sends a `system`/`ui_invalidate` line before it | No: the list is only in its TUI's `/` popup |
| Getting it without side effects | With `--bare --strict-mcp-config --no-session-persistence` and the network pointed at a dead port: about 0.8 s, no hooks, no MCP servers, no auto-memory, no transcript, nothing left under `~/.claude/projects`, no usage | Driving its TUI blind is unsafe: an earlier probe nearly picked its "update now" prompt, which runs `curl … \| sh` |
| What's missing | `--bare` doesn't load project or user custom commands (they're read from their files instead) and interactive-only commands such as `/copy` and `/resume` | — |
| Custom commands | `~/.claude/commands/**/*.md`, `<project>/.claude/commands/**/*.md` | `~/.codex/prompts/*.md` (`/prompts:<name>`) |
| Shortcuts | No list in `init`; defaults in the binary, user overrides in `~/.claude/keybindings.json` (`{"bindings": [{"context", "bindings": {"ctrl+o": "<action>"}}]}`) | Documented only |

## Decision

### 1. ⟲ History

- The program in front's own history (as in ADR-0054 §3: claude's `display`, codex's `text`, the shell's history file), **newest first**, each distinct entry once at its latest position, **at most 30**.
- **Multi-line entries are kept**: the row shows the first line and "N lines". Entries over 32 KiB, and claude's placeholders (`[Pasted text #N …]`, `[Image #N]`), are skipped; so are blank ones.
- Tap a row: send it and Enter (bracketed paste, then a separate `\r`, ADR-0027); its ✎: paste without Enter. No editing.
- `GET /api/history?program=<shell|claude|codex>` → `{"items": [...]}`, read on request, nothing kept.

### 2. ⌘ Commands: only for claude and codex

- The key shows only while `program` is `claude` or `codex`; otherwise its cell stays empty, so nothing else moves.
- Tapping it opens the **command strip**: one row just above the extra keys, scrolled sideways, each item a chip with its label; tapping a chip runs it and closes the strip. A fixed ✎ at the right end opens the editor.
- Running an item: **keys** go out on the extra keys' path past sticky modifiers (sequences 120 ms apart, as before); **text** (a slash command or anything added) is sent with Enter or only inserted, per item.

### 3. The editor

A bottom sheet (the drawer primitive) for the tool in front only:

- One row per item in the strip's order: ≡ to drag (the session drawer's drag, ADR-0040), the label with what it sends underneath, 👁 to hide or show.
- Tap a row to edit its label, what it sends, and whether it presses Enter (keys: only the label); items you added can also be deleted.
- **+ Add**: a text item. **Reset**: back to the defaults, on a second tap so a stray one costs nothing. **Refresh** (claude): ask the tool again now.
- Changes save as they're made.

### 4. Where the items come from

**claude**, assembled by the agent for the session in front:

1. **Keys**: webterm's list of claude's shortcuts (⇧Tab mode, Esc Esc rewind, ^O transcript, ^T todos, ^B background, ^R history search, ⌥P model, ^C interrupt, ^J newline, ^G external editor, ^S stash, ⌥T thinking, ^D exit), each tied to claude's action name where it has one. A key the user rebound in `~/.claude/keybindings.json` sends the new key; read on every request.
2. **Built-in commands**: the `init` probe above, run with **the same executable as the claude in front** (its `/proc` exe, or interpreter plus script for an npm install), in webterm's private temp directory, network pointed at a dead port, read until the `init` line (other `system` lines are skipped; any other message before it, or 50 lines without it, is a failure) and then killed, 5 s timeout. `slash_commands` minus `skills` minus names starting with `__`.
3. **Supplement**: `/copy` and `/resume`, which `--bare` doesn't list and webterm's clipboard flow leans on.
4. **Custom commands**: `*.md` under `~/.claude/commands` and the session's `<cwd>/.claude/commands` (recursively; the name is the file name), read on every request.
5. **Skills**: the probe's `skills`, **hidden by default**.

The probe result is cached in memory by the executable's resolved path, which carries the version (`…/claude/versions/2.1.319`): after an upgrade the next request probes again. If the probe fails, the list carries everything else and says so.

**codex**: webterm's list of codex 0.166's keys and slash commands (/model, /permissions, /review, /new, /resume, /fork, /rename, /archive, /delete, /compact, /diff, /mention, /copy, /export, /prompts, /init, /status, /mcp, /logout, /quit), plus `~/.codex/prompts/*.md` as `/prompts:<name>`, read on every request. The list follows webterm releases.

### 5. Your arrangement

- Stored per tool in `~/.config/webterm/commands.json` (0600, written atomically), so every device shares it and it can be edited by hand: `order` (ids), `visible` (id → bool, overriding the defaults), `edits` (id → label / send / enter), `added` (text items).
- The list is: items in `order` first, then everything else in the source's order, at the end. **Nothing is ever ordered automatically**; new commands appear at the end.
- `GET /api/commands?sid=<sid>[&refresh=1]` → the merged list for the session's program; `PUT /api/commands?program=<claude|codex>` saves the arrangement; `DELETE` resets it. Authenticated; writes need the `Origin` check.

### Rejected alternatives

- **Frequency anywhere in ⌘.** The user wants their own order and nothing else.
- **One merged key.** History and commands answer different questions.
- **A fixed list for claude.** It goes stale with every self-update.
- **Parsing the claude binary.** 100 command definitions, 34 hidden or gated, and some (`/review`) not matched by any simple pattern; `init` is the tool's own answer.
- **The probe without `--bare`.** It starts every MCP server and runs SessionStart hooks, plugin ones included, on every probe.
- **Driving codex's TUI.** See Context.
- **Arrangements per device** (`localStorage`). The user arranges once and expects the phone and the tablet to agree.

## Consequences

- ADR-0054 §3–§4 are superseded; §1 (the column) and §2 (`program`) stand. AC-3.24 and AC-3.25 rewritten; [input.md](../../40-frontend/input.md#history-and-commands-ac-324), [http-api.md](../../30-protocol/http-api.md#history), [privacy-history.md](../../60-security/privacy-history.md), E2E-51 rewritten.
- Tests: UT-history-1 (newest first, dedup, 30, multi-line, placeholders), UT-catalog-claude (init parsing, filters, supplement, custom files, keybinding overrides), UT-catalog-codex, UT-arrange-1 (merge: order, appended new items, visibility defaults and overrides, edits, added), IT-commands-1 (the routes, a fake `claude` printing an `init` line, the cache by executable path, store round-trip, reset), E2E-51 (⌘ hidden in a shell, strip, run, editor drag / hide / rename / add, shared across a reload, history newest first with a multi-line entry).
