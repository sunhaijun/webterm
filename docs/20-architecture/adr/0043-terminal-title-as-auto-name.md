# ADR-0043 Use the terminal title set by the foreground program as the session's automatic name

Status: Accepted (2026-10-31). Extends AC-4.4's automatic naming rule. The protocol wire format is unchanged; `name` just has one more source.

## Context

The automatic name was the CWD's basename. The main use case is several sessions in one project running claude / codex, and they all get the same name. Session numbers tell them apart ([ADR-0041](0041-tab-index-and-edit-icon.md)), but not what each is doing.

The programs say so themselves, through the terminal title (OSC 0 / OSC 2). Measured with a pty against claude 2.1 (`TERM=xterm-256color`, proxy pointed at a dead port so no usage is spent):

```
 2.19s  OSC0 '✳ Claude Code'      started, idle
 8.37s  OSC0 '◐ Claude Code'      after submitting: ◐ / ◑ alternate about once a second (working)
  …
20.40s  OSC0 '✳ Claude Code'      back to idle
```

`✳` / `◐◑` mean "waiting for you" / "working", which is exactly what you want to know with several claudes open. (Once a conversation has a topic, claude replaces the title with the topic; that can't be reproduced offline and wasn't measured.)

But titles can't be taken at face value. Debian's default `.bashrc` sets the title at **every prompt** (`\e]0;\u@\h: \w\a` in `PS1`), producing titles like `user@hostname: ~/github/webterm`. Taking every title would put that string on every tab, with the hostname eating the 120–240px tab.

## Decision

### 1. Name sources, in priority order

```
name = manual name                            (nameManual)
     ?? title set by the foreground program   (see §2)
     ?? basename of the CWD (home → ~, / → /)
     ?? "shell"
```

`name_is_manual` means the same as before: only a name set by the user is manual.

### 2. Only titles set by the current foreground program, and not by the shell itself

- A title **belongs to the foreground process group at the time it was set**. The agent polls once a second (the same poll that reads the CWD): it reads the foreground process group, the emulator's title, and a counter of how many times the title has been written. When the counter changes, the title is recorded as belonging to the current foreground process group.
- The title is used only when **the foreground process group == the title's owner, and ≠ the shell itself (the shell's pid)**. As a result:
  - titles the shell sets at the prompt (`user@host: dir`) aren't used, because their owner is the shell;
  - when the program exits and the prompt returns, the name goes back to the directory;
  - when the same program starts again, the previous title isn't reused until the new process sets one (the owning process group is no longer the foreground). Judging "has set a title" by write count rather than content means a new process setting an identical title is still recognized.
- After `ssh` to another host, the remote shell's `user@remote: dir` is used (locally the foreground is ssh, not the shell). There it usefully says which machine you're on.
- Sampling once a second adds no system calls to the output hot path.

### 3. Titles are shown as is, only sanitized

- Strip control characters (C0, DEL, C1) and surrounding whitespace, and cap at 64 characters. A title that's empty after sanitizing counts as unset.
- **Don't rewrite the content**: claude's `✳` / `◐` prefix stays; it's the busy/idle signal.
- Send `session.updated{name}` only when the name changes (combined with a `cwd` change into one message). claude flips `◐ ↔ ◑` every second while working, so each working session sends at most one message per second, the same order as `head_seq` throttling.

### 4. Across hot upgrades

The emulator's exported state already includes the title. In addition, the "currently used title" and "the process group that owns it" go into `internal/handoff.Session` (`title`, `title_pgrp`), so after an upgrade the name doesn't flash back to the directory until the program next sets its title. The write counter isn't handed off: the new process's emulator starts counting from the imported state, and both sides start from 0.

### 5. Inside tmux

By default tmux doesn't pass titles set by programs in a pane to the outer terminal. The foreground is tmux, there's no title, and the name stays the directory. To see claude's title, add to `~/.tmux.conf`:

```
set -g set-titles on
set -g set-titles-string '#T'   # the current pane's title
```

Documented in [troubleshooting.md](../../80-ops/troubleshooting.md#tab-name-doesnt-follow-claudes-title). webterm doesn't change the user's tmux config.

### Rejected alternatives

- **Use xterm.js's `onTitleChange` in the browser.** The client only subscribes to the current session, so titles from background sessions never reach the browser, and those are exactly the names that matter most.
- **Combine title and directory** (`✳ Claude Code · webterm`). A 120–240px tab can't fit both; the directory is already in the drawer's path column and the tab's `title` tooltip.
- **Use the foreground process name** (`/proc/<pgrp>/comm`). That only yields `claude`, so all claude sessions still share a name, with no busy/idle signal.
- **Use titles set by the shell.** See Context: the `user@host: ` prefix fills the tab. Stripping prefixes by content is guesswork that breaks with any other `PS1`.
- **Strip prefixes like `✳` / `◐` and keep only the text.** That throws away the most useful signal, the busy/idle state, and the agent shouldn't rewrite program output (the spirit of invariant 4).

## Consequences

- AC-4.4, the protocol's `session.rename` / `session.updated` sections, session-ux.md (automatic naming) and session-manager.md (struct, polling, automatic naming, handoff list) are updated.
- Tests: UT-vterm title and write counter; UT-name-2 title sanitizing; IT-session-6 title ownership (shell titles ignored, program titles used, back to the directory on exit, no reuse on restart, manual name wins); a handoff test asserts the title survives an upgrade; E2E-41 ⑪.
