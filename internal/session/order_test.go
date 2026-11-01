package session_test

import (
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/handoff"
	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/session"
)

// IT-order-1: session display order is agent state (ADR-0040, AC-4.13).
// These tests cover the session manager half. The connection half
// (session.move broadcasts session.order, req_id only for the requester,
// welcome.sessions[] in order) is TestITOrder1_MoveBroadcastsOrder in
// internal/agent.

func sidPtr(v uint16) *uint16 { return &v }

// wantOrder checks that Order, List, and Infos all report the same order.
func wantOrder(t *testing.T, m *session.Manager, want ...uint16) {
	t.Helper()
	if got := m.Order(); !slices.Equal(got, want) {
		t.Fatalf("Order() = %v, want %v", got, want)
	}
	var list, infos []uint16
	for _, s := range m.List() {
		list = append(list, s.SID())
	}
	for _, in := range m.Infos() {
		infos = append(infos, in.SID)
	}
	if !slices.Equal(list, want) || !slices.Equal(infos, want) {
		t.Fatalf("List() = %v, Infos() = %v, want %v", list, infos, want)
	}
}

// New sessions go last and closed ones drop out. "Last" means the end of the
// current order, not re-sorted by sid.
func TestITOrder1_CreateAppendsCloseRemoves(t *testing.T) {
	m := newManager(t, cfg())
	a, b, c := create(t, m).SID(), create(t, m).SID(), create(t, m).SID()
	wantOrder(t, m, a, b, c)

	if err := m.Move(c, sidPtr(a), nil); err != nil {
		t.Fatal(err)
	}
	wantOrder(t, m, c, a, b)

	if _, err := m.Close(a); err != nil {
		t.Fatal(err)
	}
	wantOrder(t, m, c, b)

	d := create(t, m).SID()
	wantOrder(t, m, c, b, d)
}

// session.move with various befores. Success calls publish with the full order,
// even when nothing moved.
func TestITOrder1_Move(t *testing.T) {
	m := newManager(t, cfg())
	a, b, c := create(t, m).SID(), create(t, m).SID(), create(t, m).SID()

	var published [][]uint16
	pub := func(o []uint16) { published = append(published, o) }

	steps := []struct {
		name   string
		sid    uint16
		before *uint16
		want   []uint16
	}{
		{"move in front of a session", c, sidPtr(a), []uint16{c, a, b}},
		{"null before moves to the end", c, nil, []uint16{a, b, c}},
		{"move in front of the first", c, sidPtr(a), []uint16{c, a, b}},
		{"move in front of the next one is a no-op", a, sidPtr(b), []uint16{c, a, b}},
		{"before equal to sid is a no-op", a, sidPtr(a), []uint16{c, a, b}},
		{"moving the last to the end is a no-op", b, nil, []uint16{c, a, b}},
		{"unknown before moves to the end", c, sidPtr(999), []uint16{a, b, c}},
	}
	for _, st := range steps {
		n := len(published)
		if err := m.Move(st.sid, st.before, pub); err != nil {
			t.Fatalf("%s: %v", st.name, err)
		}
		wantOrder(t, m, st.want...)
		if len(published) != n+1 || !slices.Equal(published[n], st.want) {
			t.Fatalf("%s: published %v, want exactly one %v", st.name, published[n:], st.want)
		}
	}

	// Unknown sid: ErrUnknownSession, no broadcast, order unchanged.
	n := len(published)
	if err := m.Move(999, nil, pub); err != session.ErrUnknownSession {
		t.Fatalf("unknown sid: err = %v, want ErrUnknownSession", err)
	}
	// A just-closed session is unknown too; as before it means the end.
	if _, err := m.Close(b); err != nil {
		t.Fatal(err)
	}
	if err := m.Move(b, sidPtr(a), pub); err != session.ErrUnknownSession {
		t.Fatalf("closed sid: err = %v, want ErrUnknownSession", err)
	}
	if len(published) != n {
		t.Fatalf("failed move was published: %v", published[n:])
	}
	wantOrder(t, m, a, c)
	if err := m.Move(a, sidPtr(b), pub); err != nil {
		t.Fatal(err)
	}
	wantOrder(t, m, c, a)
}

// Concurrent moves: the change and its broadcast share a lock, so the last
// published order is the agent's order. Two devices dragging at once converge
// (ADR-0040 §2).
func TestITOrder1_ConcurrentMovesLastPublishWins(t *testing.T) {
	m := newManager(t, cfg())
	all := []uint16{create(t, m).SID(), create(t, m).SID(), create(t, m).SID()}

	var mu sync.Mutex
	var last []uint16
	var bad []string
	pub := func(o []uint16) {
		mu.Lock()
		defer mu.Unlock()
		last = o
		if got := slices.Sorted(slices.Values(o)); !slices.Equal(got, slices.Sorted(slices.Values(all))) {
			bad = append(bad, "published order is not a permutation of all sessions")
		}
	}

	var wg sync.WaitGroup
	for g := range 4 {
		wg.Go(func() {
			for i := range 200 {
				sid := all[(g+i)%len(all)]
				var before *uint16
				if i%3 != 0 {
					before = sidPtr(all[(g+2*i)%len(all)])
				}
				if err := m.Move(sid, before, pub); err != nil {
					t.Error(err)
					return
				}
				_ = m.List()
			}
		})
	}
	wg.Wait()

	if len(bad) > 0 {
		t.Fatal(bad[0])
	}
	if got := m.Order(); !slices.Equal(got, last) {
		t.Fatalf("agent order %v != last published %v", got, last)
	}
}

// Order survives a hot upgrade: the snapshot's sessions[] is in display order
// and the new process restores it. next_sid carries over and new sessions
// still go last.
//
// The old Manager must not be shut down; that would kill the shells. After the
// handoff it is an empty shell.
func TestITOrder1_HandoffKeepsOrder(t *testing.T) {
	m := session.NewManager(cfg())
	a, b, c := create(t, m).SID(), create(t, m).SID(), create(t, m).SID()
	if err := m.Move(c, sidPtr(a), nil); err != nil {
		t.Fatal(err)
	}
	wantOrder(t, m, c, a, b)

	if err := m.Freeze(2 * time.Second); err != nil {
		t.Fatal(err)
	}
	snap, err := m.Export("test")
	if err != nil {
		t.Fatal(err)
	}
	if snap.Schema != 2 {
		t.Fatalf("schema = %d: ordering should not bump the snapshot format", snap.Schema)
	}
	var inSnap []uint16
	for _, hs := range snap.Sessions {
		inSnap = append(inSnap, hs.SID)
	}
	if want := []uint16{c, a, b}; !slices.Equal(inSnap, want) {
		t.Fatalf("snapshot sessions[] order = %v, want %v", inSnap, want)
	}

	m2 := session.NewManager(cfg())
	t.Cleanup(m2.Shutdown)
	if err := m2.Restore(snap); err != nil {
		t.Fatal(err)
	}
	wantOrder(t, m2, c, a, b)

	// next_sid is unchanged: the new process continues allocating where the
	// old one stopped, and new sessions go last.
	d := create(t, m2).SID()
	if d != snap.NextSID {
		t.Fatalf("sid created after handoff = %d, want next_sid %d", d, snap.NextSID)
	}
	wantOrder(t, m2, c, a, b, d)
}

// Display order is the snapshot's sessions[] order. Older snapshots are in sid
// order and restore that way. The snapshot uses exited sessions, which need no
// fd or process.
func TestITOrder1_RestoreFollowsSnapshotSliceOrder(t *testing.T) {
	exited := func(sid uint16) handoff.Session {
		return handoff.Session{
			SID: sid, PtmxFD: -1, CreatedAt: time.Now(),
			CWD: "/", Status: protocol.StatusExited, Cols: 80, Rows: 24,
		}
	}
	for _, tc := range []struct {
		name string
		sids []uint16
	}{
		{"new snapshot in display order", []uint16{5, 2, 7}},
		{"old snapshot in sid order", []uint16{2, 5, 7}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			snap := &handoff.Snapshot{Schema: handoff.Schema, InstanceID: "x", NextSID: 8}
			for _, sid := range tc.sids {
				snap.Sessions = append(snap.Sessions, exited(sid))
			}
			m := newManager(t, cfg())
			if err := m.Restore(snap); err != nil {
				t.Fatal(err)
			}
			wantOrder(t, m, tc.sids...)
		})
	}
}
