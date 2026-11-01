# ADR-0016 Hot upgrade: hand sessions over through an in-place re-exec

Status: Accepted (2026-09-12). Delivers the fix [ADR-0003](0003-no-tmux.md) left open: pass the PTY fds to the new process and hand over session metadata and ring buffers for a lossless re-exec. The rest of ADR-0003 stands: no tmux, the agent owns the PTY.

Amended by [ADR-0026](0026-agent-holds-terminal-state.md) §6: the idle check in §5 now asks whether the PTY's foreground process group is the shell itself, instead of looking at prompt state. In §2, the OSC parser / termstate state was replaced by terminal emulator state and the snapshot moved to schema 2. A new binary still reads schema 1 (with no emulator state, it feeds the ring buffer into a fresh emulator to approximate the screen); the pre-check refuses to downgrade to an older binary. Amended by [ADR-0034](0034-system-service-oom-priority.md): see §6.

## Context

Sessions die through exactly one mechanism: the shell's controlling terminal is the PTY master fd held by the agent. When the agent exits, the fd closes and the kernel sends the shell `SIGHUP`. So "upgrades keep sessions" is the same as "someone always holds the PTY master fd during the upgrade".

ADR-0003 accepted losing sessions on upgrade because upgrades were rare. In practice, `webterm update` is something you run casually, while sessions hold claude, ssh or long builds. Every upgrade meant clearing the decks first, so upgrades got put off.

The protocol already had half the answer. A reconnect sends `hello{instance_id, resume:[{sid, out_seq}]}`, and the agent replays from the ring buffer by sequence number, byte for byte (AC-2.1). If the upgraded process still recognizes the old `instance_id` and holds the same ring buffers and PTYs, the client's reconnect path works unchanged, with no frontend changes.

## Decision

### 1. In-place re-exec (route A), not a split process

The process replaces its own image with the new binary via `syscall.Exec`. The PID doesn't change, so every session's shell is still its child (`Wait` still collects exit codes). PTY fds and listening sockets are inherited across exec, and session state is passed in an in-memory file (`memfd`). nginx, HAProxy and systemd itself use the same pattern.

```
webterm update / webterm reload / systemctl [--user] reload webterm (SIGUSR2)
        │
old     ① Pre-check: run the NEW binary's `webterm handoff-check` as a child, feed it a
process │    metadata snapshot without buffers, confirm it can read the schema. If not → abort
        │    the upgrade, keep serving, report a clear error (never fall back to a restart)
        ② Freeze: refuse new WebSockets; interrupt each session's readLoop / writeLoop with
        │    read/write deadlines and park them at a safe point; unwritten bytes in the
        │    input queue are carried over as-is
        ③ Snapshot → memfd (memory only, never disk; keeps invariant 3)
        ④ Broadcast a notice ("hot upgrade in progress, sessions kept, reconnecting
        │    shortly"), close all WebSockets
        ⑤ Clear CLOEXEC on ptmx / listeners / memfd,
        │    syscall.Exec(new binary serve …same args… --handoff-fd N)
        ▼                                                           ← same PID
new     ⑥ Rebuild the Manager and every Session from the memfd: os.NewFile reattaches ptmx,
process │    net.FileListener reattaches listeners; ring buffers, sequence numbers,
        │    instance_id and per-client in_ack restored as-is; os.FindProcess(pid) reattaches the shell
        ⑦ Restart readLoop / writeLoop / waitLoop and start serving
client  ⑧ Reconnect → hello with the old instance_id and out_seq → resumed.status = ok
                     → missing bytes replayed
```

What the user sees: the status dot blinks, output resumes a second or two later, and the running vim, claude or ssh is still where it was. The browser doesn't reload; xterm state is untouched.

### 2. What is handed over

| Kind | Contents | How |
|---|---|---|
| Kernel objects | Each session's ptmx fd, HTTP / HTTPS listener fds, the memfd itself | `FD_CLOEXEC` cleared, inherited across exec; the snapshot records only fd numbers |
| Processes | Shell pids | Still children after a same-PID exec; `os.FindProcess(pid).Wait()` collects exit codes |
| Resume core | Ring buffer bytes and `base_seq`, per-client `inQueued` / `inAck`, the Manager's `instance_id` and `nextSID` | Serialized as-is |
| Session metadata | sid, name, cwd, status, exitCode, cols / rows, integration, promptState, helloSeen, createdAt, rcPath | Serialized |
| Parser state | The OSC parser may be mid-sequence (state, number, payload buffer); pendCmd; curCmdID / curCmdAt | Parser state serialized; command ids are SQLite primary keys, valid across processes |
| Input queue | Bytes queued but not yet written to the PTY (with their client id) | Carried over and re-queued in the new process; accounting unchanged |
| Not handed over | Device authorization, pairing, command history, certificate cache, settings | Already in SQLite / on disk |
| Dropped | WebSocket connections, liveness probe state, rate limiters | Rebuilt when clients reconnect; probes re-armed |

Since ADR-0026, the parser row is replaced by the terminal emulator state, and the shell-integration fields are gone along with shell integration. The `handoff.Session` struct is the current list.

The snapshot carries a schema version (`schema: 1`). A new binary must read the previous version; if it can't, the pre-check fails and exec never happens. **The pre-check is this path's safety net**: there's no way back after exec, so every compatibility problem must surface before it.

### 3. Failure policy: abort, never silently fall back to a restart

If the pre-check fails, the memfd can't be created, or exec returns an error: **thaw and keep serving**, state the reason in the log and a notice, and exit `webterm update` non-zero. To accept losing sessions, use `webterm update --force-restart` (ADR-0003's old path: `systemctl restart`). Silently falling back to a restart when unattended would defeat the feature: users would think their sessions were kept and come back to find them gone.

The one window without a safety net: exec succeeds but the new process crashes while restoring. The pre-check catches schema errors up front; for the rest, systemd's `Restart=on-failure` brings the service back (sessions are lost in that case). This narrow window is acceptable.

### 4. Triggers and the control channel

- The agent listens on a local control socket at `<data-dir>/run/agent.sock` (0600), one JSON request line, one JSON response line: `status` (version, pid, generation, session count, busy session count, handoff support) and `reexec`.
- `webterm reload [--when-idle] [--timeout]` sends `reexec` over the socket and returns 0 only once the new process's generation has gone up by one and the version has changed. `--probe` only checks whether the running agent supports handoff; `install.sh` uses it to choose between a hot upgrade and the old path.
- `SIGUSR2` is equivalent to `reexec`. The systemd unit has `ExecReload=/bin/kill -USR2 $MAINPID`, so `systemctl reload webterm` is a hot upgrade.
- `webterm update` and `install.sh`: when the running agent supports handoff, install the binary, redo setcap, then call `webterm reload` instead of `systemctl restart`. When it doesn't (old version) or with `--force-restart`, take the old path and keep the "sessions will close" warning.

### 5. `--when-idle` (route C, done along the way)

`webterm update --when-idle` / `webterm reload --when-idle` wait until every session is idle before acting. A hot upgrade kills nothing, so this matters on the old restart path: at least nothing running gets killed. Originally a session was idle when it sat at a prompt (`promptState != running`), and sessions without working integration counted as idle, with a note in the output. Since ADR-0026, a session is idle when the PTY's foreground process group is the shell itself.

### 6. Not doing

- **No split into a frontend process plus a session host (route B).** B would also survive frontend crashes, but every terminal byte would take an extra cross-process copy, there would be two process lifecycles, and the resume logic would have to move. The pain is upgrades, not crashes. B remains a v0.3+ candidate, and the host would still need this ADR's mechanism to upgrade itself.
- **No promise that sessions survive a reboot.** Shells are OS processes; nothing survives a reboot.
- **An agent crash still loses sessions.** [ADR-0034](0034-system-service-oom-priority.md) makes an OOM kill of the agent unlikely (agent -900, sessions 0, `OOMPolicy=continue`).

## Consequences

- Sessions gain a "frozen" state and export / restore code (a few hundred lines). Every new session field raises the question "does this go into the snapshot?"; the `handoff.Session` struct is that checklist.
- The snapshot schema is a new compatibility surface. Rules: only add fields, never remove them; the new process zero-fills missing fields; incompatible changes bump `schema` and are rejected in `handoff-check`.
- During the freeze window (usually < 100 ms) PTY output piles up in the kernel buffer, and a program writing furiously may block briefly, no different from a network hiccup.
- `--handoff-fd` and `handoff-check` are internal interfaces and stay off the main path of the user docs.
- Code: `internal/handoff` (snapshot types, memfd I/O, pre-check, exec); `internal/session` (`cmd` becomes `*os.Process`; `Freeze` / `Thaw` / `Export` / `Restore`; `Busy`); `internal/ringbuf` (`Export` / `Restore`); `internal/agent` (listener fd export and inheritance, control socket); `cmd/webterm` (`serve --handoff-fd`, `SIGUSR2`, `handoff-check`, `reload`, `update --when-idle --force-restart`); `scripts/install.sh` (probe → reload or restart, `ExecReload`); `deploy/webterm.service`.
- Tests: unit round-trips for ringbuf and handoff. Integration test `TestHandoffByteLevelContinuity`: a real PTY producing output is frozen, exported and restored into a new Manager mid-stream; the serialized result matches the run without a handoff byte for byte, the shell is still alive, and unwritten input is neither lost nor duplicated. E2E-26: the real binary receives `SIGUSR2` and execs in place; the browser only sees a reconnect, output is neither lost nor duplicated, `resumed.status == ok`, and the shell still works.
- Docs: [session-manager.md](../../50-backend/session-manager.md) (hot upgrade handoff), [ring-buffer.md](../../50-backend/ring-buffer.md) (export / restore invariants), [websocket-protocol.md](../../30-protocol/websocket-protocol.md) (`instance_id` survives a handoff), [install.md](../../80-ops/install.md) and [systemd.md](../../80-ops/systemd.md) (upgrades), [acceptance-criteria.md](../../10-requirements/acceptance-criteria.md) AC-2.14, [e2e-scenarios.md](../../70-testing/e2e-scenarios.md) E2E-26, [milestones.md](../../90-roadmap/milestones.md) (lossless upgrades no longer a v0.3+ candidate).
