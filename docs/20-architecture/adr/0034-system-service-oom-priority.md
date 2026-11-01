# ADR-0034 Run as a system service (as a regular user) so the agent isn't OOM-killed before its sessions

Status: Accepted (2026-10-31). **Revises** the scope of [ADR-0003](0003-no-tmux.md)'s negative consequences and of [ADR-0016](0016-hot-reexec.md) §6 ("a crash of the agent itself still loses sessions"). **Overturns** [systemd.md](../../80-ops/systemd.md)'s "recommended: user service + setcap" and "system service (not recommended)". Unchanged: no tmux, and the agent holds the PTYs itself (ADR-0003); the agent and all sessions run as a regular user ([threat model](../../60-security/threat-model.md)).

## Context

With ADR-0016 in place, sessions are lost only when the agent process actually dies. On one production host (3.8 GiB RAM plus 2 GiB swap), the kernel OOM killer killed webterm.service **9 times** in about seven weeks, 4 of them on a single day. Each time the agent died, every session's shell got `SIGHUP`.

Over the same period, none of the user's claude / codex processes running in tmux were lost. Not because tmux uses less memory, but because the OOM killer ranks them later:

| Process | cgroup | `oom_score_adj` |
|---|---|---|
| webterm (28 MB) and all its sessions | `user@1000.service/app.slice/webterm.service` | **200** |
| tmux server (started from SSH) | `session-21.scope` | 0 |
| tmux panes (claude and others) | `user@1000.service/tmux-spawn-*.scope` | 0 |
| sshd | system service | -1000; forked session processes reset to 0 |

The OOM score is roughly "share of memory × 1000 + `oom_score_adj`". With 5.8 GiB of RAM plus swap, a 300 MB claude is worth only about 50 points, and the +200 bias swamps it. So **an 8 MB agent is picked before a 300 MB claude**: in the four kills on that one day, the whole webterm unit peaked at only 8–28 MB.

The 200 comes from systemd's design. PID 1 sets the user manager (`user@.service`) to 100, and the user manager gives its services `DefaultOOMScoreAdjust=200`. The intent is to kill user services first under memory pressure and spare login sessions. As a user service, webterm is in the first batch by design.

**And it can't be lowered.** Kernel rule: without `CAP_SYS_RESOURCE`, a process may raise `oom_score_adj` freely, but may only lower it down to `oom_score_adj_min`, which is the last value written **with privilege** and is inherited across fork. The user manager's floor is the 100 written by PID 1, so nothing beneath it can go below 100. Measured: inside a webterm session, lowering from 200 to 100 succeeds; to 0 is refused.

**There's a second problem.** Services default to `OOMPolicy=stop`: if the OOM killer kills any process in the unit, systemd stops the whole unit and every session dies with it. All session processes inherit the 200, and big ones like claude, `go build` or the Chromium launched by Playwright are prime targets.

## Decision

### 1. A system service, running as a regular user

The unit lives at `/etc/systemd/system/webterm.service` with `User=` / `Group=` set to the installing user. root is used only during installation (writing the unit and setcap, which already needed sudo). The agent and all sessions still run as the regular user.

PID 1 writes `oom_score_adj` as root **before** switching users, so a system service can use any value. That value also becomes the agent's floor; above it, the agent can raise and lower freely.

### 2. The agent at -900, sessions at 0 (as sshd does)

```ini
OOMScoreAdjust=-900
OOMPolicy=continue
```

- **The agent itself at -900**: it's picked only after every ordinary process. Not -1000 (never kill), so that if the agent really leaks, the kernel still has a last resort. A healthy agent is a few tens of MB: one ring buffer and one emulator per session, both bounded.
- **Session shells start at 0**, like tmux panes and SSH logins. Under memory pressure, session programs compete fairly with other interactive processes on the machine; user services (200) are still killed first.
- **`OOMPolicy=continue`**: when a session process is OOM-killed, only that process dies and the unit keeps running. If the agent's main process is killed (very rare at -900), the unit fails, `Restart=on-failure` restarts it, and sessions are lost. That narrow window is treated like ADR-0016 §3.

### 3. Starting the shell at 0

The shell must be at 0 **before it runs any user code**. A login shell reading `~/.profile` may start long-lived processes (ssh-agent, keychain); if they inherit -900 they're protected forever. So writing `/proc/<pid>/oom_score_adj` after the shell starts is too late.

Instead, the agent temporarily sets itself to 0 around the fork:

```
for each shell start:
    lock spawnMu
    read own oom_score_adj as self
    self >= 0: do nothing (webterm serve run by hand, or a user service without sudo); the child inherits as usual
    self <  0:
        write /proc/self/oom_score_adj = 0
        pty.StartWithSize(...)                 // the child inherits 0 at fork
        write /proc/self/oom_score_adj = self  // self is not below the floor, so no privilege needed
    unlock
```

- `oom_score_adj` is per process and shared by all threads, so it doesn't matter which thread Go forks from.
- Restoring must wait until the child has exec'd. Go starts children with `CLONE_VM|CLONE_VFORK`, and the kernel propagates `oom_score_adj` changes to processes sharing the same mm. `cmd.Start` returns only after the child exec succeeds, so restoring after it returns is safe.
- The window lasts microseconds, during which the agent itself is at 0. Any other child forked in that window (such as the `handoff-check` preflight) also gets 0; it's just less protected, which is harmless.
- If restoring fails (it shouldn't), log a warning and leave the agent at 0. That's the same treatment tmux gets; the service is unaffected.
- On hot upgrade (ADR-0016), `oom_score_adj` and its floor survive `execve`, so the new process starts at -900; handed-off shells are already at 0. So this is **not** part of the `handoff.Session` snapshot.
- No flag: the agent looks only at the value it started with and switches only when it's negative.

### 4. Carry the user systemd environment explicitly

A system service isn't under the user manager and doesn't get its environment. systemd sets `HOME` / `USER` / `LOGNAME` / `SHELL` from `User=`; `PATH` and `LANG` match the user manager's, both coming from system defaults and `/etc/locale.conf`. Two variables are missing, and without them `systemctl --user`, `journalctl --user` and anything using D-Bus fail inside sessions:

```ini
Environment=XDG_RUNTIME_DIR=/run/user/<uid>
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus
Wants=user@<uid>.service
After=user@<uid>.service
```

install.sh writes `<uid>` as a literal: `%U` in a system unit is PID 1's UID (0) and doesn't follow `User=`. `Wants=` / `After=` ensure `/run/user/<uid>` and the user bus exist before the agent starts. Lingering is still enabled; the user's other user services rely on it.

Other variables added to the user manager via `environment.d` / `import-environment` (such as `SSH_AUTH_SOCK`) don't come along. Sessions are login shells (`-l`), so put what you need in `~/.profile`.

### 5. Install, upgrade and migration

- **install.sh only generates a system service.** Writing the unit, `daemon-reload`, `enable`, start and restart use `sudo systemctl`; checking status uses `systemctl is-active webterm`, which needs no privilege.
- **Hot upgrades need no sudo.** `webterm reload` goes through the control socket (ADR-0016 §4), regardless of which systemd manages the unit. `sudo systemctl reload webterm` does the same.
- **Machines already running a user service (migration).** Moving from the user manager to PID 1 means a new process; a hot handoff can't cross that, so the migration necessarily closes all sessions. Following ADR-0016 §3 ("never silently degrade to a restart"):
  - When `webterm update` / install.sh finds **the user service running** and `--force-restart` isn't given, it only replaces the binary, redoes setcap, and **hot-upgrades the user service as before**. The unit file isn't touched (port or domain changes wait for the migration). Finally it prints the migration command and its cost.
  - With `--force-restart` (which already means "losing sessions is OK"), or when the user service **isn't running** (no sessions to lose), it migrates: stop, disable and delete the user unit → write the system unit → start → confirm active. The order can't be reversed: both would compete for the same port.
  - `webterm update` defaults to `--if-newer` and does nothing when the version is unchanged. But a pending migration with `--force-restart` is not "nothing to do"; it migrates anyway.
  - **Refuse to migrate from inside a webterm session.** Stopping the user service kills the session running the script, leaving the migration half done: the user unit is stopped and the system unit isn't written. The script checks whether `/proc/self/cgroup` is inside `webterm.service`, and if so errors out and asks the user to rerun from SSH. It doesn't check `$WEBTERM_SESSION`, because tmux panes move to their own scope (stopping webterm won't kill them) while the variable may have been inherited from a webterm session.
- **Machines without sudo** can't install the service; writing `/usr/local/bin` and setcap already need sudo. systemd.md keeps a section on writing a user service by hand, explains the cost of the 200 priority, and recommends `OOMScoreAdjust=100` (the lowest a user service can reach) and `OOMPolicy=continue` in the unit.

### 6. Follow-up changes

- `webterm status`: ask the system unit first, then the user unit (for machines not yet migrated), and only then fall back to probing `/healthz`.
- Hint text mentioning `systemctl --user` / `journalctl --user` (reload.go, update.go, status.go, install.sh) follows the actual unit type.
- Uninstall: `sudo systemctl disable --now webterm`, then delete `/etc/systemd/system/webterm.service`.

### Not doing

- **Run the agent as root.** It could set any `oom_score_adj`, but every session would be a root shell. Exposing root shells to the internet for a memory priority makes no sense.
- **Change the user manager's priority** with a drop-in that sets `user@<uid>.service` to 0. webterm would tie with tmux, but that changes the user's entire user manager, which an installer has no business touching. And with a floor of 0, the agent couldn't be ranked after its sessions.
- **Use `AmbientCapabilities=` instead of setcap.** Under a system service this would avoid redoing setcap on every binary swap, but ambient capabilities are inherited by session shells: they'd have to be cleared on every thread (`AllThreadsSyscall`), and the new image after a hot upgrade wouldn't have them. Deferred.
- **Split into a front process and a session host** (ADR-0016's option B). The host would be picked by the OOM killer just the same; the problem is the priority, not the number of processes.
- **Promise sessions survive OOM.** When memory is truly exhausted the kernel still kills the largest process in a session, tmux or not. The guarantee is only that a small agent is no longer picked and takes every session down with it.

## Consequences

- Install, migration and uninstall need sudo. Upgrades already did, for setcap.
- install.sh gains a migration path, used only when a user service exists; it can be deleted once existing machines have migrated.
- Session processes don't belong to any logind session (not visible in `loginctl`). That was already true of the user service.
- Logs move from `journalctl --user -u webterm` to `journalctl -u webterm`. Regular users can still read the agent's own logs; systemd's lifecycle records need sudo (measured below).

### Measured (2026-10-31, Debian 13 / systemd 257 / tmux 3.5a)

A transient system unit started with `sudo systemd-run`, with the properties from §2 and §4 (a regular `User=`, `OOMScoreAdjust=-900`, both environment variables), plus `MemoryMax=300M` to force an OOM:

| Check | Result |
|---|---|
| `HOME` / `USER` / `LOGNAME` / `SHELL` | Set from `User=`; `PATH` and `LANG` match the user manager |
| §3's switch | Starts at -900; set to 0 → the forked child is 0; **restoring -900 without privilege succeeds**; setting -950 is refused |
| `systemctl --user` / `journalctl --user` in a session | Work |
| `systemd-run --user --scope` in a session | Works; the process moves into `user@1000.service/app.slice/run-*.scope` |
| tmux panes | Still move into `tmux-spawn-*.scope`; **the tmux server stays in webterm's cgroup**, so a tmux server started inside webterm still stops with webterm (same as before) |
| Child allocates 400M and is OOM-killed | `OOMPolicy=continue`: child exits 137, main process survives; `OOMPolicy=stop`: main process is killed too |
| Regular user runs `journalctl -u webterm` | Sees **the agent's own log lines** (stored per UID in the user's journal); **doesn't see systemd's records about the unit** ("killed by OOM", "Failed with result"), which are in the system journal and need `sudo` or the `adm` group |

The last row is a regression from the user service, whose lifecycle records were in the user journal. The troubleshooting doc must say that checking for OOM kills needs `sudo journalctl -u webterm`, or `systemctl show webterm -p NRestarts` (no privilege needed).

### Docs, code and tests

- **Docs**
  - [systemd.md](../../80-ops/systemd.md): system service becomes the recommended form with a complete unit; a new "OOM priority" section (a condensed version of this ADR's context); delete "system service (not recommended)"; the user service becomes the "no sudo" option; status, log and upgrade commands rewritten.
  - [install.md](../../80-ops/install.md): script steps, upgrade (including migration), uninstall, "about sudo".
  - [troubleshooting.md](../../80-ops/troubleshooting.md): "all sessions gone after an upgrade/restart" gains OOM and how to check (`oom-kill` in the journal), and why unmigrated machines can still hit it.
  - ADR-0003 negative consequences and the last item of ADR-0016 §6: add a note pointing here.
  - [acceptance-criteria.md](../../10-requirements/acceptance-criteria.md): adds AC-2.24 (AC-2.16–2.23 were already taken by `feat/40-no-settings`): "**The agent is not OOM-killed before its sessions**: in the service installed by install.sh, the agent's `oom_score_adj` is -900; session shells and their children start at 0, including processes started while a login shell reads its profile; both survive a hot upgrade; when a session process is OOM-killed, the unit keeps running and other sessions are unaffected."
  - [manual-checklist.md](../../70-testing/manual-checklist.md): one new item: after migrating, create memory pressure with `stress-ng --vm` and see what gets killed. It needs root and disturbs the whole machine, so it isn't automated.
- **Code**
  - `deploy/webterm.service` becomes a system unit template.
  - `scripts/install.sh`: generate the system unit, use `sudo systemctl`, migration path, status checks; new `--print-unit` prints the unit it would write.
  - `internal/session`: switch `oom_score_adj` when starting a shell (§3).
  - `cmd/webterm`: detection logic and messages in status.go / reload.go / update.go.
- **Tests**
  - UT-oom-1: §3's switching logic with injected `/proc` reads and writes. With self < 0 the order is 0 → start → self; with self ≥ 0 nothing is touched; a failed restore only logs, never errors; concurrent session starts are serialized.
  - IT-oom-1: real `/proc` and real PTYs, **no root needed**. The test's target value is "self + 100": raising never needs privilege, and restoring self never goes below the floor, so it runs in CI and locally. Start several sessions (including concurrently) and assert each shell got the target and the agent ends back at self. The real -900 / 0 pair is covered by the measurement above and the manual checklist.
  - install.sh: a Go test runs `install.sh --print-unit` and asserts the `User=`, `OOMScoreAdjust=-900`, `OOMPolicy=continue`, literal UID in `XDG_RUNTIME_DIR`, and `After=user@<uid>.service` lines.
