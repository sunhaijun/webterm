# ADR-0012 Conversation-first reading and writing for claude / codex

Status: Accepted (2026-09-09). Revises the "bottom bar" and "enter control automatically" rules of [ADR-0011](0011-read-first-layout.md). Mobile display surface superseded by [ADR-0013](0013-terminal-only.md): the terminal became the only display surface, and the block stream, transcript view and view switching were removed.

## Context

The user runs Claude Code and Codex CLI through webterm on a phone (iOS Safari), often on a slow network. Measured on a matching viewport (Pixel 5, 393×727, 14 px → 43 columns × 39 rows), the problems come down to two; everything else is a means to them:

1. **Reading**: scrolling back through long answers must be smooth, even on a slow network. xterm's touch scrolling isn't native scrolling: it converts scroll events into a number of lines and redraws the whole canvas, so it jumps line by line. claude / codex redraw spinners and timers several times a second (codex also redraws the full screen with synchronized output), so the stream is a constant redraw storm that lags and tears on slow links. **As long as you read in the terminal, it can't be smooth and can't save bandwidth.**
2. **Writing**: long prompts need to be editable like a normal text box. Typing in the terminal goes through xterm's hidden textarea and waits for each keystroke to echo, which is unusable on slow networks, and iOS IMEs barely work on that path. The old per-keystroke direct input line had the same problem.

Verified at the time: both CLIs enable bracketed paste (`?2004h`) and the Kitty keyboard protocol, and neither used the alternate buffer. Claude Code's session JSONL (`~/.claude/projects/<cwd-slug>/*.jsonl`) has one line per content block, with complete Markdown text, flushed as each block completes. Codex's rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) stores assistant messages as `output_text`.

## Decision

1. **Read = the conversation transcript.** The agent tails both CLIs' session files and pushes user / assistant messages to the page as small JSON messages. The read view renders them as native Markdown cards (full-width text, horizontally scrolling code blocks with copy, native scrolling / selection / zoom). Below the cards sits a **terminal tail strip** (the last few lines of the xterm buffer as plain text, throttled) showing spinners, permission prompts and menus; answer with the key bar, or tap it to open the terminal view. Traffic is just the text, independent of terminal width.
2. **Write = local editing in the Composer.** The Composer no longer hides while a command runs. Submit = `xterm.paste()` of the whole text (wrapped according to the foreground program's bracketed paste mode, newlines converted to CR) plus Enter; long-press Send = paste without Enter. The per-keystroke input line is removed.
3. **View rules.** Keyboard-protocol programs like claude / codex **stay in the read view**; only alternate-buffer programs (vim / less / top) enter the terminal automatically. The terminal view is the fallback.
4. **Slow-network relief.** The agent recognizes codex's synchronized-output frames and, when the send queue backs up, keeps only the latest frame (a full frame can be dropped; the next one repaints the same area). claude's spinner traffic is a few KB/s; left alone for now.
5. **Cleanup.** Removed: the direct input line and its per-key mapping, the "view in terminal" link on blocks (replaced by the transcript view), entering the terminal automatically on keyboard protocols. Kept: screen-ownership detection (for key bar context and whether to show the transcript view), a compact AI key bar (`Esc ^C Enter ⇧Tab / ↑ ↓ Tab Ctrl`), and no "no integration" banner inside full-screen programs.

Rejected alternatives:

- **Client-side DOM snapshot** (serialize the xterm buffer to HTML for reading): smooth scrolling, but the content is still a 43-column picture, bandwidth is unchanged, and slow-network tearing ends up in the snapshot.
- **mosh-style server-side terminal state sync**: bounded bandwidth and no tearing, but it needs a terminal emulator inside the agent, the heaviest option. Not now. ([ADR-0026](0026-agent-holds-terminal-state.md) later put an emulator in the agent for resume.)
- **Widen the PTY to 80 columns**: less wrapping of code; revisit once the transcript view ships.
- **Local paging keys, copy-screen, a collapsible key bar, a "new output" pill**: all patches for reading in the terminal, replaced by the transcript view.

Rollout:

| Slice | Scope |
|---|---|
| α | Frontend: Composer sends the whole text + long-press paste-only; remove the direct input line; AI key bar; banner fix (shipped with this ADR) |
| β | Agent: tail session files → `transcript` messages; `GET /api/transcript`; Go unit tests on real samples |
| γ | Frontend: transcript view + terminal tail strip; view rules; remove the link; E2E with a fake `claude` writing a temporary JSONL |
| δ | Agent: drop stale codex synchronized-output frames |

## Consequences

- Reading and writing for AI CLIs left the terminal entirely: Markdown cards for reading, the Composer for writing.
- webterm became coupled to two CLIs' private session file formats, which change with their versions. Together with the cost of two display surfaces and automatic view switching, this led [ADR-0013](0013-terminal-only.md) to remove the transcript view and keep only the terminal.
