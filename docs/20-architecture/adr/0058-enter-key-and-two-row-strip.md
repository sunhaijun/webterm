# ADR-0058 ↵ in the last column, a two-row command strip, no history list

Status: Accepted (2026-11-08). Revises [ADR-0057](0057-command-strip-and-history.md): §1 (the history list) is removed and §2's strip becomes two rows; the last key column is now ⌘ (top) and ↵ (bottom). Revises [ADR-0055](0055-webterm-setup.md): the shell history item goes.

## Context

From use of m21 (2026-11-08):

- The user didn't find ⟲ (the history list) useful and asked for it to go, and for ideas on using its cell.
- **The extra keys have no Enter.** With the on-screen keyboard down (reading claude's output, the usual state on a phone), answering claude or codex often needs nothing but arrows and Enter: a permission prompt (`1. Yes / 2. … / 3. No`), a picker (`/model`, `/resume`, Esc Esc's rewind list), "Press Enter to continue". ↑ ↓ and ESC are on the bar; Enter means bringing up a keyboard that covers half the screen, for one key.
- At 393px the one-row strip shows about three chips; the user asked for two rows, filled top to bottom, then left to right.

Other uses of the cell were weighed: a paste key (iOS asks for a second tap on every clipboard read, and the text page already pastes), pinning one command (another layer of configuration), jump to the latest output (PGDN and following already do it), and voice input. For voice the microphone is on the phone: claude 2.1.319's own voice mode records the host's microphone (its message says a remote server has none), so it can't work through webterm, while the phone keyboard's dictation already works on the text page. A built-in recorder, if ever, belongs on the text page next to the paperclip, where drafts are reviewed.

## Decision

### 1. The last column: ⌘ over ↵

```
ESC  /   -   HOME  ↑   END  PGUP  ⌘
TAB CTRL ALT  ←    ↓    →   PGDN  ↵
```

- **↵** (`key-Enter`) is always there, whatever runs in front, like every other key. It sends `\r` on the extra keys' path: sticky ALT makes it `ESC \r` (a newline in claude), CTRL leaves it `\r`. Bottom right is where every phone keyboard has Enter, and it keeps ↓ ↓ ↵ in one row.
- **⌘** (`key-commands`) moves to the top right, next to the strip it opens; as before it's there only while `program` is `claude` or `codex`, otherwise its cell stays empty.
- A tap is a release in place (ADR-0056 §1), so a swipe across ↵ sends nothing.

### 2. The strip: two rows, column by column

- Chips fill **two rows, column by column**: item 1 top left, item 2 under it, item 3 at the top of the next column, and so on. A column is as wide as its wider chip, and both chips stretch to it, so the columns line up and the order reads at a glance.
- It scrolls sideways; ✎ stays at the right end, as tall as both rows.
- The editor's list keeps the same order: its first two rows are the strip's first column.

### 3. No history list

⟲, `GET /api/history` and the agent's history reader are removed. webterm no longer reads any program's history file.

### 4. `webterm setup` loses the shell item

The shell history item (`PROMPT_COMMAND="history -a…"` in `~/.bashrc`, `INC_APPEND_HISTORY` in `~/.zshrc`) only served the list, so it goes, with `webterm setup --shell`. Blocks already added stay; they do no harm, and webterm never edits dotfiles on its own. The installer asks about notifications only.

### Rejected alternatives

- **↵ at the top right.** Keyboards put Enter at the bottom right; there it also sits in the arrows' row.
- **Two independent rows** (items 1, 3, 5… on top, packed tight). The columns don't line up, so the order is hard to follow.
- **Keeping history inside ⌘.** The user wants it gone, and the strip is the tool's commands.
- **The other uses above** (paste, a pinned command, jump to latest, voice).

## Consequences

- AC-3.18 (the keys, now with ↵), AC-3.24 (rewritten: the last column and ↵), AC-3.25 (two rows), AC-1.24 / AC-1.25 (two items), US-3.8; [input.md](../../40-frontend/input.md#the-last-column-ac-324), [keymap.md](../../40-frontend/keymap.md) (↵ with sticky modifiers), [http-api.md](../../30-protocol/http-api.md) (History removed), [privacy-history.md](../../60-security/privacy-history.md), [install.md](../../80-ops/install.md#set-up-claude-and-codex), [troubleshooting.md](../../80-ops/troubleshooting.md), the manual checklist.
- Tests: UT-keys-1 (↵ and ALT ↵), UT-setup (two items), IT-setup-1, E2E-10 (15 keys at a shell, ↵ last; ⌘ absent), E2E-51 (↵, the two-row strip; the history steps go). UT-history-1, IT-history-1 and UT-setup-shell are removed.
