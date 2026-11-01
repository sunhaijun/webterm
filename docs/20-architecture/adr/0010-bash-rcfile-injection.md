# ADR-0010 Inject shell integration with a temporary rcfile

Status: Accepted (2026-09-06). Superseded by [ADR-0026](0026-agent-holds-terminal-state.md): shell integration was removed entirely; the shell starts by its own rules (default `bash -l -i`) and no rcfile is generated.

## Context

Shell integration was a v0.1 requirement: it fed command history, CWD reporting and automatic input mode switching ([ADR-0007](0007-dual-mode-input.md)).

The usual approach is asking users to add `eval "$(webterm shell-init bash)"` to `~/.bashrc`. That needs manual setup (so installing is no longer "just run it"), leaves the line behind after webterm is uninstalled, and lets the script in the rc file drift from the agent's version.

## Decision

**When starting a session, the agent writes a temporary rcfile and runs `bash --rcfile <path> -i`. Users change no dotfiles.**

```go
cmd := exec.Command("bash", "--rcfile", rcPath, "-i")
```

Argument order matters: bash requires long options before short ones. `bash -i --rcfile <path>` fails with `bash: --: invalid option`, prints usage and exits, so the session never starts.

### Emulating bash's startup semantics

`--rcfile` only applies to **interactive non-login** shells. A login shell reads `~/.bash_profile` and **ignores** `--rcfile`, so we can't just add `-l`. The generated rcfile emulates both modes:

```bash
if [ "$__WEBTERM_LOGIN" = 1 ]; then
    # login mode: walk the profile chain, first file that exists
    [ -r /etc/profile ] && . /etc/profile
    for f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
        [ -r "$f" ] && { . "$f"; break; }
    done
else
    # non-login mode: bashrc only
    [ -r /etc/bash.bashrc ] && . /etc/bash.bashrc
    [ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"
fi

__webterm_install_hooks    # must run after the user's config
```

- **Login mode deliberately doesn't also source `~/.bashrc`.** Almost every `~/.bash_profile` sources it already; one that doesn't reflects real login-shell semantics, which we should respect; and this avoids loading `.bashrc` twice (which duplicates PATH entries and aliases and stacks prompt decorations).
- **Login mode is the default.** Users come from `ssh host`, which gives a login shell. Otherwise PATH set in `~/.bash_profile` would vanish, an unacceptable regression. `--no-login-shell` opts out.

### Hooks go in after the user's config

That's why the code above ends with `__webterm_install_hooks`. It wraps the user's configuration rather than overwriting it:

- `PS1`: add OSC 133 A/B marks around it, keeping the original content.
- `PROMPT_COMMAND`: append our function rather than replace it (bash 5.1+ supports an array form, handled separately).
- `DEBUG` trap: chain an existing trap rather than replace it.

User config may still rewrite `PS1` on every prompt (some theme frameworks do), so the precmd function **re-asserts** the marks every time rather than once at install.

### Integration failures must not affect usability

Everything webterm-specific in the rcfile is wrapped in fault-tolerant functions. A script error (syntax error, bash too old) must never stop the shell from starting: no integration is acceptable, no terminal is not (AC-7.7). Hook installation is wrapped in `{ ... } 2>/dev/null || true`, and the script checks the bash version first (4.4+ for reliable `PS0`; older versions fall back to the `DEBUG` trap plus `PROMPT_COMMAND`).

### Rejected alternatives

- **Ask users to edit `~/.bashrc`.** Breaks "just run it" and leaves residue on uninstall. Kept as a **fallback**: `webterm shell-init bash` prints the script for manual setup in special environments (the user `exec`s another shell, uses containers, or switches user with `su`).
- **Inject via environment variables (`BASH_ENV` / `PROMPT_COMMAND`).** `BASH_ENV` only affects non-interactive shells. An inherited `PROMPT_COMMAND` gets overwritten by the user's `.bashrc`.
- **Write the script into the PTY after start.** Leaves traces on the user's screen, and the timing is unreliable (no way to know when the shell is ready to read).

## Consequences

Positive:

- Zero manual setup; installing stays "scp and run".
- The script is embedded with `go:embed`, so it always matches the agent's version.
- Uninstalling the agent leaves nothing behind.

Negative:

- Every branch of bash's startup semantics must be handled correctly (above), with integration tests (AC-7.3).
- The rcfile is a temporary file:
  - mode `0600`, in the agent's runtime directory rather than `/tmp` (other users on the machine, `/tmp` cleanup policies);
  - deleted when the session ends; files left by an agent crash are cleaned up at the next start;
  - `$BASH_ENV` and other interfering variables are cleared before starting the PTY.
- **It can't follow `exec zsh`, `su` or entering a container inside the session.** Integration stops working there. The agent detects it when no `OSC 1701;hello` arrives within 10 seconds, marks the session `integration: inactive`, and the UI shows a degraded-mode notice (AC-7.6).
