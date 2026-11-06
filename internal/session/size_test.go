package session_test

import (
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/sunhaijun/webterm/internal/protocol"
)

// sizeEvents returns the session.updated{cols, rows} a connection received for
// sid, in arrival order.
func sizeEvents(t *testing.T, c *fakeConn, sid uint16) [][2]uint16 {
	t.Helper()
	var out [][2]uint16
	for _, e := range c.Events() {
		u, ok := e.(*protocol.SessionUpdated)
		if !ok || u.SID != sid || (u.Cols == nil && u.Rows == nil) {
			continue
		}
		if u.Cols == nil || u.Rows == nil {
			t.Fatalf("session.updated carries only one of cols/rows: %+v", u)
		}
		out = append(out, [2]uint16{*u.Cols, *u.Rows})
	}
	return out
}

func lastSize(t *testing.T, c *fakeConn, sid uint16) ([2]uint16, int) {
	t.Helper()
	ev := sizeEvents(t, c, sid)
	if len(ev) == 0 {
		return [2]uint16{}, 0
	}
	return ev[len(ev)-1], len(ev)
}

// IT-size-1: every connection, subscribed or not, hears about each size change
// (AC-4.14, ADR-0050 §5), after the snapshot the change produced, in the order
// the changes were applied.
func TestITSize1_SizeBroadcast(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	sub := newConn(t, m, "sub")
	other := newConn(t, m, "other") // an observer that never subscribes
	s.Subscribe(sub, 0, 0, 0)
	waitFor(t, "shell ready", func() bool { return s.HeadSeq() > 0 })

	if got, n := lastSize(t, other, s.SID()); n != 0 {
		t.Fatalf("subscribe without a size broadcast a size: %v", got)
	}

	// resize
	if err := s.Resize(100, 30); err != nil {
		t.Fatal(err)
	}
	for _, c := range []*fakeConn{sub, other} {
		if got, n := lastSize(t, c, s.SID()); n != 1 || got != [2]uint16{100, 30} {
			t.Fatalf("%s after resize: last %v of %d, want [100 30] once", c.clientID, got, n)
		}
	}

	// On the subscriber, the update comes after the snapshot the column
	// change produced.
	tl := sub.Timeline()
	snapAt, updAt := -1, -1
	for i, e := range tl {
		switch v := e.(type) {
		case frameRec:
			if v.snapshot {
				snapAt = i
			}
		case *protocol.SessionUpdated:
			if v.Cols != nil {
				updAt = i
			}
		}
	}
	if snapAt < 0 || updAt < snapAt {
		t.Fatalf("size update at %d, last snapshot at %d: the update must follow the snapshot", updAt, snapAt)
	}

	// Same size: nothing.
	if err := s.Resize(100, 30); err != nil {
		t.Fatal(err)
	}
	if _, n := lastSize(t, other, s.SID()); n != 1 {
		t.Fatalf("a resize to the same size broadcast again (%d updates)", n)
	}

	// Rows only: still broadcast.
	if err := s.Resize(100, 20); err != nil {
		t.Fatal(err)
	}
	if got, _ := lastSize(t, other, s.SID()); got != [2]uint16{100, 20} {
		t.Fatalf("rows-only resize: last %v, want [100 20]", got)
	}

	// A subscribe that brings a new size, from a third connection: everyone,
	// the newcomer included, hears it.
	third := newConn(t, m, "third")
	s.Subscribe(third, 0, 90, 25)
	for _, c := range []*fakeConn{sub, other, third} {
		if got, _ := lastSize(t, c, s.SID()); got != [2]uint16{90, 25} {
			t.Fatalf("%s after subscribe with size: last %v, want [90 25]", c.clientID, got)
		}
	}

	// Concurrent resizes: the last update every connection receives is the
	// session's size, which is also what the PTY reports.
	var wg sync.WaitGroup
	for i := range 32 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = s.Resize(uint16(60+i%30), uint16(15+i%10))
		}()
	}
	wg.Wait()
	info := s.Info()
	want := [2]uint16{info.Cols, info.Rows}
	for _, c := range []*fakeConn{sub, other, third} {
		if got, _ := lastSize(t, c, s.SID()); got != want {
			t.Fatalf("%s: last size update %v, session is %v", c.clientID, got, want)
		}
	}
	if err := sub.Send(s, "printf 'SIZE=%s\\n' \"$(stty size)\"\r"); err != nil {
		t.Fatal(err)
	}
	stty := fmt.Sprintf("SIZE=%d %d", info.Rows, info.Cols)
	waitFor(t, stty, func() bool { return strings.Contains(sub.Screen(), stty) })
}

// An exited session still records and announces a new size: clients use it to
// decide whether to claim, and the emulator keeps it for snapshots.
func TestSizeBroadcastExitedSession(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	c := newConn(t, m, "tab")
	if err := s.Write("tab", 0, []byte("exit 0\r")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "exit", func() bool { return s.Status() == protocol.StatusExited })
	if err := s.Resize(70, 20); err != nil {
		t.Fatal(err)
	}
	if got, _ := lastSize(t, c, s.SID()); got != [2]uint16{70, 20} {
		t.Fatalf("exited session resize: last %v, want [70 20]", got)
	}
}
