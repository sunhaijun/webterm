# ADR-0055 `webterm setup`: check and add the settings claude, codex and the shell need

Status: Accepted (2026-11-07). Adds the `webterm setup` command and the installer's `--setup` / `--no-setup`. Revises [ADR-0052](0052-waiting-for-you-replaces-unread.md) §6 and [ADR-0054](0054-frequent-input-and-combo-keys.md) §3, which said webterm doesn't change the user's configuration: it still never does on its own, only through this command, with consent.

## Context

"Waiting for you" (ADR-0052) and frequent input (ADR-0054) work best with three settings in other programs' files:

| Program | Setting | Without it |
|---|---|---|
| claude | `"preferredNotifChannel": "terminal_bell"` in `~/.claude/settings.json` | Turns that end are still seen through the title (`◐` → `✳`), but a permission prompt rings nothing |
| codex | `[tui]` `notifications = true`, `notification_condition = "always"` in `~/.codex/config.toml` | codex sends nothing webterm can see when a turn ends |
| bash | `PROMPT_COMMAND="history -a…"` in `~/.bashrc` (zsh: `setopt INC_APPEND_HISTORY`) | Commands reach the history file only when the shell exits, so frequent input lags by days |

So far the docs told the user to add them by hand, and one instruction was wrong: claude 2.1.317 has no `claude config set` any more. Its settings schema lists `preferredNotifChannel` as a user setting in `~/.claude/settings.json`, which wins over the old global config. The user asked for the installer to set these up, and for a command that checks and adds them at any time.

## Decision

### 1. The command

```
webterm setup            show what's set and what would be added; ask once, then add
webterm setup --yes      add without asking
webterm setup --check    only report; exit 0 when nothing is missing, 1 otherwise
```

- Each item shows one state: **ok**, **add** (what will change, in which file), **left as is** (the user chose another value, named), or **skipped** (the program isn't installed).
- Without `--yes`, it asks `Add these? [Y/n]` on the terminal; with no terminal it adds nothing and says to run it with `--yes`.
- Running it again changes nothing: every item checks before it writes.
- **Edits are minimal and textual**: one or two lines inserted where they belong; the rest of the file keeps its bytes, order and comments. No JSON or TOML library rewrites the file.
- **Safety**: before the first change to a file it's copied to `<file>.webterm-bak` (`<file>.webterm-bak-<time>` when that exists already); the new content is checked (JSON parses, the inserted TOML lines sit in the `[tui]` table) and written atomically with the file's mode kept. A file that doesn't parse is left alone and reported.
- The shell is the session shell: `--shell`, else `shell` in the config file, else bash, the same as `serve`.

### 2. The items

| Item | When | Change | Left as is when |
|---|---|---|---|
| claude notifications | `~/.claude` exists | `"preferredNotifChannel": "terminal_bell"` added to `~/.claude/settings.json` (created as `{}` if missing), or `"auto"` replaced | It's set to anything but `auto`: `iterm2` / `kitty` / `ghostty` send OSC 9 / 99 / 777, which webterm also counts; `notifications_disabled` is a choice |
| codex notifications | `~/.codex` exists | `notifications = true` and `notification_condition = "always"` under `[tui]` in `~/.codex/config.toml` (the table is appended if missing) | Either key is already there, with any value |
| shell history | the session shell is bash or zsh | A block between `# >>> webterm >>>` and `# <<< webterm <<<` at the end of `~/.bashrc` (`PROMPT_COMMAND="history -a${PROMPT_COMMAND:+;$PROMPT_COMMAND}"`) or `~/.zshrc` (`setopt INC_APPEND_HISTORY`) | bash: `history -a` already appears in `.bashrc`; zsh: `INC_APPEND_HISTORY` or `SHARE_HISTORY` already does |

`notification_condition = "always"` rather than codex's default `unfocused`: "unfocused" depends on focus reports, which a background webterm session may not get. A notification while you're looking is cleared at once anyway (ADR-0052 §2).

### 3. The installer

- On a **first install**, after the service is up and before the pairing code, the guided install asks `Set up claude, codex and your shell for webterm (notifications, frequent input)? [Y/n]` on the terminal and runs `webterm setup --yes`.
- `--setup` answers yes without asking, on any install or upgrade; `--no-setup` skips the question. Without a terminal and without `--setup`, it's skipped with a one-line hint (`webterm setup`).
- Neither flag goes into install-state: `webterm update` replays install-state and must never touch dotfiles.
- `--dry-run` prints `webterm setup --check` instead of changing anything.

### Rejected alternatives

- **The agent sets them on start.** Changing other programs' files without being asked.
- **`claude config set`.** Gone in claude 2.1.317.
- **`~/.claude.json`.** claude rewrites it all the time, and `settings.json` wins over it.
- **Rewriting the files through JSON / TOML libraries.** Reorders keys, drops comments and formatting, and adds a dependency.
- **Asking on every `webterm update`.** Upgrades should be quiet; the command is there whenever you want it.

## Consequences

- AC-1.24 (the command), AC-1.25 (the installer); [install.md](../../80-ops/install.md#set-up-claude-codex-and-the-shell) gains a section and the option rows; [troubleshooting.md](../../80-ops/troubleshooting.md) points to `webterm setup --check` and drops the wrong `claude config set`; ADR-0052 §6 and ADR-0054 §3 get notes.
- Tests: UT-setup-claude, UT-setup-codex, UT-setup-shell (add, idempotent, respect the user's value, backups, formatting kept, unparseable files untouched), IT-setup-1 (the command with a temporary `HOME`: `--check` exit codes, `--yes`, a second run changes nothing, no terminal adds nothing), UT-install-setup (`--setup` runs `webterm setup --yes`, `--no-setup` and no terminal skip it, install-state doesn't keep either).
