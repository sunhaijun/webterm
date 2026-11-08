# Privacy

> Status: Accepted

webterm keeps no command history (removed entirely by [ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md)) and stores no terminal output. This page defines the boundary.

The history list ([ADR-0057](../20-architecture/adr/0057-command-strip-and-history.md)) reads the programs' **own** history files (`~/.claude/history.jsonl`, `~/.codex/history.jsonl`, the shell's history) when you open it, and returns at most 30 entries to the page. The agent keeps no copy and logs nothing about them; the page keeps the last list in memory only.

The command strip stores only your **arrangement** of commands (order, labels, hidden items, text you added) in `~/.config/webterm/commands.json`, 0600: configuration you wrote, not output. To list claude's commands the agent runs the same claude executable you run, as you, with `--bare --no-session-persistence`, the network pointed at a dead port, and stops it after its first line: nothing is sent anywhere and claude records no session.

## The rule: terminal output never touches disk

**Terminal output lives only in memory: each session's ring buffer and terminal emulator. It is never written to disk under any circumstances, and the browser doesn't store it either.**

Why: terminal output contains

- the results of `cat .env`, `env`, `kubectl get secret -o yaml`
- tokens, session ids and connection strings in logs
- URLs printed by `git push` (which may include a token)
- conversations with AI agents

Once on disk, all of this becomes a long-lived leak. So the choice is: **in memory, or nowhere.**

This is invariant 3 in [CLAUDE.md](../../CLAUDE.md) (output never touches disk).
Verified by `IT-privacy-1`: a session prints a marker string `WEBTERM_CANARY_<random>`, then the test greps the whole data directory and the logs and asserts zero hits.

### Consequences

- **After an agent restart, earlier output is gone.** That follows directly from sessions not being persisted ([ADR-0003](../20-architecture/adr/0003-no-tmux.md)); the two decisions reinforce each other.
- **A hot upgrade isn't a restart**: emulator state reaches the new process through an in-memory file ([ADR-0016](../20-architecture/adr/0016-hot-reexec.md)), never through the disk.
- **Scrollback after a page reload comes from the agent's snapshot** (up to 2000 lines); the browser keeps no terminal content locally.
- There is no session recording. If one is ever built, it must be an explicit opt-in with clear disclosure in the UI and its own file permissions, and off by default.

## What is stored on disk

`webterm.db` holds only devices and pairings (tokens and pairing codes stored as hashes only) and settings ([storage-schema.md](../50-backend/storage-schema.md)). No command text, no CWD, no output.

Files the user sends to a session (images for claude, logs, PDFs) are the one other thing on disk, and not in the data directory: they live in `<temp>/webterm-<uid>/uploads/` (`0600`, directory `0700`) and are deleted 24 hours after upload, oldest first once they pass 256 MiB ([ADR-0051](../20-architecture/adr/0051-send-files-to-a-session.md) §5). Where `/tmp` is a tmpfs they stay in memory too. They are never served back, and their names don't appear in logs.

## Logs (AC-8.5)

Agent logs **must not contain**:

- pairing codes (in any form, including prefixes)
- session cookie tokens
- user input (the contents of INPUT frames)
- terminal output

**May contain** (on purpose):

- IP and User-Agent — needed for the device list and rate limiting
- session sid, byte counts, seq — essential for troubleshooting
- error codes and stack traces

The log level defaults to `info`. `--log-level debug` prints more protocol detail, but **still never prints anything forbidden above** — debug mode is not a security bypass.

## Data directory permissions

```
$XDG_DATA_HOME/webterm/    0700
├── webterm.db             0600
├── certs/                 0700
└── run/                   0700   (control socket agent.sock 0600)
```

Other local users on the same machine are outside the trust boundary ([`threat-model.md`](threat-model.md#trust-boundaries)).

## Backups are up to the user

webterm doesn't back anything up. `webterm.db` is a single file you can `cp` yourself (preferably run `sqlite3 webterm.db ".backup"` first, or stop the service, to avoid an inconsistent WAL state). It only holds device and pairing hashes; losing it means pairing every device again.
