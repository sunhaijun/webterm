# WebSocket protocol

> Status: Accepted · protocol version `2` ([ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md))
>
> ★ **This is the only contract between frontend and backend.** Every change starts here, then the code. Neither side changes first.
> Implemented in `internal/protocol` (Go) and `web/src/protocol` (TS). The two must match exactly, and both run the same test vectors in their unit tests.

---

## 0. Quick reference

| Name | Definition |
|---|---|
| `sid` | Session id, `uint16`, unique within an agent process, reallocated after a process restart |
| `out_seq` | How far into the **session's cumulative PTY output, in bytes,** the client has received. The agent does not rewrite the output stream; not a single byte is stripped |
| `in_seq` | **Cumulative bytes the client has sent the agent** (per session) |
| `in_ack` | Cumulative input bytes the agent has actually written to the PTY |
| `base_seq` | The `out_seq` at which the ring buffer's retained content starts |
| `head_seq` | The `out_seq` at the end of the ring buffer (= total bytes the session has produced) |
| snapshot | The agent-side terminal emulator's full state at some `seq`, serialized as bytes any xterm can consume (§5.2) |
| `client_id` | Identity of one page load. **The key for input accounting**, see §5.4 |
| `instance_id` | Random id of the current agent process run. Detects "the agent restarted", see §5.3 |

**seq counts bytes, not messages.** Rationale in [ADR-0009](../20-architecture/adr/0009-hybrid-ws-framing.md).

---

## 1. Connection setup

### Endpoint

```
GET /ws
Upgrade: websocket
Cookie: webterm_session=<token>
Origin: https://<configured domain>
```

### Server-side checks (any failure rejects the upgrade)

| Check | On failure |
|---|---|
| Cookie present and maps to a device that isn't revoked | `401` |
| `Origin` exactly equals the configured domain (under `--dev`, `http://localhost:*` and `http://127.0.0.1:*` are allowed) | `403` |

**No version negotiation in the handshake** — the handshake carries no client version (`Sec-WebSocket-Protocol` isn't used). The version is negotiated in `hello`/`welcome`, and a mismatch returns `error{code:"protocol_unsupported"}`, which gives a readable error instead of a bare handshake failure.

### Local attach endpoint

`webterm attach` ([ADR-0050](../20-architecture/adr/0050-ssh-attach.md)) reaches the agent through a Unix socket instead of the network:

```
<data-dir>/run/attach.sock     mode 0600, in the 0700 run directory
GET /ws                        upgrades to this same protocol
```

| Check | On failure |
|---|---|
| The peer's uid (`SO_PEERCRED`) equals the agent's | `403` |

There is no cookie and no `Origin`. File permissions and the peer uid are the authentication, as for the control socket ([ADR-0016](../20-architecture/adr/0016-hot-reexec.md)). Everything after the upgrade is identical to `/ws` on the network: the same messages, accounting, limits and timeouts. Each agent process creates the socket on start and removes it on exit; a hot upgrade's new process creates it again, and clients reconnect.

### One connection for everything

- One WebSocket carries all sessions; the frame header carries `sid`
- One device may open several connections (several tabs). **The agent allows this and doesn't make them exclusive**: each connection subscribes and tracks `out_seq` independently
- **One page, one connection.** A page holds a single socket; when it gives up on one (no pong, protocol error, `retryNow`), it detaches it at once and doesn't wait for `onclose`. A `hello` with a `client_id` the agent already has a connection for means the page abandoned that one: the agent closes it, and the new connection owns the page's input from then on (§5.4, [ADR-0047](../20-architecture/adr/0047-review-fixes.md) §2)
- Several connections writing input to the same session at once is allowed, and what that means is up to the user (like two people attached to the same tmux). `in_seq` is accounted per **`client_id`**, see §5.4

---

## 2. Frame types

The WebSocket opcode is the discriminator; no extra type byte is needed.

| WebSocket frame | Content |
|---|---|
| **binary** | Terminal data and snapshots. 12-byte fixed header + raw payload |
| **text** | Control messages. A JSON object that always has a `t` field |

Any frame that doesn't match → the receiver sends `error{code:"bad_frame"}` and closes the connection.

---

## 3. Binary data frames

### Layout (big-endian)

```
Offset Len  Field     Type      Description
────── ───  ────────  ────────  ──────────────────────────────────────────
  0     1   type      uint8     0x01 = OUTPUT   (agent→client)
                                0x02 = INPUT    (client→agent)
                                0x03 = SNAPSHOT (agent→client)
  1     1   flags     uint8     bit0 = MORE (SNAPSHOT only, see below)
                                other bits reserved: sender writes 0, receiver ignores
  2     2   sid       uint16    session id
  4     8   seq       uint64    OUTPUT / INPUT: out_seq / in_seq of this frame's FIRST byte
                                SNAPSHOT: the out_seq this snapshot corresponds to (see below)
 12     N   payload   bytes     N ≥ 1
```

- The header is always 12 bytes
- A frame with an empty `payload` is invalid → `error{code:"bad_frame"}`
- An unknown `type`, or a `type` sent in the wrong direction (client sends `OUTPUT` / `SNAPSHOT`, agent sends `INPUT`) → `error{code:"bad_frame"}`
- The `payload` of one frame is at most **256 KiB**; larger → `error{code:"frame_too_large"}` and close the connection
- **No encoding.** `payload` can be any byte sequence, including a multi-byte UTF-8 character cut in half — the client must decode with a **streaming** UTF-8 decoder (§5.2)

### OUTPUT frames (agent → client)

- `payload` is raw PTY output, forwarded verbatim. Frame boundaries depend only on when the agent happens to read, and **carry no meaning**
- Consecutive OUTPUT frames for the same `sid` must satisfy `seq(n+1) == seq(n) + len(payload(n))`
- When the client sees `seq != expected`:
  - `seq < expected` → duplicate data (shouldn't happen): drop it and log a warning
  - `seq > expected` → a gap (shouldn't happen): **close the connection immediately and resume via reconnect**; don't try to patch it up

### SNAPSHOT frames (agent → client)

A snapshot can span several frames: every frame of one snapshot has the same `seq`, and **all but the last set `flags` bit0 (MORE)**. The agent guarantees that no other frames for the same `sid` are interleaved between a snapshot's frames.

- `seq` is the `out_seq` this snapshot corresponds to: the agent's emulator has consumed exactly the first `seq` bytes. Subsequent OUTPUT frames start at `seq`
- The (concatenated) `payload` is bytes **any xterm-compatible terminal can consume**: starting from a cleared terminal, it draws up to 2000 lines of history, the current screen, modes, pen, scroll region, character sets, tab stops and cursor, plus any sequence the emulator is halfway through parsing (placed last, so the following OUTPUT frames complete it)
- **Snapshot bytes don't count toward `out_seq`.** They are rendering instructions generated by the agent, not stream content
- Once the last frame arrives, the client writes RIS (`ESC c`) into the write stream to reset → switches to a new UTF-8 decoder → writes the snapshot as **replay** (§5.3, replay gate) → sets `out_seq = seq`
- **Reset with RIS (`ESC c`) in the write stream, not with `term.reset()`**: `reset()` is synchronous and doesn't clear the write buffer. When the column count changes, the agent resends a snapshot immediately, and old output that hasn't been parsed yet would be drawn after the reset but before the snapshot. RIS enters the write buffer together with the snapshot, so the order is right by construction (xterm's own comment on `reset()` recommends RIS in this situation)

### INPUT frames (client → agent)

- The client assigns `in_seq` and appends the data to its local resend queue
- The agent validates it (accounting belongs to `(client_id, sid)`, not to the connection, see §5.4). Let `accepted`
  be the cumulative bytes the agent has accepted into its queue:
  - `seq == accepted` → normal, queue it for the PTY
  - `seq < accepted` → resent data already handled: **drop the first `accepted - seq` bytes** and accept the rest (normal on reconnect)
  - `seq > accepted` → a gap → `error{code:"input_gap"}` and close the connection

  **Validate against `accepted`, not `in_ack`.** They differ: `in_ack` counts bytes actually
  written to the PTY and lags behind the queue. Validating against `in_ack` would flag the second
  of two back-to-back frames as a gap, because the PTY hasn't consumed the first one yet. `in_ack`
  is used only for `ack` and as the resend starting point after a reconnect.
- INPUT for a session in the `exited` state → drop it and reply `error{code:"session_exited", sid}`; don't close the connection

---

## 4. Control messages (JSON text frames)

Every control message looks like `{"t": "<type>", ...}`. An unknown `t` value **must be ignored** by the receiver (forward compatibility).

### 4.1 client → agent

#### `hello` — the first message after connecting, required

```json
{
  "t": "hello",
  "protocol": 2,
  "client_id": "c7f3…",
  "instance_id": "a91e…",
  "resume": [
    { "sid": 1, "out_seq": 483920 }
  ]
}
```

| Field | Description |
|---|---|
| `protocol` | Protocol version the client supports |
| `client_id` | **One per page load**, generated by the client and kept in memory only; it stays the same across reconnects because the same connection object holds it. The key for input accounting (§5.4). **Don't store it in `sessionStorage`**: after a reload the id would be the same, the agent's `in_ack` would still hold the pre-reload total, but the new page's `in_seq` starts again from 0, so its first bytes would be silently dropped as resends. Not in `localStorage` either: it's shared across the origin and can't tell tabs apart |
| `instance_id` | The value from the last `welcome`; `null` on first connect. If it differs from the agent's current value, the agent marks every `resume` entry `gone` (§5.3) |
| `resume` | Sessions to resume and their output progress. `[]` on first connect. **No input progress** — the agent keeps `in_ack` |

Any other frame before `hello` → `error{code:"expected_hello"}` and close.

#### `session.create`

```json
{ "t": "session.create", "req_id": "r1", "name": null, "cwd": null, "cols": 80, "rows": 24 }
```

`name`/`cwd` of `null` means the default (`cwd` defaults to the user's home). Success → `session.created`; failure → `error`.

**Creating a session doesn't subscribe to it**: on `session.created` the client sends `subscribe{out_seq: 0}` itself and gets the first screen as a snapshot. This is the only path.

#### `session.close`

```json
{ "t": "session.close", "req_id": "r2", "sid": 1 }
```

For a `running` session: `SIGHUP` → `SIGKILL` if it's still alive after 2 seconds. Processes that ignore `SIGHUP` (`nohup`) are left running ([ADR-0047](../20-architecture/adr/0047-review-fixes.md) §5).
For an `exited` session: free the buffers and destroy it immediately.
Both reply `session.closed`.

#### `session.rename`

```json
{ "t": "session.rename", "req_id": "r3", "sid": 1, "name": "build" }
```

After this the session **stops** automatic naming (it no longer follows the terminal title or the CWD). `name: null` restores automatic naming.

#### `session.move`

```json
{ "t": "session.move", "req_id": "r4", "sid": 3, "before": 1 }
```

Moves session `sid` in front of session `before`; `before: null` moves it to the end ([ADR-0040](../20-architecture/adr/0040-session-order-drag.md)).

- `sid` doesn't exist → `error{code:"unknown_session"}`.
- `before` doesn't exist (e.g. it was just closed elsewhere) → treated as `null`, move to the end; `before` equals `sid` → stays put. Neither is an error.
- On success, broadcast `session.order` (§4.2), **even if the position didn't change**, so the sender gets confirmation.

#### `subscribe` / `unsubscribe`

```json
{ "t": "subscribe",   "sid": 1, "out_seq": 483920, "cols": 90, "rows": 30 }
{ "t": "unsubscribe", "sid": 1 }
```

**Subscribe only to the currently visible session.** Unsubscribed sessions keep running on the agent and keep feeding the emulator; the agent only sends `session.updated{head_seq}` when they produce output (throttled, see §6.2), and the client derives unread from it.

`subscribe` carries `out_seq` and is decided the same way as `resume` (§5.1): **incremental** or **snapshot**. Both first open and switching back use this message; no reconnect is needed. When the client has none of this session's content (first open, page reload), it reports `out_seq: 0`.

**`cols` / `rows` are the current terminal size**; omitted, 0, or outside 1..1000 means "keep the session's current size". When the column count changes, the snapshot goes to **every subscriber of the session** (not just this connection), as with `resize`. **Don't send a separate `resize` when subscribing** — the size must be in the same message as `subscribe` so the agent can pin down the order:

```
under lock:   columns changed → emulator.Resize → snapshot (regardless of out_seq)
              otherwise       → incremental / snapshot per §5.1; emulator.Resize if rows changed
              queue the frames, join the subscriber set
outside lock: size changed    → TIOCSWINSZ
```

So whatever the program redraws on SIGWINCH always comes after the snapshot or incremental bytes. The other way round, the redraw would land before the snapshot's position and the client would never get that screen.

#### `resize`

```json
{ "t": "resize", "sid": 1, "cols": 100, "rows": 30 }
```

The client debounces by 100ms. The agent:

- **Columns changed**: under the lock, `emulator.Resize` → generate a snapshot (`seq` = `head_seq`) → send it to **every subscriber of the session**; `TIOCSWINSZ` outside the lock. The two sides reflow differently ([ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) §4), and the agent's result wins
- **Only rows changed**: `emulator.Resize` + `TIOCSWINSZ`, no snapshot

Either way, once the size has changed the agent sends `session.updated{sid, cols, rows}` to **every connection** (§4.2).

#### Who sets the size

A session has one size, and every client draws at its own. The agent applies whichever `subscribe` with a size or `resize` arrives last. **Clients send them only when they are in use** ([ADR-0050](../20-architecture/adr/0050-ssh-attach.md) §5), so the size follows the client the user is using:

| Client sends its size when | Browser | `webterm attach` |
|---|---|---|
| It opens or switches to the session | `subscribe` with size | `subscribe` with size |
| The user types, pastes, or uses the mouse in it (automatic terminal replies never count) | yes | yes: stdin that isn't a terminal report |
| It gains focus or becomes visible | yes | — (can't see focus) |
| Its own size changes | only while focused | yes (`SIGWINCH`) |
| After a reconnect, if its size differs | only while focused | no |

A client compares its size with the session's (`welcome.sessions[]`, `session.updated{cols, rows}`) and sends nothing when they're equal.

#### `ping`

```json
{ "t": "ping", "ts": 1757116800123 }
```

Sent every 30 seconds. **A protocol-level ping rather than WebSocket control frames**, because the browser API doesn't expose ping/pong and we want to measure RTT.

### 4.2 agent → client

#### `welcome` — the reply to `hello`

```json
{
  "t": "welcome",
  "protocol": 2,
  "server_version": "0.2.0",
  "instance_id": "a91e…",
  "home": "/home/user",
  "limits": { "max_sessions": 20, "ring_bytes": 262144, "max_frame_bytes": 262144 },
  "sessions": [
    {
      "sid": 1, "name": "webterm", "name_is_manual": false,
      "cwd": "/home/user/github/webterm",
      "status": "running", "exit_code": null,
      "cols": 80, "rows": 24,
      "base_seq": 221776, "head_seq": 483920,
      "created_at": 1757116000000
    }
  ],
  "resumed": [
    { "sid": 1, "status": "ok", "from_seq": 483920, "in_ack": 1204 }
  ]
}
```

`resumed[].status`:

| Value | Meaning | Client action |
|---|---|---|
| `ok` | Incremental resume | Don't clear the screen; continue with OUTPUT frames from `from_seq` (= its own `out_seq`) |
| `snapshot` | Snapshot follows | Wait for SNAPSHOT frames (§3); `from_seq` = the snapshot's `seq` |
| `gone` | The sid no longer exists (session destroyed / `instance_id` mismatch) | Remove the session from the UI and show "Session ended" |

**The order of `sessions[]` is the display order** ([ADR-0040](../20-architecture/adr/0040-session-order-drag.md)): new sessions go last, and `session.move` can reorder them. The client shows this order and doesn't sort on its own.

`home` is the agent user's home directory. The client uses it to abbreviate a CWD to `~` (when the CWD equals it or starts with `home + "/"`). If the field is absent, nothing is abbreviated.

`resumed[].in_ack` is the cumulative number of bytes the agent has written to the PTY for **this `client_id`** on this session (§5.4). **The client must trim its resend queue by it and resend everything after it.**

**Unread is derived from `head_seq`**, not stored on the server: `unread = head_seq > local out_seq`. Unread is inherently per client; keeping it on the server would let two tabs clear each other's unread state.

#### `session.created` / `session.closed` / `session.updated`

```json
{ "t": "session.created", "req_id": "r1", "session": { …same shape as welcome.sessions[]… } }
{ "t": "session.closed",  "req_id": "r2", "sid": 1, "exit_code": 0 }
{ "t": "session.updated", "sid": 1, "name": "api", "cwd": "/srv/api", "status": "running", "head_seq": 491337 }
```

- All three are **broadcast to every connection of the device** (otherwise tab B wouldn't see a session tab A created). `req_id` appears only on the copy sent to the connection that made the request
- `session.updated` contains only **the fields that changed** + `sid`. The client merges it in
- `cols` / `rows` are sent together whenever the session's size changes, whichever connection's `subscribe` or `resize` changed it. They arrive after any snapshot that change produced and in the order the changes were applied, so the last pair a client receives is the current size (§4.1, "Who sets the size")
- `cwd` comes from the agent reading `/proc/<foreground process group>/cwd` once a second and is sent only on change; when `name_is_manual == false`, `name` follows (AC-4.4)
- Source of the automatic name ([ADR-0043](../20-architecture/adr/0043-terminal-title-as-auto-name.md)): the terminal title (OSC 0 / 2, sanitized, at most 64 characters) set by the **foreground program** (not the shell itself) wins; otherwise the CWD basename. Title and CWD are read in the same once-a-second poll and a message is sent only when the name changes, so there is at most one per session per second
- **Session exit**: `session.updated{status:"exited", exit_code, head_seq}` always comes **after the session's last OUTPUT** (the agent waits for EOF on the PTY, for at most 500 ms — EOF never comes while a background process holds the PTY open). `head_seq` is the final output total: only when the client's `out_seq` reaches it has all output arrived

#### `session.order`

```json
{ "t": "session.order", "req_id": "r4", "sids": [3, 1, 2] }
```

Broadcast to every connection after a successful `session.move`; `req_id` appears only on the sender's copy. `sids` is the **complete** display order, and the client replaces its own order with it. Creating and closing sessions don't send it: new sessions go last and closed ones are removed, which both sides can work out on their own.

#### `ack`

```json
{ "t": "ack", "sid": 1, "in_ack": 1352 }
```

Sent after writing to the PTY. **Throttled**: at most one per session per 50ms, carrying the latest value (it's cumulative, so dropping intermediate values is harmless).

#### `pong`

```json
{ "t": "pong", "ts": 1757116800123 }
```

`ts` echoes the client's value; the client computes RTT from it.

#### `error`

```json
{ "t": "error", "req_id": "r1", "sid": 1, "code": "session_limit", "message": "session limit reached (20)" }
```

`req_id` / `sid` are included when they apply. Error codes are listed in §7.

#### `notice`

```json
{ "t": "notice", "level": "warn", "message": "agent is restarting; all sessions will end" }
```

`level`: `info` / `warn` / `error`. Used when the agent has something to tell the client unprompted (such as the shutdown warning on `SIGTERM`, or a revoked device).

---

## 5. Resume

### 5.1 Incremental or snapshot

For every `hello.resume` entry and every `subscribe`, the agent makes the same decision:

```
instance_id mismatch / sid doesn't exist        → gone (hello only)
subscribe brings a column count != the session's → snapshot (emulator.Resize first; the session's other subscribers get this snapshot too)
out_seq > 0 and base_seq ≤ out_seq ≤ head_seq    → incremental: from_seq = out_seq, send the raw bytes [out_seq, head_seq)
anything else (out_seq == 0, out of window, ahead of head) → snapshot: from_seq = the snapshot's seq
```

- **Incremental** is the normal case for network blips and short switches away; it's byte-level continuous (AC-2.1)
- **Snapshot** covers everything else: first open, page reload, long disconnects, long switches away, programs on the alternate screen, column changes. No per-screen branching, no "history truncated"
- **The decision is made under the lock, together with queuing the frames and joining the subscriber set.** Done separately, a batch of output arriving in between is either sent twice (duplicate) or missed by both (gap)

### 5.2 Ring buffer and emulator

Each session's PTY output does two things **under the same lock**: it's appended to the ring buffer and fed to the terminal emulator. So at any moment `bytes consumed by the emulator == head_seq`, and a snapshot's `seq` is the `head_seq` at that moment.

```
                      base_seq                      head_seq
                          │                             │
output stream: ───────────┼─────────────────────────────┼──────>
             (overwritten)│    ring buffer (256 KiB)    │
                                                        └── the emulator's state matches exactly this point
```

- The **ring buffer** serves only the incremental path; default `ring_bytes` = **256 KiB** (`--ring-bytes`). It's trimmed by bytes, not at `\n` boundaries: clients that fall out of the window always get a snapshot, so where the trim lands doesn't affect the display
- The **emulator** (`internal/vterm`, tuios.dev/vt) keeps 2000 lines of history and is fed whether or not anyone is subscribed. The query replies it generates are **discarded** — terminal queries are still answered by the browser's xterm (§5.3)
- **Snapshots** are exported by the emulator: current screen + up to 2000 lines of history + modes / pen / scroll region / character sets / tab stops / cursor + any half-parsed sequence. Typical content takes about 0.5 ms (current screen only) to 35 ms (a full 2000 lines at 100 columns)
- **Snapshots are capped at 1 MiB**: above that, regenerate once with proportionally fewer history lines (the current screen and modes are never cut). A wide terminal (hundreds of columns) with pathological output that changes color on every cell can reach several MiB at 2000 lines, which would overflow the connection write queue (4 MiB, §5.6) and disconnect — and the reconnect needs a snapshot again, looping forever
- On the client: **one streaming UTF-8 decoder per session** (`TextDecoder` with `stream: true`) turns bytes into strings before they're written to xterm. Writing `Uint8Array` directly makes xterm.js drop characters for some splits (a three-byte character whose second byte is `0x80`, split right after that byte, e.g. `。` `…` `—`); see the context section of [ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md). A snapshot gets a fresh decoder

### 5.3 Reconnect and resume

```
①  client detects the disconnect
②  client keeps: each session's out_seq, the unacked input queue
③  exponential backoff (from 0.5s, ×1.5, capped at 15s, ±20% jitter)
    online event / page becomes visible → retry once immediately and reset the backoff
④  connected → send hello{ client_id, instance_id, resume: [{sid, out_seq}, …] }
⑤  agent decides ok / snapshot / gone for each sid (§5.1)
⑥  agent replies welcome (with instance_id and resumed[].in_ack)
⑦  client:
       status=="gone"   → remove the session UI
       trim the resend queue by in_ack → resend all input after it
⑧  agent sends: ok → OUTPUT frames from from_seq; snapshot → SNAPSHOT frames, then OUTPUT frames from its seq
```

**Why `instance_id`**: `sid` is a `uint16` reallocated from scratch after an agent restart. Without an instance id, `resume{sid:1, out_seq:<large>}` would be treated as "ahead of head": the screen keeps the old session's content and then continues with output from a **completely unrelated new session**, and the user has no way to notice.

**A hot upgrade isn't a restart** ([ADR-0016](../20-architecture/adr/0016-hot-reexec.md)): when the agent re-execs in place, it hands `instance_id`, each session's ring buffer, emulator state and `in_ack` to the new process, so clients reconnecting after an upgrade still resume incrementally rather than getting `gone`. Only a real process restart (`SIGTERM`, crash) changes `instance_id`.

**Recommended**: list only visible sessions in `resume`, and catch up the others with `subscribe{out_seq}` when the user switches to them, to avoid a flood of data right after reconnecting. **Their pending input doesn't wait for that**: right after `welcome`, the client resends `pending` for every running session that isn't in `resume`, as is. It starts at or before what the agent accepted, so the agent drops the duplicate prefix (§3).

**Replay gate: while catch-up and snapshot bytes are being written to the terminal, the terminal's automatic replies don't go to the PTY.** Historical output contains terminal queries that programs sent (DSR / DA / `CSI ?u` …). Writing those bytes into xterm makes it **answer them again** — that isn't user input, and sending it to the PTY types garbage. The client keeps a `catchup_to` per session: OUTPUT received before `out_seq` reaches it counts as replay; SNAPSHOT always counts as replay.

| When | `catchup_to` |
|---|---|
| `welcome`, `status == "ok"` | the session's `head_seq` |
| `subscribe`, incremental | the session's known `head_seq` (kept up to date by `session.updated`) |
| SNAPSHOT received | its `seq` (after the snapshot, it's live) |

**Suppress automatic replies, not user input.** Both come out of xterm's `onData`; what differs is **who produced them**: automatic replies happen synchronously inside the parsing of `term.write()`, user input synchronously inside the dispatch of a DOM input event. The client tells them apart by source: **`onData` produced while a user input event is being dispatched always passes**; only the rest is subject to the replay gate ([ADR-0020](../20-architecture/adr/0020-input-never-silently-dropped.md)).

### 5.4 Input resend queue

Per session, the client keeps:

```
in_seq_next : uint64          next in_seq to assign
pending     : [{seq, bytes}]  input sent but not yet acked
```

- On send: assign `seq = in_seq_next`, `in_seq_next += len`, append to `pending`
- On `ack{in_ack}`: drop the `pending` entries with `seq + len <= in_ack`; trim the front of an entry that is partly acked
- After reconnecting: trim by `welcome.resumed[].in_ack`, then **resend everything in `pending` in ascending seq order**; sessions not in `resume` resend `pending` untrimmed (§5.3)
- `pending` is capped at **256 KiB**, what the agent's input queue holds (§5.6). Input that would exceed it is refused with a clear message ("Input too large" / "Input buffer full"), and the caller is told: **never drop input silently**, and never act as if it went out (the text page keeps its draft and sends no Enter)

**The accounting key is `(client_id, sid)`, not the connection.** Two tabs count independently (mixing them would make no sense), but **a reconnect from the same page must inherit `in_ack`**:

- The agent keeps `in_ack` for each `(client_id, sid)` **until the session is destroyed**. Every reload adds a `client_id`, so the number of entries grows with reloads; each is an id plus two `uint64`s, a few KB even on long-lived sessions, so they're never reclaimed — reclaiming one would make that page's reconnect, with input still in `pending`, fail with `input_gap`
- When this `client_id` has never sent input to this session, `in_ack = 0`, and the client's `in_seq_next` is necessarily 0 as well, so the two sides agree from the start. This only holds because `client_id` is new on every page load (§4.1)
- Conversely, `seq == 0` when this `(client_id, sid)` already has accounting means the client reset its counter but kept the old `client_id`. A normal reconnect never looks like this: the client trims by `in_ack` and resends from `seq = in_ack`, so `seq` doesn't start at 0. The agent still treats it as a resend (dropping the duplicate part) but **logs a Warn** (`sid`, `client`, `accepted`, `len`) — the browser shows no sign at all of these drops ([ADR-0020](../20-architecture/adr/0020-input-never-silently-dropped.md), item 5)
- With per-connection accounting, `in_ack` would reset to zero on reconnect while the client's `pending` still starts at the old `seq`; the agent would see `seq > in_ack` → `input_gap` → close → reconnect, forever. **Input typed while disconnected survives** (US-2.2) would be broken entirely

**When a connection drops, the agent must discard that `client_id`'s input that is queued but not yet written to the PTY**, and
**subtract the discarded bytes** from `accepted`. Those bytes were never acked and the client still holds them in `pending`,
so it will resend them; if they weren't discarded they'd be written to the PTY once now and once more on resend.
The agent does this at the new connection's `hello`, and again when a connection ends **only if it is still the newest one for its `client_id`**: an abandoned socket can end long after its page reconnected, and by then the queue holds the new connection's input.

**Don't simply roll back to `in_ack`**: the chunk the write loop has already taken off the queue and is writing is neither in the queue
nor acked yet (when the foreground program isn't reading input, that write can block for a long time — exactly the `input_stalled` disconnect case).
Rolling back to `in_ack` would accept that chunk again as new data when the client resends it, writing it to the PTY twice.
Subtracting only the discarded part leaves `accepted = in_ack + the chunk being written`, so the prefix the client resends from `in_ack` is skipped as a duplicate and everything lines up exactly.

### 5.5 Heartbeat and timeouts

| Direction | Rule |
|---|---|
| client → agent | `ping` every 30 seconds |
| agent → client | reply `pong` immediately on `ping` |
| client declares dead | no `pong` within 10 seconds of a `ping` → detach the socket and reconnect, without waiting for `onclose` (§1) |
| client probes | on the `online` event / page becoming visible, send a `ping` **immediately**; no `pong` within **2 seconds** → close and reconnect |
| agent declares dead | no frame of any kind for 60 seconds → close the connection |

`ping`/`pong` don't affect `out_seq`/`in_seq`. The probe reuses the same pair of messages, so **the agent needs no change for it**.

**Why a separate probe rule.** A dead line doesn't always produce `onclose`: screen off, switching apps, Wi-Fi to cellular, a NAT or reverse proxy silently evicting the connection — none of these send a FIN, so the browser's `readyState` stays OPEN. Such a **zombie connection** believes it's online, and the only thing that exposes it is the heartbeat, after 30 + 10 = 40 seconds at worst — longer in practice, since `setInterval` is throttled in background tabs. For those 40 seconds everything the user types goes into a dead socket and nothing changes on screen.

`online` and "page visible again" are **known suspicious moments**: the system just said the network changed, or the user just brought the app back to the foreground. At that point the connection is either alive (local RTT is far below 2 seconds) or dead, so the probe waits 2 seconds rather than the heartbeat's 10. A wrong call costs only one reconnect, and reconnects are lossless (§5.3 resume + §5.4 resend from `in_ack`).

Rationale and trade-offs: [ADR-0020](../20-architecture/adr/0020-input-never-silently-dropped.md).

### 5.6 Bounded queues (both directions)

| Queue | Limit | When full |
|---|---|---|
| Connection write queue (output → client) | 4 MiB (constant), on top of the catch-up for `hello` | close that connection |
| Session input queue (client → PTY) | 256 KiB | reply `error{code:"input_stalled", sid}` and close that connection |

**Neither side ever blocks.** A blocked write side backpressures into `PTY.Read()` and stalls the shell — one slow client must not slow down the real work running on the server. A blocked read side is worse: **one WebSocket carries all sessions**, so a foreground program that doesn't read stdin (`sleep`, some TUIs) fills the PTY's input buffer and then stalls the whole connection's read loop — ping/pong, `resize`, `session.create` and every other session's input all stop.

Closing the connection is lossless: the client reconnects automatically and resumes, output via incremental or snapshot, input resent from `in_ack` (§5.4).

**The catch-up for `hello` is exempt from the write-queue limit.** It is what the client asked for (bounded by the sessions it resumes), and counting it would close the connection before `welcome`, again on every reconnect, so the client could never get back in. The limit applies to everything enqueued after `welcome`, on top of it.

---

## 6. State and throttling

### 6.1 Session state machine

```
(none) ──session.create──> running ──shell exits──> exited ──session.close──> (destroyed)
                              │
                              └──session.close──> SIGHUP ─2s─> SIGKILL ──> (destroyed)
```

`exited` sessions keep their buffers, can be resumed and viewed, and **accept no input**.

### 6.2 Throttling rules

| Message | Throttling |
|---|---|
| `ack` | at most one per session per 50ms, carrying the latest cumulative value; **a swallowed value must be sent later** |
| `session.updated{head_seq}` | at most one per session per 1s (the client only uses it for unread, so intermediate values don't matter); **a swallowed value must be sent later** |
| `session.updated{cwd}` | the agent reads once a second and sends only when the path actually changes |
| `resize` (client side) | 100ms debounce; **except on subscribe, see `subscribe` in §4.1** |

**"A swallowed value must be sent later" is not optional.** Both values are cumulative, so dropping intermediate ones is harmless — but **dropping the last one is not**:
output often comes in a burst that finishes within a second, after which nothing triggers another message. Throttling without a trailing send
leaves the client stuck on the value from before the burst — a stuck `head_seq` means the unread dot never lights up (AC-4.3),
a stuck `in_ack` means the resend queue never drains. Implementation: when throttling, record the latest value and let the write loop's
timer send it once the window expires.

---

## 7. Error codes

| `code` | Meaning | Closes the connection |
|---|---|---|
| `expected_hello` | The first message isn't `hello` | yes |
| `protocol_unsupported` | The protocol version can't be negotiated | yes |
| `bad_frame` | Malformed frame (too short, empty payload, unknown `type`, `type` in the wrong direction, JSON parse failure) | yes |
| `frame_too_large` | Exceeds `max_frame_bytes` | yes |
| `input_gap` | The INPUT frame's `seq` is greater than the bytes the agent has accepted (`accepted`, §3): there's a gap | yes |
| `input_stalled` | The session input queue is full (the PTY can't be written to for a long time, §5.6) | yes |
| `unauthorized` | The device has been revoked | yes (after a `notice`) |
| `unknown_session` | The `sid` doesn't exist | no |
| `session_exited` | Input sent to a session that has exited | no |
| `session_limit` | The session limit has been reached | no |
| `bad_request` | Invalid parameters (e.g. `cols <= 0`) | no |
| `internal` | Internal agent error | depends |

---

## 8. Protocol versioning

- `protocol` is an integer, currently `2`
- **Can be added freely**: new control message types, new fields on existing messages. Receivers ignore unknown `t` values and unknown fields
- **Requires a version bump**: changes to the binary frame layout, changed semantics of an existing field, removed fields
- On a version mismatch the agent replies `error{code:"protocol_unsupported"}` with both versions spelled out in `message`, and the client shows "Agent was upgraded; reload the page"

| Version | Changes |
|---|---|
| 1 | Initial version |
| 2 | [ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md): added the `SNAPSHOT` frame and `resumed[].status: "snapshot"`; removed `ATTR_PREFIX`, `reset`, `redraw`, `cwd`, `prompt`, `command.start` / `command.end`, and the session fields `integration` / `prompt_state` / `unmarked_input`; `out_seq` no longer strips OSC |

---

## 9. Test vectors

`internal/protocol/testdata/vectors.json` is a fixture shared by frontend and backend, and the unit tests on both sides must run it (to keep the implementations from drifting). Format:

```json
{
  "binary_frames": [
    {
      "name": "output_basic",
      "hex": "0100000100000000000000e86869",
      "decoded": { "type": 1, "flags": 0, "sid": 1, "seq": "232", "payload_hex": "6869" }
    },
    {
      "name": "snapshot_more",
      "hex": "0301000100000000000000e81b5b48",
      "decoded": { "type": 3, "flags": 1, "sid": 1, "seq": "232", "payload_hex": "1b5b48" },
      "note": "flags bit0 = MORE: more frames of the same snapshot follow"
    }
  ],
  "invalid_frames": [
    { "name": "too_short_header", "hex": "010000010000", "expect_error": "bad_frame" },
    { "name": "header_only_empty_payload", "hex": "0100000100000000000000e8", "expect_error": "bad_frame" },
    { "name": "unknown_type", "hex": "0400000100000000000000e86869", "expect_error": "bad_frame" }
  ],
  "control_messages": [
    { "name": "hello_first_connect", "json": { "t": "hello", "protocol": 2, "client_id": "x", "resume": [] } }
  ],
  "unknown_messages": [
    { "name": "future_type", "json": { "t": "session.split", "sid": 1 }, "note": "receivers must ignore this, not close the connection" }
  ]
}
```

`binary_frames[].data_len` is the number of bytes the frame **counts toward seq**: the payload length for OUTPUT / INPUT, 0 for SNAPSHOT (snapshots don't count toward seq). Both sides check it frame by frame.

**`seq` is a string in the fixture.** It's a `uint64`, and JS `JSON.parse` turns integers above 2^53 into lossy floats — a fixture shared by both sides can't have one side misread it. Go uses `strconv.ParseUint`, TS uses `BigInt(string)`.

`unknown_messages` pins down forward compatibility: both sides must **ignore** an unknown `t` value rather than treat it as an error.

The required tests are listed in [`../70-testing/strategy.md`](../70-testing/strategy.md). The two most important are **AC-2.1 byte-level continuity** (incremental) and **AC-2.21 screen-level consistency** (snapshot).
