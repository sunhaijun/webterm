# ADR-0006 The agent parses and strips OSC sequences

Status: Accepted (2026-09-06). Superseded by [ADR-0026](0026-agent-holds-terminal-state.md): the agent no longer parses or strips any OSC sequence, the output stream is counted as-is, and the working directory is read from `/proc`.

## Context

Shell integration reported the command line, exit code, CWD and prompt state through OSC escape sequences mixed into the PTY output. Someone had to parse them.

## Decision

**The agent parses them and strips them from the output stream.** Clients never see webterm's OSC sequences; the structured data goes out as separate JSON control messages.

```
PTY.Read() → OSC stripper ─┬─→ stripped bytes → ring buffer (out_seq) → client binary frames
                           └─→ control events → store + client JSON control messages
```

Key invariant: **`out_seq` advances after stripping.** `out_seq` is the cumulative number of bytes sent to the client. Counting before stripping would misalign resume slices and garble the screen. So stripping finishes before the ring buffer `append`, and nothing else in between rewrites the stream. This was added to the invariants in [CLAUDE.md](../../../CLAUDE.md).

Only the sequences webterm cares about (OSC 133, 7, 1701) were stripped. Everything else (titles, hyperlinks, clipboard) passed through untouched; stripping them would break terminal features.

`command.start` / `command.end` carried an `out_seq` field marking where the command's output started and ended in the stream. v0.1 didn't use it; it reserved room for a command-block view (fold, jump, copy a block) without a protocol change.

Rejected alternatives:

- **Parse in the client** (xterm.js `registerOscHandler`). The agent had to parse anyway: history goes to the database, CWD names sessions, prompt state drives `unread`. Two copies of one state machine would drift. History would also depend on a client being online (reload the page and commands go unrecorded), and OSC sequences split across network-determined frame boundaries are harder to test.
- **Parse on both sides.** Two sources of truth for the same data.

## Consequences

Positive:

- One source of truth; the client stays simple.
- History doesn't depend on a client being online.
- The parser is a pure streaming state machine and easy to test with arbitrary splits, malformed input and oversized payloads.

Negative: the agent needs a correct streaming OSC state machine. It must handle:

- splits at any byte across `Read()` calls;
- both terminators, `BEL` (`0x07`) and `ST` (`ESC \`);
- oversized payloads: cap them and give up past the cap, to bound memory;
- malformed payloads: ignore them without crashing or swallowing the output that follows.
