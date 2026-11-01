# ADR-0003 No tmux: the agent owns the PTY

Status: Accepted (2026-09-06). The cost below is narrowed by [ADR-0016](0016-hot-reexec.md) (hot upgrades keep sessions) and [ADR-0034](0034-system-service-oom-priority.md) (the agent is protected from the OOM killer).

## Context

The request said tmux could be used for session persistence if needed. An intermediate design had the agent hold the PTY plus a ring buffer, with tmux as a per-session option. We dropped tmux entirely.

## Decision

**The agent holds each session's PTY directly. No tmux, not even as an option.**

```go
ptmx, _ := pty.Start(cmd)   // the agent holds the master fd
```

Why not tmux:

1. **It adds nothing to persistence.** Recovering from a disconnect needs deltas: the client says "I have N bytes", the server continues from byte N. tmux can't do that: `tmux attach` only redraws the current screen, and `capture-pane` is a snapshot too. The ring buffer and sequence numbers have to be ours anyway, and once they exist tmux's persistence value is zero.
2. **Model clash.** tmux has its own session/window/pane model. Passing it through to the web brings its prefix keys, copy-mode and status bar along, and getting away from copy-mode scrollback is one of webterm's goals. Not passing it through makes tmux a useless layer of indirection.
3. **One more external dependency**, against [ADR-0002](0002-self-contained-binary.md). tmux versions on target machines (1.8 to 3.x behave quite differently) would be a permanent source of support noise.
4. **Even an option costs.** Per-session tmux means two code paths, two test suites and two sets of failure modes, for an edge case.

## Consequences

Positive:

- Simple model: a session is one PTY plus one ring buffer, nothing nested.
- No external dependency, no version compatibility matrix.
- One code path.

Negative (accepted): **if the agent process exits, every session dies.** The agent holds the PTY master fd. When the agent dies, the shell on the slave side gets `SIGHUP` and exits. With tmux, sessions would survive upgrades and server restarts.

This is accepted because network drops and process restarts happen at very different rates:

| | Frequency | webterm |
|---|---|---|
| Network drop | Many times a day | Fully handled: incremental resume, the user just sees the status dot blink |
| Agent restart | On upgrade, rarely | Sessions lost |

The real pain is the first one. Bringing in tmux for the second is a mismatch.

Mitigations:

- Before an upgrade the UI says how many sessions will close.
- On `SIGTERM`, `webterm serve` first broadcasts `notice{level:"warn"}` to all clients and waits 2 seconds before closing, so users at least know what happened.

Since then:

- [ADR-0016](0016-hot-reexec.md) hands PTY fds, ring buffers and session metadata to the new binary through an in-place re-exec, so upgrades no longer lose sessions. The cost above now applies only to real process restarts: `SIGTERM`, crashes, reboots.
- [ADR-0034](0034-system-service-oom-priority.md) handles the OOM half: running as a system service under a regular user, the agent gets an OOM score adjustment of -900 and sessions get 0, so under memory pressure the 8 MB agent is no longer picked first and takes every session down with it.

Users can still run `tmux` inside a webterm session themselves. webterm just doesn't manage it.
