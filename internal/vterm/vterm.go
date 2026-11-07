// Package vterm is the agent-side terminal emulator each session keeps
// (ADR-0026 §1).
//
// It wraps tuios.dev/vt (pinned at v0.3.2). Session code reaches the emulator
// only through the methods here: write, resize, snapshot, export / import.
// Swapping the implementation should touch only this package.
//
// Terminal is not locked; callers must ensure one goroutine at a time. The
// session updates it under the same lock as the ring buffer, so the number of
// bytes the emulator has consumed always equals head_seq, and a snapshot's
// seq is head_seq at that moment (protocol §5.2).
package vterm

import (
	"encoding/json"
	"errors"
	"fmt"

	"tuios.dev/vt"
	"tuios.dev/vt/snapshot"
)

// HistoryLines is how many scrollback lines the emulator keeps and a snapshot
// carries. The two match; keeping more would be pointless since it can't be sent.
const HistoryLines = 2000

// Terminal is a terminal emulator. The zero value is not usable; construct one
// with New or Import.
type Terminal struct {
	t *vt.Emulator
	// titleWrites counts OSC 0 / 2 title sets, including repeats of the same
	// title. The session uses it to tell whether the foreground program has set
	// a title (ADR-0043 §2). Incremented only under Write, so it shares the
	// emulator's lock.
	titleWrites uint64
	// signals counts bells and desktop notifications (BEL, OSC 9 / 777 / 99;
	// not OSC 9;4 progress or 9;9 working directory). The session turns a
	// change into "waiting for you" (ADR-0052 §1). Like titleWrites, it only
	// changes under Write.
	signals uint64
}

// New returns a cols x rows emulator with HistoryLines of scrollback.
func New(cols, rows int) *Terminal {
	e := vt.NewEmulator(max(cols, 1), max(rows, 1))
	e.SetScrollbackMaxLines(HistoryLines)
	// The browser answers kitty graphics uploads (§5). Disabling answers here
	// also stops the emulator from opening server files for f / t media.
	e.SetKittyUploadAnswers(false)
	t := &Terminal{t: e}
	t.setCallbacks()
	return t
}

// setCallbacks installs the counters. The callbacks only count: they run
// inside the emulator's parser, under the session lock.
func (t *Terminal) setCallbacks() {
	t.t.SetCallbacks(vt.Callbacks{
		Title:  func(string) { t.titleWrites++ },
		Bell:   func() { t.signals++ },
		Notify: func(string, string) { t.signals++ },
	})
}

// Signals returns how many bells and desktop notifications the output has had
// since this emulator was created or imported.
func (t *Terminal) Signals() uint64 { return t.signals }

// Title returns the window title (as set by OSC 0 / 2, unsanitized) and how many
// times it has been set. An imported emulator keeps the exported title, with
// the count reset to 0.
func (t *Terminal) Title() (title string, writes uint64) {
	return t.t.Titles().Title, t.titleWrites
}

// Write feeds raw PTY output to the emulator.
//
// Query replies the emulator generates (DA, CPR, color queries, ...) are
// discarded. xterm.js in the browser answers queries, and its capabilities and
// theme colors are the ones that count (ADR-0026 §5). If the emulator answered,
// programs would detect tuios's capabilities and switch to encodings the
// browser doesn't understand.
func (t *Terminal) Write(p []byte) {
	if len(p) == 0 {
		return
	}
	_, _ = t.t.Write(p)
	_ = t.t.TakeResponses()
}

// Resize changes the screen size, clamping values below 1 to 1. The emulator's
// reflow is authoritative (ADR-0026 §4).
func (t *Terminal) Resize(cols, rows int) {
	t.t.Resize(max(cols, 1), max(rows, 1))
	_ = t.t.TakeResponses()
}

// Size returns the current screen size.
func (t *Terminal) Size() (cols, rows int) { return t.t.Width(), t.t.Height() }

// MaxSnapshotBytes caps snapshot size (protocol §5.2). Ordinary content with a
// full 2000 lines is a few hundred KiB at most, but a wide terminal with dense
// color changes can reach several MiB. That overflows the connection's write
// queue (4 MiB), the connection drops, the reconnect asks for another snapshot,
// and the loop repeats.
const MaxSnapshotBytes = 1 << 20

// Snapshot returns bytes any xterm-compatible terminal can consume. Starting
// from a cleared terminal, they draw up to HistoryLines of scrollback, the
// current screen, modes, pen, scroll region, charsets, tab stops, the cursor,
// and any partially parsed sequence (last, so subsequent output completes it).
//
// If the result exceeds MaxSnapshotBytes, it is regenerated once with
// proportionally fewer history lines (with 10% headroom). The screen and modes
// are never trimmed. One retry is enough: size is roughly proportional to line
// count, so any remaining excess comes from the screen itself, which must stay.
func (t *Terminal) Snapshot() []byte {
	b := snapshot.Replay(t.capture(HistoryLines))
	if len(b) <= MaxSnapshotBytes {
		return b
	}
	carried := min(HistoryLines, t.t.ScrollbackLen())
	lines := int(float64(carried) * float64(MaxSnapshotBytes) / float64(len(b)) * 0.9)
	return snapshot.Replay(t.capture(lines))
}

// capture reads the state with up to lines of history; lines <= 0 means none.
// snapshot.Capture treats 0 as "default", so no history needs a negative value.
func (t *Terminal) capture(lines int) *snapshot.State {
	if lines <= 0 {
		lines = -1
	}
	return snapshot.Capture(t.t, t.t.Width(), t.t.Height(), lines, 0)
}

// String returns the current screen as plain text, for tests and debugging.
func (t *Terminal) String() string { return t.t.String() }

// HistoryLen returns the number of scrollback lines.
func (t *Terminal) HistoryLen() int { return t.t.ScrollbackLen() }

// Export returns the full state, with all HistoryLines of scrollback, for
// hot-upgrade handoff (ADR-0026 §8). The format is opaque; the only guarantee
// is that Import reads it back.
func (t *Terminal) Export() ([]byte, error) {
	st, finish := snapshot.CapturePacked(t.t, t.t.Width(), t.t.Height(), HistoryLines, 0)
	finish()
	b, err := json.Marshal(st)
	if err != nil {
		return nil, fmt.Errorf("vterm: encode state: %w", err)
	}
	return b, nil
}

// Import rebuilds an emulator from Export's output. Snapshots taken after
// Import are byte-identical to those taken before Export.
func Import(data []byte) (*Terminal, error) {
	if len(data) == 0 {
		return nil, errors.New("vterm: empty state")
	}
	var st snapshot.State
	if err := json.Unmarshal(data, &st); err != nil {
		return nil, fmt.Errorf("vterm: decode state: %w", err)
	}
	if st.Width <= 0 || st.Height <= 0 {
		return nil, fmt.Errorf("vterm: invalid state size %dx%d", st.Width, st.Height)
	}
	t := New(st.Width, st.Height)
	if err := snapshot.Apply(t.t, &st); err != nil {
		return nil, fmt.Errorf("vterm: import state: %w", err)
	}
	_ = t.t.TakeResponses()
	t.titleWrites = 0 // a restored title was not set by the program
	t.signals = 0     // and restoring rang no bells
	return t, nil
}
