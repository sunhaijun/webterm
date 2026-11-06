# Session manager

> Status: Accepted. Output path decision: [ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md).

## Responsibilities

| Component | Responsibility |
|---|---|
| `SessionManager` | `sid` allocation, session table, limits, lifecycle orchestration |
| `Session` | One PTY + one ring buffer + one terminal emulator + a set of subscribers |
| `vterm.Terminal` | The session's terminal emulator (`internal/vterm`, wrapping tuios.dev/vt). Consumes all PTY output, produces snapshots, exports / imports its state |
| `Conn` | One WebSocket connection. Holds its subscriptions to sessions |
| `inputState` | `(client_id, sid) → in_ack`. **Lives on the Session, not the Conn**, so it survives reconnects (protocol §5.4) |

**`Session` knows nothing about WebSockets**; all it sees is a subscriber interface. That lets session logic be tested without a network (IT-session-*).

```go
type Subscriber interface {
    // ClientID returns the id of the browser tab this subscriber belongs to.
    // Input accounting is keyed by (client_id, sid), and acks go only to that client.
    ClientID() string

    // Push sends a chunk of raw output (OUTPUT frame). data is a copy the subscriber may keep.
    Push(sid uint16, seq uint64, data []byte)

    // Snapshot sends a snapshot (SNAPSHOT frame; the connection layer splits it by the frame size limit).
    // seq is the out_seq the snapshot corresponds to; data doesn't count toward seq.
    Snapshot(sid uint16, seq uint64, data []byte)

    // Event sends a control message (*protocol.SessionUpdated, *protocol.Ack, …).
    Event(msg any)
}
```

`Push`, `Snapshot`, and `Event` **must never block** (each has a bounded queue inside; when it's full, the subscriber disconnects itself).

## Data structures

```go
type SessionManager struct {
    mu       sync.RWMutex
    sessions map[uint16]*Session
    nextSID  uint16
    maxSess  int              // default 20
    cfg      Config
}

type Session struct {
    sid    uint16
    ptmx   *os.File           // PTY master
    cmd    *exec.Cmd

    mu         sync.RWMutex    // guards every field below
    name       string
    nameManual bool
    title      string          // terminal title currently in use (ADR-0043); "" = no title
    titlePgrp  int             // foreground process group the title belongs to: the one in front at the last title write
    cwd        string
    status     Status          // running | exited
    exitCode   *int
    cols, rows uint16
    ring       *ringbuf.Buffer // default 256 KiB; tracks base/head seq itself
    vt         vterm.Terminal  // 2000 lines of history
    subs       map[Subscriber]struct{}

    inputQ   *inputQueue       // bounded at 256 KiB; when full, close the connection (never block, see below)
    inQueued map[string]uint64 // client_id → bytes ACCEPTED into the queue so far
    inAck    map[string]uint64 // client_id → bytes WRITTEN to the PTY so far
    done     chan struct{}
}
```

### `inQueued` and `inAck` are different counters

- `inQueued` validates INPUT frame seq continuity. Validating against `inAck` instead would flag the second of two back-to-back frames as a gap (the PTY hasn't consumed the first one yet).
- `inAck` feeds `ack` messages and `welcome.resumed[].in_ack`.
- On a new connection's `hello`, and when a connection that is still its `client_id`'s newest ends, `DetachClient` drops that client's queued input that hasn't reached the PTY yet and subtracts it from `inQueued`, so the client's resend lines up exactly (protocol §5.4). An abandoned connection that ends later leaves the queue alone: it now holds the new connection's input (`Manager.Detach`, [ADR-0047](../20-architecture/adr/0047-review-fixes.md) §2).
- `Write` validates, enqueues and counts under `s.mu` in one step, and `DetachClient` drops and subtracts the same way, so `export` never sees a count without its bytes.
- Both are keyed by `client_id`, **survive reconnects**, and are freed with the session.

### Locking rules

- **`ring.Append` and `vt.Write` must run under the same lock, on the same bytes.** Then the emulator has always consumed exactly `ring.HeadSeq()` bytes, and a snapshot's `seq` can simply be `HeadSeq()`. This is the easiest thing to get wrong.
- **`subscribe`'s "decide incremental vs. snapshot + take the slice or build the snapshot + push + add to the subscriber set" must all happen under one lock.** Split it up, and output arriving in between is either pushed twice (duplicate) or missed by both (gap) — and protocol §3 says the client **closes the connection** on a gap.
- **Reflow on a column change + building the snapshot + pushing it to every subscriber** also happen under one lock (see [Resize](#resize)).
- `Session.mu` is a read-write lock: `readLoop` writes; the subscriber set is read far more often than it's written.
- **Live output, incremental catch-up, and snapshots are all pushed to subscribers under the lock.** Pushing after unlocking could let output that's already in a snapshot reach the client after that snapshot, breaking the continuity required by protocol §3. This doesn't stall PTY reads because `Subscriber.Push` / `Snapshot` are non-blocking by contract (they only enqueue onto the connection's write queue, and close the connection when it's full).

## `sid` allocation

`uint16`, incrementing, skipping values still in use; after wrapping it searches for a free value from 1 again (0 is reserved as invalid).

**A just-freed sid isn't reused** (not for at least one full wrap), to avoid races like "the client hasn't finished handling sid=3's close, and a new session is already sid=3".

That in-process guarantee doesn't survive a restart: sids start over, so a sid an old client still holds may point at an unrelated new session. So `SessionManager` generates a random `instance_id` at startup and sends it in `welcome`; if the `instance_id` in `hello` doesn't match, every `resume` entry is `gone` (protocol §5.3).

## Four goroutines

### `readLoop`

```
for {
    n, err := ptmx.Read(buf)          // buf 32 KiB
    if err != nil { break }           // EIO = shell exited

    session.mu.Lock()
    seq := ring.Append(buf[:n])        // returns the seq of this chunk's first byte
    vt.Write(buf[:n])                  // same bytes, same lock
    vt.TakeResponses()                 // drop the emulator's query replies (the browser answers queries)
    subs := copySubs()
    data := copy(buf[:n])
    for _, s := range subs { s.Push(sid, seq, data) }   // under the lock: non-blocking, enqueue only
    session.mu.Unlock()

    emit(session.updated{head_seq})     // unsubscribed connections use it for unread; the connection layer throttles it to 1s
}
```

**The agent never rewrites the output stream**: `out_seq` is the cumulative count of PTY output bytes (CLAUDE.md invariant 4).

Emulator cost: about 20 MB/s per core ([ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md#context)). Interactive programs produce far less; `cat` of a large file gets capped at that rate.

### `writeLoop`

```
for item := range inputCh {                    // item = {clientID, data}
    n, err := ptmx.Write(item.data)
    if err != nil { break }
    session.addAck(item.clientID, sid, n)      // in_ack += n; ack sent after throttling
}
```

`inputCh` is bounded (256 KiB). **Enqueueing must not block**: when the queue is full, reply `error{code:"input_stalled", sid}` and close that connection (protocol §5.6).

**Never block the sender.** The sender is the `Conn`'s read goroutine, and one WebSocket carries every session. A foreground program that doesn't read stdin (`sleep 1000`, some TUIs) fills the PTY's input buffer, and the stall propagates through `ptmx.Write` → `writeLoop` → `inputCh` all the way up to the connection's read loop: ping/pong, `resize`, `session.create`, and **input for every other session** all stop, and 60 seconds later the agent declares this otherwise healthy connection dead.

Closing the connection is lossless: the client reconnects and resends from `in_ack` (protocol §5.4).

### `waitLoop`

```
err := cmd.Wait()
session.mu.Lock()
status = Exited
exitCode = extractExitCode(err)
session.mu.Unlock()
close(inputCh)                          // stop accepting input
broadcast(session.updated{status:"exited", exit_code})
// ring and emulator are kept, not freed (AC-4.5)
```

**The ring and emulator are kept after `exited`**, until the user explicitly sends `session.close`. This supports "the build failed, let me read the error" (AC-4.5): switching back and refreshing still get a snapshot.

### `cwdLoop`

Once a second, for running sessions, read the working directory and the terminal title:

```
pgrp := ioctl(ptmx, TIOCGPGRP)          // the PTY's foreground process group
cwd  := readlink("/proc/<pgrp>/cwd")
title, writes := the emulator's title, how many times the title was written
writes changed → titlePgrp = pgrp            // the title belongs to the group that was in front when it was set
s.title = (pgrp == titlePgrp && pgrp != the shell's pid) ? clean(title) : ""
cwd changed, or name changed → broadcast one session.updated{cwd?, name?}
```

- Title rules are in [ADR-0043](../20-architecture/adr/0043-terminal-title-as-auto-name.md): titles the shell sets at the prompt are ignored, and the name goes back to the directory when the program exits. Counting writes detects "was set" even when a new process sets the same title.
- The leader of the foreground process group is the program the user is using right now (shell, vim, claude…), and its directory is where the user thinks they are.
- If a read fails (the process just exited, permissions), skip this round; don't clear the existing `cwd`.
- Works with any shell, with no cooperation from the shell. We only build for Linux (CI ships only linux/amd64 and linux/arm64), so `/proc` is always there.
- After `ssh`-ing out, it shows the local ssh process's directory; the remote directory is unknowable anyway.

## Subscribe: incremental or snapshot

```
subscribe(sub, out_seq, cols, rows):
  under the lock:
    columns differ from the session's → vt.Resize(cols, rows) → snapshot
    otherwise, out_seq > 0 and ring.Slice(out_seq) succeeds → incremental: Push(sid, out_seq, data)
         anything else → snapshot: Snapshot(sid, ring.HeadSeq(), vt.Snapshot(2000))
         rows changed → vt.Resize(cols, rows)
    add to the subscriber set
  after unlocking:
    size changed → TIOCSWINSZ → broadcast session.updated{cols, rows}
```

`hello.resume` uses the same decision (without a size). A snapshot contains the current screen, up to 2000 lines of history, modes, pen, scroll region, character sets, tab stops, cursor, and any partially parsed sequence ([protocol §5.2](../30-protocol/websocket-protocol.md)).

**`TIOCSWINSZ` must come after unlocking, after the enqueue**, so the bytes a program redraws on SIGWINCH always land after the snapshot or incremental output.

## Resize

```
Resize(cols, rows):
  under the lock:
    columns changed → vt.Resize → build a snapshot (seq = HeadSeq) → push it to every subscriber
    only rows changed → vt.Resize
    record cols / rows
  after unlocking: TIOCSWINSZ (skipped for exited sessions)
                   size changed → broadcast session.updated{cols, rows} to every connection
```

`winMu`, taken before `s.mu` in `Resize` and `Subscribe`, serializes the whole sequence, so concurrent resizes reach the emulator and the PTY in the same order (ADR-0047 §4). The broadcast happens while `winMu` is still held, so connections receive the sizes in the order they were applied and the last one is the current size. It goes out after `s.mu` is released, as `Rename`'s does, so it follows the snapshot that change queued.

**Who sends the size** is up to the clients ([protocol §4.1](../30-protocol/websocket-protocol.md#who-sets-the-size), [ADR-0050](../20-architecture/adr/0050-ssh-attach.md) §5): the agent keeps the latest, and tells everyone what it is.

A column change resends the snapshot: the two sides would reflow differently, and the agent's result wins ([ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) §4). A row-only change doesn't: phones change the row count every time the on-screen keyboard opens, and resending hundreds of KiB and resetting the browser's scrollback position each time costs too much.

## Lifecycle

```
(none) ──create──> running ──shell exits──> exited ──close──> (destroyed)
                      │
                      └──close──> SIGHUP ──2s──> SIGKILL ──> (destroyed)
```

### Create

```
1. Check the limit     → over it: error{session_limit}
2. Validate params     → cols/rows must be > 0 and <= 1000
3. Resolve cwd         → the requested value if given, else home; must exist and be a directory
4. exec.Command(shell, "-l", "-i")    // login shell by default; just "-i" with --no-login-shell
   env:     the agent's environment + TERM=xterm-256color + WEBTERM_SESSION=<sid>
            + the alternate screen compat list (AC-7.8) + --session-env pairs
   removed: BASH_ENV, ENV
5. pty.StartWithSize(cmd, &pty.Winsize{...})
   if the agent's oom_score_adj is negative, set it to 0 before the fork and restore it after Start returns (below)
6. vt = vterm.New(cols, rows, 2000)
7. Start the four goroutines
8. Nothing is persisted (sessions aren't stored, see ADR-0005)
```

The shell loads its startup files by its own rules: a login shell reads the profile chain, a non-login interactive shell reads `~/.bashrc`. webterm injects nothing.

**OOM priority ([ADR-0034](../20-architecture/adr/0034-system-service-oom-priority.md) §3)**: the system service sets the agent to -900, but sessions should be at 0, like an SSH login. The shell must be at 0 before it runs any user code, or long-lived processes started from `~/.profile` (ssh-agent and the like) inherit -900 forever. So step 5 holds `spawnMu`: read our own value, `self`; if `self < 0`, write 0, start the shell, then write `self` back. Raising the value needs no privilege, and writing `self` back never goes below the floor. If `self ≥ 0` (manual `webterm serve`, user service), do nothing. The write-back must come after `cmd.Start` returns: Go starts children with `CLONE_VM|CLONE_VFORK`, and until the child execs, the kernel propagates `oom_score_adj` changes to it.

`TERM` is fixed to `xterm-256color`, not `xterm-kitty` or the like: xterm.js in the browser matches `xterm-256color`'s capabilities best, and it's the one answering queries.

**Alternate screen compat list (AC-7.8, [ADR-0024](../20-architecture/adr/0024-scrollback-layered-model.md) §1)**: moves known full-screen AI CLIs back to the main screen, so their output becomes an append-only stream — only an append-only stream has scrollback you can drag back through. The list currently has one entry: `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`. Rules:

- **Never override a variable the user already set** (in the agent's own environment, or via `--session-env`): it's their machine.
- `--session-env` takes precedence over the list; `--no-altscreen-compat` turns the whole list off.
- The list **only holds variables that move a TUI back to the main screen**; nothing that changes program behavior (model, permissions, telemetry) ever goes in.
- `TERM` and `WEBTERM_SESSION` are webterm's own (the former matches xterm.js's capabilities, the latter identifies the session) and **can't be overridden**: `--session-env` with either key fails at parse time, and `internal/session` checks again as a backstop.

These are private upstream switches with no compatibility promise, so they must be possible to turn off and to verify ([troubleshooting.md](../80-ops/troubleshooting.md)).

### Close

```
running:
  1. syscall.Kill(-pgid, SIGHUP)     // bash forwards SIGHUP to all of its jobs
  2. select { <-done | <-time.After(2s) }
  3. timeout → killSession(sid, SIGKILL) + syscall.Kill(-pgid, SIGKILL)
  4. after the shell exits, sweep again with killSession(sid, SIGKILL)
  5. ptmx.Close(), free the ring and emulator, remove from the table
exited:
  just step 5
```

**`kill(-pgid)` alone isn't enough.** An interactive bash has job control on, and **every job runs in its own process group**: `sleep 300 &` has a different pgid from the shell, so signaling the shell's process group only reaches the shell.

Two mechanisms do the real work:

| Path | Relies on |
|---|---|
| Graceful (almost always) | SIGHUP reaches the shell, and **bash forwards SIGHUP to all of its jobs** |
| Fallback | Sweep by **session**: `pty.Start` already called `setsid`, so the shell's session id equals its pid, and every descendant inherits it. Scan `/proc` for processes with the same session id and SIGKILL each one |

The fallback can't be skipped: if things haven't exited within the grace period, bash no longer gets the chance to forward, and its jobs become orphans that keep running. Jobs that catch SIGHUP and carry on can only be cleaned up this way.

The sweep skips processes that **ignore** SIGHUP (bit 0 of `SigIgn` in `/proc/<pid>/status`): `nohup` stays in the session and only sets `SIG_IGN` (ADR-0047 §5). Processes that leave the session (`setsid` / `systemd-run`) aren't in it to begin with. Both are the user's explicit intent.

A session closed while the manager is frozen for a hot upgrade thaws its own loops (`Thaw` only reaches listed sessions), and `Manager.Close` waits for the handoff first (see below).

## Auto naming (AC-4.4)

```go
func (s *Session) displayName() string {
    if s.nameManual { return s.name }
    if s.title != "" { return s.title }     // terminal title set by the foreground program (ADR-0043)
    if s.cwd == "" { return "shell" }
    if s.cwd == home { return "~" }
    if b := filepath.Base(s.cwd); b != "" && b != "/" { return b }
    return "/"
}
```

Every `cwdLoop` round updates `s.cwd` and `s.title`; when the directory changes, or the name changes (with `!nameManual`), it broadcasts one `session.updated` carrying only the changed fields.

**No dedup for duplicate names** (no `(2)` suffix): two sessions in a `webterm` directory should both be called `webterm`.

## Limits and resources

| Item | Default | Setting |
|---|---|---|
| Max sessions | 20 | `--max-sessions` |
| Max concurrent connections | 16 | `--max-conns` |
| Ring buffer per session | 256 KiB | `--ring-bytes` |
| Emulator history per session | 2000 lines | Constant (= lines in a snapshot) |
| Write queue per connection | 4 MiB | Constant |
| Input queue per session | 256 KiB | Constant |
| Max frame size | 256 KiB | Protocol constant, not configurable |
| PTY read buffer | 32 KiB | Constant |

Memory bound ≈ 20 × (256 KiB ring buffer + < 1 MiB emulator) + 16 × 4 MiB (connection write queues) ≈ 90 MiB.

**Connections must be capped**: protocol §1 allows any number of browser tabs per device, and each connection carries a 4 MiB write queue. Over the limit, the handshake is rejected outright (`503`) before reaching the protocol layer.

## Graceful shutdown (`SIGTERM`)

```
1. Stop accepting new WebSocket connections
2. Broadcast notice{level:"warn", message:"The agent is restarting. All sessions will end."} to every connection
3. Wait 2 seconds (let the message go out)
4. Close every session (SIGHUP → 2s → SIGKILL)
5. Close the store
6. Exit
```

Step 2 matters: the sessions will be lost ([ADR-0003](../20-architecture/adr/0003-no-tmux.md)), so at least tell users **why**, instead of showing an unexplained reconnect failure.

## Hot upgrade handoff (`SIGUSR2` / `reexec`, [ADR-0016](../20-architecture/adr/0016-hot-reexec.md))

An upgrade **doesn't** go through the shutdown above. The agent `exec`s the new binary in place, and the sessions live on with the process:

```
1. Preflight: run the new binary as a child, `webterm handoff-check serve …`, and feed it a metadata snapshot;
   it parses the new process's command line and the config file as serve would; if it can't read the
   snapshot or rejects the command line → abort, the service carries on
2. Freeze: refuse new connections; set an already-expired read/write deadline on every session's ptmx to
   interrupt readLoop / writeLoop blocked in Read / Write; both loops stop at a safe point (after feeding a
   chunk, before pop). Partially written input goes back to the head of the queue; cwdLoop stops
3. Export: snapshot under s.mu (see below); the ring exports as (base_seq, bytes), the emulator exports its
   full state (with all 2000 lines of history), the input queue exports its unwritten entries
4. Broadcast notice{level:"info"} "Upgrading webterm. Sessions are kept and will reconnect shortly.",
   close every WebSocket
5. Clear CLOEXEC; syscall.Exec(new binary, serve …args… --handoff-fd N), where args are the running
   process's, or the ones `reload -- serve …` sent (ADR-0047 §1)
6. New process: Manager.Restore — os.NewFile adopts the ptmx (O_NONBLOCK is set on the fd, so it's pollable
   as is), os.FindProcess adopts the shell, ringbuf.Restore, the emulator imports its state, the input
   queue is refilled, the four goroutines start again
```

If any step fails (preflight, memfd, exec returning) → `Thaw`: clear the deadlines, let the loops run again, accept connections again; log it and send a notice saying why. **Never fall back to a restart on its own.**

The snapshot (`internal/handoff.Session`) holds the parts of `Session` that must not be lost: sid, ptmx fd, shell pid, createdAt, name / nameManual, title / titlePgrp (ADR-0043 §4), cwd, status / exitCode, cols / rows, ring (base + bytes), **emulator state**, inQueued / inAck, unwritten input. **Not** in the snapshot: subscribers (connections are rebuilt) and the `oom_score_adj` of the agent and the shell (the former survives execve; the latter lives on the shell process anyway). Exited sessions (ring and emulator kept for reading) are handed off too, just without an fd or pid.

**A session's snapshot must be byte-identical before and after the handoff**, and the incremental path must be byte-continuous (`TestHandoffByteLevelContinuity`).

At the manager level: `instance_id` (**unchanged**, so clients can `resume` with `ok`), `nextSID`, and `generation` (incremented on every handoff; `webterm reload` uses it to tell that the new process has taken over).

**Invariant while frozen**: readLoop stops after fully feeding a chunk, so the ring, emulator, and `out_seq` agree; writeLoop stops before `pop`, so `inAck` matches what was actually written to the PTY. Nothing moves, so `Export` captures a consistent cut. When you add a session field, first ask whether it belongs in the snapshot.

**Changes wait for the handoff.** `Freeze` takes `handoffMu` for writing and holds it until `Thaw` or exec; `Close`, `Rename` and `Move` take it for reading. Made after `Export`, they'd be lost with the old process. If the upgrade goes ahead, the waiting request dies with its connection and the next `welcome` shows the real state (ADR-0047 §4).

**Listeners.** The new process reuses an inherited listener only if it's on the configured address (the command line may have changed the port), and closes inherited fds nothing adopted, which would otherwise leak into every shell started later. The old process exports listener fds without `File.Fd()`, which would switch the still-serving socket to blocking mode.

Control socket: `<data-dir>/run/agent.sock` (0600), one JSON request line, one response line. `{"op":"status"}` → version, pid, generation, `instance_id`, session count, busy session count (the PTY's foreground process group isn't the shell itself, i.e. a command is running), `handoff: true`, `args` (the command line) and `exec_args: true`; `{"op":"reexec", "args": [...]}` → triggers the flow above, with `args` as the new command line if given, and clears the previous `last_error`. `SIGUSR2` is equivalent to a reexec without args. A live socket belongs to the running agent: another agent with the same data directory refuses to start, and an agent removes the socket file on exit only if it's still its own (ADR-0047 §3).

## Crash cleanup

Nothing to clean up for PTYs or processes: when the agent dies the PTY master closes, and the shell gets `SIGHUP` and exits. webterm no longer creates any temporary files (the rcfile went away with shell integration).
