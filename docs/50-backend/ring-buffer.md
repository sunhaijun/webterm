# Ring buffer

> Status: Accepted
>
> The basis for incremental resume (AC-2.1). `internal/ringbuf`. Clients that fall outside the window get a snapshot, which isn't this component's job ([ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md)).

## Where it sits in the output path

Each session's PTY output goes two places **under one lock**: it's appended to the ring buffer and fed to the terminal emulator (`internal/vterm`). The ring buffer answers a single question: "the client says it's at `out_seq`; can I still send it the raw bytes it's missing, exactly as they were?" If yes, that's incremental resume; if not, the emulator produces a snapshot ([protocol §5.1](../30-protocol/websocket-protocol.md)).

So it **doesn't** have to care where a replay starts: everything outside the buffer goes through a snapshot, and inside the buffer the replay always starts at the `out_seq` the client reported, where the client's terminal state is complete.

## Contract

```go
type Buffer struct { … }

// New creates a buffer of capacity bytes. Default 256 KiB (--ring-bytes).
func New(capacity int) *Buffer

// Append appends p and returns the seq of its FIRST byte. When space runs out, it trims bytes from the head.
func (b *Buffer) Append(p []byte) (seq uint64)

// Slice returns everything from from onward.
//   from ∈ [BaseSeq, HeadSeq] → (data, true)
//   otherwise                → (nil, false)   the caller falls back to a snapshot
func (b *Buffer) Slice(from uint64) (data []byte, ok bool)

func (b *Buffer) BaseSeq() uint64 // seq of the first retained byte
func (b *Buffer) HeadSeq() uint64 // total bytes ever appended
```

## Invariants (enforced by unit tests)

1. **`HeadSeq()` always equals the total number of bytes ever passed to `Append`.** Trimming doesn't affect it.
2. **`BaseSeq() == HeadSeq() - len(retained)`**.
3. **`Slice(HeadSeq())` returns empty and `ok`.** (A client that's fully caught up has nothing missing.)
4. **`Slice(BaseSeq())` returns everything retained.**
5. For any `from ∈ [BaseSeq, HeadSeq]`, the length of `Slice(from)` `== HeadSeq - from`.
6. When a single `Append` exceeds capacity, only the last `capacity` bytes are kept, and `HeadSeq` still advances by the full length.

Invariant 5 is the mathematical basis of **byte-level continuity** (AC-2.1): when the client says "I'm at N", the slice is exactly the bytes it's missing, no more, no less.

## Trimming

When space runs out, drop exactly enough bytes from the head and advance `BaseSeq`. **Don't look for `\n` boundaries, and don't insert anything before a replay**: a client that needs trimmed bytes gets a snapshot instead, so a replay never starts in the middle of a cut-off escape sequence.

## Export and restore (ADR-0016)

A hot upgrade hands the buffer over to the new process: `Export()` returns `(base_seq, copy of the retained bytes)`, and `Restore(capacity, base, data)` rebuilds it in the new process. Invariants:

- After `Restore(Export())`, `BaseSeq` / `HeadSeq` are **exactly** what they were at export, and for any `from ∈ [base, head]`, `Slice(from)` is byte-identical — the cross-process version of AC-2.1.
- If `data` is larger than the new capacity, only the last `capacity` bytes are kept and `base` advances accordingly; `HeadSeq` doesn't change (the same rule as an oversized `Append`). Shrinking `--ring-bytes` across an upgrade can't corrupt seqs.

The emulator's state is exported separately by `internal/vterm`; see [session-manager.md](session-manager.md).

## Implementation

A classic ring over **a single `[]byte` plus positions**, not a chain of `bytes.Buffer`s:

- `Slice` must return contiguous data, so a wrapped buffer needs one copy to join the two halves. Acceptable: resume isn't a hot path.
- `Append` is the hot path and must not allocate: `copy` into the preallocated array, never grow it.
- Capacity is fixed at creation and never grows.

```go
type Buffer struct {
    buf   []byte    // fixed capacity
    start int       // index in buf of the first retained byte
    n     int       // retained length, n <= capacity
    base  uint64    // seq at start
}
```

`HeadSeq() = base + uint64(n)`.

## Required tests

| ID | Case |
|---|---|
| UT-ring-1 | After sequential Appends, `Slice(k)` has length `Head - k` for every `k ∈ [0, Head]` |
| UT-ring-2 | After overflowing, `Slice(k < BaseSeq)` returns `(nil, false)`; `Slice(BaseSeq)` returns the last capacity bytes |
| UT-ring-5 | `Slice` joins correctly when the content wraps (`start + n > capacity`) |
| UT-ring-6 | A single Append larger than capacity: only the tail is kept, `HeadSeq` advances by the full length |
| UT-ring-7 | `Slice(HeadSeq())` returns empty + `true`; `Slice(HeadSeq()+1)` returns `(nil, false)` |
| UT-ring-8 | Fuzz: random Append/Slice sequences; invariants 1–6 always hold |
| UT-ring-9 | `Append` doesn't allocate in steady state (`testing.AllocsPerRun == 0`) |
| UT-ring-10 | `BaseSeq` / `HeadSeq` / any `Slice` are byte-identical before and after `Restore(Export())`; with a smaller new capacity only the tail is kept |

UT-ring-3 (trim at `\n` boundaries) and UT-ring-4 (`ESC[0m` prefix) were removed with ADR-0026; their numbers aren't reused. The UT-ring-8 fuzz test is the most valuable test in this module: ring buffer bugs almost always live in edge cases, and randomization hits them more reliably than hand-written cases.
