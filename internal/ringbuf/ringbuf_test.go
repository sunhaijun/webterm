package ringbuf_test

import (
	"bytes"
	"fmt"
	"math/rand"
	"testing"

	"github.com/sunhaijun/webterm/internal/ringbuf"
)

// checkInvariants asserts invariants 1-5 from docs/50-backend/ring-buffer.md.
func checkInvariants(t *testing.T, b *ringbuf.Buffer, totalAppended uint64) {
	t.Helper()
	// 1. HeadSeq always equals the total bytes ever appended.
	if b.HeadSeq() != totalAppended {
		t.Fatalf("HeadSeq = %d, want %d", b.HeadSeq(), totalAppended)
	}
	// 2. BaseSeq == HeadSeq - len(retained); 4. Slice(BaseSeq) returns everything retained.
	all, ok := b.Slice(b.BaseSeq())
	if !ok || b.BaseSeq()+uint64(len(all)) != b.HeadSeq() {
		t.Fatalf("BaseSeq(%d) + len(retained)(%d) != HeadSeq(%d)", b.BaseSeq(), len(all), b.HeadSeq())
	}
	// 3. Slice(HeadSeq()) returns empty and ok.
	d, ok := b.Slice(b.HeadSeq())
	if len(d) != 0 || !ok {
		t.Fatalf("Slice(HeadSeq) = %q/%v, want empty/true", d, ok)
	}
	// 5. For every from in [Base, Head], len(Slice(from)) == Head - from.
	for from := b.BaseSeq(); from <= b.HeadSeq(); from++ {
		d, ok := b.Slice(from)
		if !ok {
			t.Fatalf("Slice(%d) is inside the window but reported not resumable", from)
		}
		if uint64(len(d)) != b.HeadSeq()-from {
			t.Fatalf("len(Slice(%d)) = %d, want %d", from, len(d), b.HeadSeq()-from)
		}
	}
}

// UT-ring-1: after sequential appends, Slice(k) for every k in [0, Head] has
// length Head-k and equals the matching tail of the original stream.
func TestRing1_SliceLengthAndContent(t *testing.T) {
	b := ringbuf.New(4096)
	var stream []byte
	for i := 0; i < 50; i++ {
		chunk := []byte(fmt.Sprintf("line-%02d\n", i))
		if got := b.Append(chunk); got != uint64(len(stream)) {
			t.Fatalf("Append returned seq = %d, want %d", got, len(stream))
		}
		stream = append(stream, chunk...)
	}
	checkInvariants(t, b, uint64(len(stream)))
	for k := uint64(0); k <= b.HeadSeq(); k++ {
		d, _ := b.Slice(k)
		if !bytes.Equal(d, stream[k:]) {
			t.Fatalf("Slice(%d) content mismatch", k)
		}
	}
}

// UT-ring-2: after overflow, Slice(k < BaseSeq) returns (nil, false) and
// Slice(BaseSeq) returns the last capacity bytes.
func TestRing2_OverflowFallsOutOfWindow(t *testing.T) {
	const capacity = 256
	b := ringbuf.New(capacity)
	var stream []byte
	for i := 0; i < 100; i++ {
		chunk := []byte(fmt.Sprintf("%03d\n", i))
		b.Append(chunk)
		stream = append(stream, chunk...)
	}
	if d, ok := b.Slice(0); ok || d != nil {
		t.Fatalf("Slice(0) = %q/%v, want nil/false (trimmed, caller falls back to snapshot)", d, ok)
	}
	d, ok := b.Slice(b.BaseSeq())
	if !ok || len(d) != capacity {
		t.Fatalf("Slice(Base) len = %d ok=%v, want %d/true", len(d), ok, capacity)
	}
	if !bytes.Equal(d, stream[len(stream)-capacity:]) {
		t.Fatal("retained bytes are not the tail of the stream")
	}
	checkInvariants(t, b, uint64(len(stream)))
}

// Trimming is byte-exact and does not look for line boundaries (ADR-0026 §3).
func TestRingTrimIsExact(t *testing.T) {
	b := ringbuf.New(64)
	b.Append(bytes.Repeat([]byte("ab\n"), 20)) // 60 bytes
	before := b.BaseSeq()
	b.Append([]byte("xxxxxxxx")) // 8 bytes, needs 4 freed
	if got := b.BaseSeq() - before; got != 4 {
		t.Fatalf("trimmed %d bytes, want exactly 4", got)
	}
}

// UT-ring-5: Slice stitches correctly when the content wraps (start + n > capacity).
func TestRing5_WrapAround(t *testing.T) {
	b := ringbuf.New(16)
	b.Append([]byte("0123456789")) // 10
	b.Append([]byte("ABCDEFGHIJ")) // 10 more: trims and wraps
	all, _ := b.Slice(b.BaseSeq())
	if len(all) != 16 {
		t.Fatalf("retained %d bytes, want 16", len(all))
	}
	if !bytes.Equal(all, []byte("456789ABCDEFGHIJ")) {
		t.Fatalf("content after wrap = %q", all)
	}
	checkInvariants(t, b, 20)
}

// UT-ring-6: a single Append larger than capacity keeps only the tail, and
// HeadSeq advances by the full length.
func TestRing6_SingleAppendExceedsCapacity(t *testing.T) {
	b := ringbuf.New(8)
	seq := b.Append([]byte("0123456789ABCDEF")) // 16 bytes into an 8-byte buffer
	if seq != 0 {
		t.Fatalf("first seq = %d, want 0", seq)
	}
	if b.HeadSeq() != 16 {
		t.Fatalf("HeadSeq = %d, want 16 (must advance by the full length)", b.HeadSeq())
	}
	if b.BaseSeq() != 8 {
		t.Fatalf("BaseSeq = %d, want 8", b.BaseSeq())
	}
	d, _ := b.Slice(8)
	if string(d) != "89ABCDEF" {
		t.Fatalf("retained = %q, want %q", d, "89ABCDEF")
	}
	checkInvariants(t, b, 16)
}

// UT-ring-7: Slice(HeadSeq()) returns empty + true; Slice(HeadSeq()+1) returns (nil, false).
func TestRing7_ClientAhead(t *testing.T) {
	b := ringbuf.New(64)
	b.Append([]byte("hello"))

	d, ok := b.Slice(b.HeadSeq())
	if d == nil || len(d) != 0 || !ok {
		t.Fatalf("Slice(Head) = %v/%v, want non-nil empty slice + true", d, ok)
	}
	d, ok = b.Slice(b.HeadSeq() + 1)
	if d != nil || ok {
		t.Fatalf("Slice(Head+1) = %v/%v, want nil + false (client ahead, snapshot)", d, ok)
	}
}

// UT-ring-8: random Append/Slice sequences; the invariants must always hold.
// Ring buffer bugs live at the edges, which randomized input hits more often
// than hand-written cases.
func TestRing8_Fuzz(t *testing.T) {
	rng := rand.New(rand.NewSource(20260906))
	for iter := 0; iter < 200; iter++ {
		capacity := 1 + rng.Intn(512)
		b := ringbuf.New(capacity)
		var stream []byte
		for step := 0; step < 60; step++ {
			n := rng.Intn(capacity*2 + 4)
			chunk := make([]byte, n)
			for i := range chunk {
				chunk[i] = byte(rng.Intn(256))
			}
			seq := b.Append(chunk)
			if seq != uint64(len(stream)) {
				t.Fatalf("iter %d step %d: Append seq = %d, want %d", iter, step, seq, len(stream))
			}
			stream = append(stream, chunk...)

			if b.HeadSeq() != uint64(len(stream)) {
				t.Fatalf("iter %d: HeadSeq = %d, want %d", iter, b.HeadSeq(), len(stream))
			}
			retained, _ := b.Slice(b.BaseSeq())
			if b.BaseSeq()+uint64(len(retained)) != b.HeadSeq() {
				t.Fatalf("iter %d: BaseSeq + len != HeadSeq", iter)
			}
			if len(retained) > capacity {
				t.Fatalf("iter %d: retained %d bytes, exceeds capacity %d", iter, len(retained), capacity)
			}
			if !bytes.Equal(retained, stream[b.BaseSeq():]) {
				t.Fatalf("iter %d step %d: retained bytes differ from the stream", iter, step)
			}
			// Corollary of invariant 6: once the stream exceeds capacity, exactly
			// capacity bytes are retained (byte-wise trimming, never more).
			if len(stream) >= capacity && len(retained) != capacity {
				t.Fatalf("iter %d: stream length %d >= capacity %d but only %d bytes retained", iter, len(stream), capacity, len(retained))
			}
			// A random cut must be exact in both length and content.
			if h := b.HeadSeq(); h > b.BaseSeq() {
				from := b.BaseSeq() + uint64(rng.Int63n(int64(h-b.BaseSeq())))
				d, ok := b.Slice(from)
				if !ok || uint64(len(d)) != h-from || !bytes.Equal(d, stream[from:]) {
					t.Fatalf("iter %d: Slice(%d) is not exact", iter, from)
				}
			}
			// Overwritten positions must report not resumable.
			if b.BaseSeq() > 0 {
				if d, ok := b.Slice(b.BaseSeq() - 1); ok || d != nil {
					t.Fatalf("iter %d: Slice(Base-1) should be (nil, false)", iter)
				}
			}
		}
	}
}

// UT-ring-9: Append does not allocate in steady state (hot path).
func TestRing9_AppendZeroAlloc(t *testing.T) {
	b := ringbuf.New(1 << 20)
	chunk := bytes.Repeat([]byte("x"), 4096)
	b.Append(chunk) // warm up
	if got := testing.AllocsPerRun(200, func() { b.Append(chunk) }); got != 0 {
		t.Fatalf("Append allocates %v times per call, want 0", got)
	}
}

// UT-ring-10: Export/Restore round trip (ADR-0016 hot-upgrade handoff).
//
// After handoff the new process must have identical seqs and bytes. Otherwise a
// reconnecting client slices at the wrong out_seq and AC-2.1 breaks across the
// process boundary.
func TestExportRestoreRoundTrip(t *testing.T) {
	b := ringbuf.New(64)
	// Write until both wrapping and trimming have happened.
	for i := 0; i < 30; i++ {
		b.Append([]byte("line-" + string(rune('a'+i%26)) + "\n"))
	}
	base, data := b.Export()
	if base != b.BaseSeq() || uint64(len(data)) != b.HeadSeq()-b.BaseSeq() {
		t.Fatalf("Export is inconsistent: base=%d BaseSeq=%d len=%d span=%d", base, b.BaseSeq(), len(data), b.HeadSeq()-b.BaseSeq())
	}
	r := ringbuf.Restore(64, base, data)
	if r.BaseSeq() != b.BaseSeq() || r.HeadSeq() != b.HeadSeq() {
		t.Fatalf("seqs changed: base %d->%d head %d->%d", b.BaseSeq(), r.BaseSeq(), b.HeadSeq(), r.HeadSeq())
	}
	for from := b.BaseSeq(); from <= b.HeadSeq(); from++ {
		want, wok := b.Slice(from)
		got, gok := r.Slice(from)
		if wok != gok || string(want) != string(got) {
			t.Fatalf("Slice(%d) differs", from)
		}
	}
	// Appending after Restore behaves like the original, even though the wrap
	// position differs.
	b.Append([]byte("after"))
	r.Append([]byte("after"))
	bs, _ := b.Slice(b.BaseSeq())
	rs, _ := r.Slice(r.BaseSeq())
	if string(bs) != string(rs) {
		t.Fatal("appends after Restore diverge from the original")
	}
}

// Shrinking --ring-bytes across an upgrade keeps only the tail: HeadSeq stays,
// base moves forward.
func TestRestoreIntoSmallerCapacity(t *testing.T) {
	b := ringbuf.New(128)
	for i := 0; i < 10; i++ {
		b.Append([]byte("0123456789"))
	}
	base, data := b.Export()
	r := ringbuf.Restore(32, base, data)
	if r.HeadSeq() != b.HeadSeq() {
		t.Fatalf("HeadSeq changed: %d -> %d", b.HeadSeq(), r.HeadSeq())
	}
	if r.BaseSeq() != b.HeadSeq()-32 {
		t.Fatalf("base should move to head-32=%d, got %d", b.HeadSeq()-32, r.BaseSeq())
	}
	got, ok := r.Slice(r.BaseSeq())
	want, _ := b.Slice(b.HeadSeq() - 32)
	if !ok || string(got) != string(want) {
		t.Fatalf("retained bytes are not the last 32")
	}
	// The old base is now outside the window.
	if _, ok := r.Slice(base); ok {
		t.Fatal("a trimmed position should report not resumable")
	}
}
