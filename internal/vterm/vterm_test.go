package vterm

import (
	"bytes"
	"encoding/json"
	"flag"
	"math/rand"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"

	"tuios.dev/vt/snapshot"
)

// update regenerates the snapshot golden files:
// go test ./internal/vterm -update (or UPDATE_GOLDEN=1).
//
// The goldens are the reference for the frontend check (AC-2.21): Vitest uses
// @xterm/headless to compare xterm fed the raw bytes against xterm fed the
// snapshot plus the bytes after the cut point, cell by cell. The Go side
// guarantees two things: snapshots are deterministic (same input, same bytes)
// and the emulator is self-consistent.
var update = flag.Bool("update", false, "regenerate the snapshot golden files in testdata/snap")

func updating() bool { return *update || os.Getenv("UPDATE_GOLDEN") == "1" }

const (
	recDir  = "testdata/rec"
	snapDir = "testdata/snap"
)

// recording is raw output captured from a real program (scrubbed; do not edit).
type recording struct {
	name       string
	data       []byte
	cols, rows int
}

func loadRecordings(t *testing.T) []recording {
	t.Helper()
	bins, err := filepath.Glob(filepath.Join(recDir, "*.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if len(bins) == 0 {
		t.Fatal("no recordings in testdata/rec")
	}
	sort.Strings(bins)
	out := make([]recording, 0, len(bins))
	for _, bin := range bins {
		name := strings.TrimSuffix(filepath.Base(bin), ".bin")
		data, err := os.ReadFile(bin)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := os.ReadFile(strings.TrimSuffix(bin, ".bin") + ".json")
		if err != nil {
			t.Fatal(err)
		}
		var meta struct {
			Cols  int `json:"cols"`
			Rows  int `json:"rows"`
			Bytes int `json:"bytes"`
		}
		if err := json.Unmarshal(raw, &meta); err != nil {
			t.Fatalf("%s.json: %v", name, err)
		}
		if meta.Cols <= 0 || meta.Rows <= 0 {
			t.Fatalf("%s.json is missing cols/rows", name)
		}
		if meta.Bytes != 0 && meta.Bytes != len(data) {
			t.Fatalf("%s.bin has %d bytes but its json says %d; was the fixture edited?", name, len(data), meta.Bytes)
		}
		out = append(out, recording{name: name, data: data, cols: meta.Cols, rows: meta.Rows})
	}
	return out
}

// cutPoints returns the cut points for a recording: 12 evenly spaced points,
// 10 deterministic random points, and the end, deduplicated and sorted.
//
// The random points deliberately ignore boundaries, so some land inside escape
// sequences or multibyte characters; that is why snapshots carry partially
// parsed sequences. The seed comes from the name length and total size, so
// every run gets the same points.
func cutPoints(name string, n int) []int {
	pts := make([]int, 0, 23)
	for i := 1; i <= 12; i++ {
		pts = append(pts, n*i/13)
	}
	r := rand.New(rand.NewSource(int64(len(name)*7919 + n)))
	for range 10 {
		pts = append(pts, 1+r.Intn(n-1)) // [1, n-1]
	}
	pts = append(pts, n)
	sort.Ints(pts)
	return slices.Compact(pts)
}

// cutEntry is one entry of cuts.json: k is the cut point (byte offset into the
// recording) and snap_bytes is the snapshot file length. The frontend uses
// <name>.<k>.snap as the snapshot and rec/<name>.bin[k:] as the stream after it.
type cutEntry struct {
	K         int `json:"k"`
	SnapBytes int `json:"snap_bytes"`
}

func snapPath(name string, k int) string {
	return filepath.Join(snapDir, name+"."+strconv.Itoa(k)+".snap")
}

// generate runs every recording and returns file name -> contents, including
// cuts.json.
func generate(t *testing.T, recs []recording) map[string][]byte {
	t.Helper()
	files := map[string][]byte{}
	cuts := map[string][]cutEntry{}
	for _, rec := range recs {
		for _, k := range cutPoints(rec.name, len(rec.data)) {
			term := New(rec.cols, rec.rows)
			term.Write(rec.data[:k])
			snap := term.Snapshot()
			files[snapPath(rec.name, k)] = snap
			cuts[rec.name] = append(cuts[rec.name], cutEntry{K: k, SnapBytes: len(snap)})
		}
	}
	idx, err := json.MarshalIndent(cuts, "", "  ") // map keys are sorted, so output is deterministic
	if err != nil {
		t.Fatal(err)
	}
	files[filepath.Join(snapDir, "cuts.json")] = append(idx, '\n')
	return files
}

// TestSnapshotGolden checks, without -update, that regenerated snapshots match
// the checked-in files byte for byte: snapshots are deterministic and nobody
// quietly changed the emulator version.
func TestSnapshotGolden(t *testing.T) {
	recs := loadRecordings(t)
	files := generate(t, recs)

	if updating() {
		if err := os.RemoveAll(snapDir); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(snapDir, 0o755); err != nil {
			t.Fatal(err)
		}
		for p, b := range files {
			if err := os.WriteFile(p, b, 0o644); err != nil {
				t.Fatal(err)
			}
		}
		t.Logf("regenerated %d golden files", len(files))
		return
	}

	for p, want := range files {
		got, err := os.ReadFile(p)
		if err != nil {
			t.Errorf("missing golden %s (generate with go test ./internal/vterm -update): %v", p, err)
			continue
		}
		if !bytes.Equal(got, want) {
			t.Errorf("%s differs from the regenerated result (%d vs %d bytes): snapshot is nondeterministic or emulator behavior changed", p, len(got), len(want))
		}
	}
	// Extra files are errors too: the frontend would treat them as references.
	on, err := filepath.Glob(filepath.Join(snapDir, "*"))
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range on {
		if _, ok := files[p]; !ok {
			t.Errorf("stray golden %s (-update removes it)", p)
		}
	}
}

// TestSnapshotIsDeterministic: the same input yields identical snapshots. The
// golden check depends on it.
func TestSnapshotIsDeterministic(t *testing.T) {
	for _, rec := range loadRecordings(t) {
		a, b := New(rec.cols, rec.rows), New(rec.cols, rec.rows)
		a.Write(rec.data)
		b.Write(rec.data)
		if !bytes.Equal(a.Snapshot(), b.Snapshot()) {
			t.Errorf("%s: two snapshots of the same input differ", rec.name)
		}
	}
}

// TestSnapshotSelfConsistent: emulator A consumes all bytes; emulator B
// consumes the snapshot at k and then the bytes after k. Their screens and
// snapshots must match, which shows on the Go side that the snapshot path
// joins up. The final screen-level check is xterm in the browser (frontend
// Vitest runs the same goldens).
func TestSnapshotSelfConsistent(t *testing.T) {
	for _, rec := range loadRecordings(t) {
		t.Run(rec.name, func(t *testing.T) {
			full := New(rec.cols, rec.rows)
			full.Write(rec.data)
			wantScreen, wantSnap := full.String(), full.Snapshot()

			for _, k := range cutPoints(rec.name, len(rec.data)) {
				src := New(rec.cols, rec.rows)
				src.Write(rec.data[:k])

				b := New(rec.cols, rec.rows)
				b.Write(src.Snapshot())
				b.Write(rec.data[k:])
				if got := b.String(); got != wantScreen {
					t.Errorf("k=%d: snapshot + remaining bytes renders a different screen than all bytes\ndirect:\n%s\nsnapshot:\n%s", k, wantScreen, got)
					continue
				}
				if !bytes.Equal(b.Snapshot(), wantSnap) {
					t.Errorf("k=%d: same screen but different state (modes / pen / history)", k)
				}
			}
		})
	}
}

// TestExportImportRoundTrip covers the emulator half of hot-upgrade handoff
// (ADR-0026 §8): the snapshot after Import matches the one before Export, and
// later output continues normally.
func TestExportImportRoundTrip(t *testing.T) {
	for _, rec := range loadRecordings(t) {
		t.Run(rec.name, func(t *testing.T) {
			for _, k := range cutPoints(rec.name, len(rec.data)) {
				a := New(rec.cols, rec.rows)
				a.Write(rec.data[:k])
				state, err := a.Export()
				if err != nil {
					t.Fatal(err)
				}
				b, err := Import(state)
				if err != nil {
					t.Fatalf("k=%d: %v", k, err)
				}
				if !bytes.Equal(a.Snapshot(), b.Snapshot()) {
					t.Fatalf("k=%d: snapshot after Import differs from before Export", k)
				}
				a.Write(rec.data[k:])
				b.Write(rec.data[k:])
				if !bytes.Equal(a.Snapshot(), b.Snapshot()) {
					t.Fatalf("k=%d: diverged after feeding the same bytes post-Import", k)
				}
			}
		})
	}
}

func TestImportRejectsGarbage(t *testing.T) {
	for _, in := range [][]byte{nil, []byte("{"), []byte(`{"width":0,"height":0}`)} {
		if _, err := Import(in); err == nil {
			t.Errorf("Import(%q) should fail", in)
		}
	}
}

// Scrollback is capped at HistoryLines.
func TestHistoryBounded(t *testing.T) {
	term := New(20, 5)
	var b bytes.Buffer
	for i := range HistoryLines + 500 {
		b.WriteString("line ")
		b.WriteString(strconv.Itoa(i))
		b.WriteString("\r\n")
	}
	term.Write(b.Bytes())
	if got := term.HistoryLen(); got != HistoryLines {
		t.Fatalf("history has %d lines, want %d", got, HistoryLines)
	}
}

// The emulator's own query replies must be discarded; the browser answers
// queries (ADR-0026 §5). This checks that no replies (DA / CPR / color query)
// are left pending after Write.
func TestResponsesDiscarded(t *testing.T) {
	term := New(80, 24)
	term.Write([]byte("\x1b[c\x1b[6n\x1b]11;?\x07\x1b[>c"))
	if r := term.t.TakeResponses(); len(r) != 0 {
		t.Fatalf("replies were not discarded: %q", r)
	}
}

// After a resize the snapshot draws at the new size (the agent is authoritative
// on column count, ADR-0026 §4).
func TestResize(t *testing.T) {
	term := New(80, 24)
	term.Write([]byte("hello"))
	term.Resize(100, 30)
	if c, r := term.Size(); c != 100 || r != 30 {
		t.Fatalf("size = %dx%d", c, r)
	}
	b := New(100, 30)
	b.Write(term.Snapshot())
	if b.String() != term.String() {
		t.Fatal("snapshot after resize does not reproduce the screen")
	}
	term.Resize(0, 0)
	if c, r := term.Size(); c != 1 || r != 1 {
		t.Fatalf("sizes below 1 should clamp to 1, got %dx%d", c, r)
	}
}

// denseWide is worst-case snapshot input: wide terminal, full history, a color
// change every 10 cells. At 400 columns an uncapped snapshot is about 1.6 MiB
// (measured in ADR-0026 §3).
func denseWide(cols, lines int) []byte {
	var b bytes.Buffer
	for i := range lines {
		for j := range cols / 10 {
			b.WriteString("\x1b[3" + strconv.Itoa(j%8) + ";4" + strconv.Itoa(7-j%8) + "m")
			s := strconv.Itoa(i)
			b.WriteString(strings.Repeat("0", 9-len(s)) + s + " ")
		}
		b.WriteString("\x1b[0m\r\n")
	}
	return b.Bytes()
}

// Snapshots are capped at 1 MiB (protocol §5.2). Over the cap, history is
// trimmed proportionally while the screen and modes are kept. The screen still
// matches feeding all bytes directly, and later output continues normally.
func TestSnapshotCappedAtOneMiB(t *testing.T) {
	const cols, rows = 400, 50
	data := denseWide(cols, HistoryLines+100)
	tail := []byte("\x1b[31mAFTER\x1b[0m tail\r\n")

	full := New(cols, rows)
	full.Write(data)
	if full.HistoryLen() != HistoryLines {
		t.Fatalf("precondition: history should be full, got %d lines", full.HistoryLen())
	}
	if n := len(snapshot.Replay(full.capture(HistoryLines))); n <= MaxSnapshotBytes {
		t.Fatalf("precondition: uncapped snapshot should exceed 1 MiB, got only %d bytes", n)
	}

	snap := full.Snapshot()
	if len(snap) > MaxSnapshotBytes {
		t.Fatalf("snapshot is %d bytes, over the %d cap", len(snap), MaxSnapshotBytes)
	}
	b := New(cols, rows)
	b.Write(snap)
	if b.String() != full.String() {
		t.Fatal("screen differs after trimming history")
	}
	if b.HistoryLen() == 0 || b.HistoryLen() >= HistoryLines {
		t.Fatalf("history should shrink proportionally, not vanish or stay full; got %d lines", b.HistoryLen())
	}
	full.Write(tail)
	b.Write(tail)
	if b.String() != full.String() {
		t.Fatal("output after the snapshot does not continue correctly")
	}
}

// When even a history-free snapshot is over the cap (the screen itself is huge),
// it is still produced without history; the screen is never trimmed.
func TestSnapshotCapNeverDropsScreen(t *testing.T) {
	const cols, rows = 1000, 1000
	term := New(cols, rows)
	term.Write(denseWide(cols, rows+50))
	snap := term.Snapshot()
	b := New(cols, rows)
	b.Write(snap)
	if b.String() != term.String() {
		t.Fatal("screen was trimmed")
	}
}

// UT-name-2 (emulator side): title and write count (ADR-0043 §2). Rewriting the
// same title still counts, because the session uses the count to tell that the
// foreground program set a title, even when a new process sets an identical
// one. Export / Import keeps the title and restarts the count.
func TestTitleAndWrites(t *testing.T) {
	term := New(80, 24)
	if title, n := term.Title(); title != "" || n != 0 {
		t.Fatalf("new emulator = (%q, %d)", title, n)
	}
	term.Write([]byte("\x1b]0;✳ Claude Code\x07"))
	if title, n := term.Title(); title != "✳ Claude Code" || n != 1 {
		t.Fatalf("after OSC 0 = (%q, %d)", title, n)
	}
	term.Write([]byte("\x1b]2;✳ Claude Code\x1b\\")) // same title, OSC 2, ST-terminated
	if title, n := term.Title(); title != "✳ Claude Code" || n != 2 {
		t.Fatalf("same title again = (%q, %d), count should go up by 1", title, n)
	}
	term.Write([]byte("\x1b]0;◐ Claude"))
	term.Write([]byte(" Code\x07")) // split across two writes
	if title, n := term.Title(); title != "◐ Claude Code" || n != 3 {
		t.Fatalf("split OSC = (%q, %d)", title, n)
	}
	term.Write([]byte("\x1b]1;icon only\x07")) // icon name only, not the title
	if title, n := term.Title(); title != "◐ Claude Code" || n != 3 {
		t.Fatalf("after OSC 1 = (%q, %d)", title, n)
	}

	data, err := term.Export()
	if err != nil {
		t.Fatal(err)
	}
	back, err := Import(data)
	if err != nil {
		t.Fatal(err)
	}
	if title, n := back.Title(); title != "◐ Claude Code" || n != 0 {
		t.Fatalf("after Import = (%q, %d), want title kept and count at 0", title, n)
	}
	back.Write([]byte("\x1b]0;✳ Claude Code\x07"))
	if _, n := back.Title(); n != 1 {
		t.Fatalf("count after one write post-Import = %d", n)
	}
}
