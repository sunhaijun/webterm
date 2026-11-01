# ADR-0009 Hybrid WebSocket framing: binary data, JSON control

Status: Accepted (2026-09-06). Amended by [ADR-0026](0026-agent-holds-terminal-state.md): adds the `SNAPSHOT` frame type (`0x03`, `flags` bit 0 = `MORE`), removes `ATTR_PREFIX`, and bumps the protocol version from 1 to 2. The rest of the frame layout is unchanged.

## Context

One WebSocket carries two very different kinds of traffic:

1. **Terminal bytes**: frequent, small, binary (UTF-8 may be split at any point), high volume.
2. **Control messages**: infrequent, structured, need to be readable and evolvable.

## Decision

### One WebSocket multiplexes all sessions

Each data frame header carries a `sid`. Sessions don't get their own connections, because:

- fewer connections are better on mobile (battery, handshakes, TLS sessions);
- there is **one reconnect path**, not N;
- control and data messages are naturally ordered within one connection;
- a single `hello` round trip resumes every session.

### Binary frames for data, JSON text frames for control

| WebSocket frame | Use | Format |
|---|---|---|
| **binary** | Terminal input/output bytes | 12-byte fixed header + raw payload |
| **text** | Control messages | JSON with a `t` field naming the type |

The WebSocket opcode tells them apart; no extra discriminator byte is needed.

Data isn't JSON because terminal output must carry arbitrary byte sequences, and JSON offers only two options:

- **base64**: 33% larger, plus encode/decode CPU on both sides. Bad for mobile data and battery.
- **JSON string escaping**: can't represent invalid UTF-8. PTY reads split multi-byte characters, and those half characters must pass through intact for the client's xterm to reassemble; otherwise the output is garbled.

Control messages aren't binary because they're infrequent (a handful per second). Readability, debugging from a packet capture, and adding fields without breaking compatibility are worth far more than a few dozen bytes.

### Binary frame layout

```
 0        1        2        3        4  ...  11    12 ...
+--------+--------+-----------------+-------------------+----------------
| type   | flags  |      sid        |       seq         |  payload
| uint8  | uint8  |     uint16      |      uint64       |  raw bytes
+--------+--------+-----------------+-------------------+----------------
                    big-endian         big-endian
```

- `type`: `0x01` = OUTPUT (agent → client), `0x02` = INPUT (client → agent).
- `flags`: reserved, must be 0. Receivers ignore unknown bits so they can be used later.
- `sid`: `uint16`. The per-machine session cap is 20 (configurable), so `uint16` is plenty.
- `seq`: for OUTPUT, the `out_seq` of the frame's **first** byte; for INPUT, the `in_seq` of its first byte.
- The header is a fixed 12 bytes, negligible next to typical output chunks of a few hundred bytes to a few KB.

### `seq` counts bytes, not messages

Resume needs **byte-level slicing**, not message replay:

```
client: "I have received 12345 bytes"
agent:  buf.Slice(from: 12345)  →  exact, no overlap, no gap
```

With message numbers, the agent would have to keep message boundaries, which are an accident of when the network happened to read. Re-chunking after a reconnect would also make boundaries inconsistent. Counting bytes removes the concept entirely: **message boundaries become irrelevant.**

This is also what lets the byte-level continuity test (AC-2.1) hold strictly.

### No compression (v0.1)

WebSocket `permessage-deflate` should compress terminal output well (lots of repeated escape sequences), but:

- it adds significant CPU and memory on both sides (a deflate context per connection);
- terminal output is mostly small packets, and flush boundaries eat most of the gain;
- it gets in the way of debugging byte-level continuity.

Off for now. If measurements show bandwidth is the bottleneck on mobile networks, evaluate it separately in a new ADR.

## Consequences

Positive:

- Zero encoding overhead; any byte goes through as-is.
- Resume reduces to one byte slice, simple enough to be hard to get wrong.
- The control protocol is readable, capturable and extensible.

Negative:

- The frontend and backend each need a frame codec (`internal/protocol` and `web/src/protocol`), and they must match exactly. Mitigation: both are unit-tested against the same fixture JSON of "input bytes → expected frame" vectors, so they can't drift.
- The client maintains its own `sid` → terminal instance routing.
