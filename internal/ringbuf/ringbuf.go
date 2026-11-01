// Package ringbuf is the per-session output ring buffer that backs incremental
// resume (AC-2.1).
//
// The contract and invariants live in docs/50-backend/ring-buffer.md. The key
// one: for every from in [BaseSeq, HeadSeq], len(Slice(from)) == HeadSeq-from,
// exactly. Byte-level continuity (AC-2.1) rests on it.
//
// It serves only the incremental path (ADR-0026 §3). A client that has fallen
// out of the window gets an emulator snapshot instead, so trimming is plain
// byte-wise: no searching for line boundaries, nothing injected before replay.
package ringbuf

// Buffer is a classic ring over a single []byte. Capacity is fixed. Append is
// the hot path and does not allocate in steady state.
//
// Buffer is not locked. Callers must update its contents and the session's seq
// under the same lock (see the locking rules in
// docs/50-backend/session-manager.md).
type Buffer struct {
	buf   []byte
	start int    // index in buf of the first retained byte
	n     int    // retained length, n <= cap(buf)
	base  uint64 // seq of the byte at start
}

// New returns a buffer holding capacity bytes. capacity must be positive.
func New(capacity int) *Buffer {
	if capacity <= 0 {
		panic("ringbuf: capacity must be positive")
	}
	return &Buffer{buf: make([]byte, capacity)}
}

// Cap returns the capacity in bytes.
func (b *Buffer) Cap() int { return len(b.buf) }

// BaseSeq returns the seq of the oldest retained byte.
func (b *Buffer) BaseSeq() uint64 { return b.base }

// HeadSeq returns the total number of bytes ever appended. Trimming does not
// change it.
func (b *Buffer) HeadSeq() uint64 { return b.base + uint64(b.n) }

// Append appends p and returns the seq of its first byte. When space runs out
// it trims exactly enough bytes from the front.
func (b *Buffer) Append(p []byte) (seq uint64) {
	seq = b.HeadSeq()
	total := len(p)
	if total == 0 {
		return seq
	}
	capacity := len(b.buf)

	// A single append larger than the buffer keeps only its last capacity bytes,
	// but HeadSeq still advances by the full length.
	if total >= capacity {
		copy(b.buf, p[total-capacity:])
		b.start = 0
		b.n = capacity
		b.base = seq + uint64(total-capacity)
		return seq
	}

	if free := capacity - b.n; free < total {
		b.trim(total - free)
	}

	w := b.start + b.n
	if w >= capacity {
		w -= capacity
	}
	k := copy(b.buf[w:], p)
	if k < total {
		copy(b.buf, p[k:])
	}
	b.n += total
	return seq
}

// trim drops exactly need bytes from the front.
func (b *Buffer) trim(need int) {
	if need >= b.n {
		b.base += uint64(b.n)
		b.start = 0
		b.n = 0
		return
	}
	b.start += need
	if b.start >= len(b.buf) {
		b.start -= len(b.buf)
	}
	b.n -= need
	b.base += uint64(need)
}

// Slice returns everything from seq from onward.
//
//	from in [BaseSeq, HeadSeq]            -> (missing bytes, true)
//	otherwise (trimmed away, or past head) -> (nil, false); caller falls back to a snapshot
//
// The result is a copy the caller may keep.
func (b *Buffer) Slice(from uint64) (data []byte, ok bool) {
	if from < b.base || from > b.HeadSeq() {
		return nil, false
	}
	off := int(from - b.base)
	return b.copyRange(off, b.n-off), true
}

func (b *Buffer) copyRange(off, length int) []byte {
	out := make([]byte, length)
	if length == 0 {
		return out
	}
	s := b.start + off
	if s >= len(b.buf) {
		s -= len(b.buf)
	}
	k := copy(out, b.buf[s:])
	if k < length {
		copy(out[k:], b.buf)
	}
	return out
}

// Export returns a copy of all retained bytes and the seq of the first one,
// for hot-upgrade handoff (ADR-0016). It is equivalent to Slice(BaseSeq()); the
// separate name makes call sites say what they mean.
func (b *Buffer) Export() (base uint64, data []byte) {
	return b.base, b.copyRange(0, b.n)
}

// Restore rebuilds a buffer from Export's output in the new process.
//
// Invariant: after Restore(capacity, Export()), BaseSeq and HeadSeq match the
// exported buffer and Slice(from) is byte-identical for every from in
// [base, head] (AC-2.1 across processes). If data exceeds capacity, only the
// last capacity bytes are kept and base moves forward while HeadSeq stays put,
// matching the oversized-Append rule. Shrinking --ring-bytes across an upgrade
// therefore cannot corrupt seq numbers.
func Restore(capacity int, base uint64, data []byte) *Buffer {
	b := New(capacity)
	if len(data) > capacity {
		base += uint64(len(data) - capacity)
		data = data[len(data)-capacity:]
	}
	copy(b.buf, data)
	b.start = 0
	b.n = len(data)
	b.base = base
	return b
}
