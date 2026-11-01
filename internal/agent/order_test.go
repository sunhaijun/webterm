package agent_test

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/protocol"
)

// orders returns the session.order messages this connection received, in
// arrival order.
func (c *wsClient) orders() []*protocol.SessionOrder {
	var out []*protocol.SessionOrder
	for _, m := range c.messages() {
		if o, ok := m.(*protocol.SessionOrder); ok {
			out = append(out, o)
		}
	}
	return out
}

// waitOrder waits for the nth session.order (1-based) and checks its req_id
// and sids.
func (c *wsClient) waitOrder(n int, reqID string, want []uint16) {
	c.t.Helper()
	waitFor(c.t, "session.order #"+itoa(n)+" received", func() bool { return len(c.orders()) >= n })
	got := c.orders()[n-1]
	if got.ReqID != reqID || !slices.Equal(got.SIDs, want) {
		c.t.Fatalf("%s session.order #%d = {req_id:%q sids:%v}, want {req_id:%q sids:%v}",
			c.clientID, n, got.ReqID, got.SIDs, reqID, want)
	}
}

func welcomeOrder(w *protocol.Welcome) []uint16 {
	out := make([]uint16, 0, len(w.Sessions))
	for _, s := range w.Sessions {
		out = append(out, s.SID)
	}
	return out
}

// IT-order-1 (connection layer, ADR-0040, AC-4.13): after session.move
// changes the order, the full order is broadcast to every connection as
// session.order, with req_id only on the originator's copy, even when nothing
// moved. An unknown sid gets unknown_session and no broadcast. Creating or
// closing a session sends no session.order. welcome.sessions[] is in display
// order. The session manager half lives in internal/session.
func TestITOrder1_MoveBroadcastsOrder(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	a := h.connect(ctx, c, "tab-a", nil, "")
	a.welcome()
	b := h.connect(ctx, h.reuse(c), "tab-b", nil, "")
	b.welcome()

	dir := t.TempDir()
	s1, s2, s3 := a.createSession(dir), a.createSession(dir), a.createSession(dir)

	// Move before another session.
	a.send(&protocol.SessionMove{ReqID: "mv-1", SID: s3, Before: &s1})
	a.waitOrder(1, "mv-1", []uint16{s3, s1, s2})
	b.waitOrder(1, "", []uint16{s3, s1, s2})

	// Unknown before: move to the end.
	gone := uint16(999)
	a.send(&protocol.SessionMove{ReqID: "mv-2", SID: s1, Before: &gone})
	a.waitOrder(2, "mv-2", []uint16{s3, s2, s1})
	b.waitOrder(2, "", []uint16{s3, s2, s1})

	// Null before: move to the end.
	a.send(&protocol.SessionMove{ReqID: "mv-3", SID: s3})
	a.waitOrder(3, "mv-3", []uint16{s2, s1, s3})
	b.waitOrder(3, "", []uint16{s2, s1, s3})

	// Broadcast even when nothing moved; the originator uses it as confirmation.
	a.send(&protocol.SessionMove{ReqID: "mv-4", SID: s1, Before: &s3})
	a.waitOrder(4, "mv-4", []uint16{s2, s1, s3})
	b.waitOrder(4, "", []uint16{s2, s1, s3})

	// Unknown sid: unknown_session to the originator only, no broadcast.
	a.send(&protocol.SessionMove{ReqID: "mv-5", SID: gone, Before: &s1})
	waitFor(t, "unknown_session", func() bool {
		for _, e := range a.errors() {
			if e.ReqID == "mv-5" {
				if e.Code != protocol.CodeUnknownSession || e.SID == nil || *e.SID != gone {
					t.Fatalf("error = %+v, want unknown_session sid %d", e, gone)
				}
				return true
			}
		}
		return false
	})
	if a.isClosed() {
		t.Fatal("move with an unknown sid closed the connection")
	}

	// From the other connection: req_id is only on its own copy. This is b's
	// 5th order because mv-5 was not broadcast (frames on one connection
	// arrive in enqueue order).
	b.send(&protocol.SessionMove{ReqID: "mv-6", SID: s3, Before: &s2})
	b.waitOrder(5, "mv-6", []uint16{s3, s2, s1})
	a.waitOrder(5, "", []uint16{s3, s2, s1})

	// welcome.sessions[] is in display order.
	d := h.connect(ctx, h.reuse(c), "tab-d", nil, "")
	if got, want := welcomeOrder(d.welcome()), []uint16{s3, s2, s1}; !slices.Equal(got, want) {
		t.Fatalf("welcome.sessions[] order = %v, want %v", got, want)
	}

	// Create appends and close removes; neither sends session.order (each
	// side can derive the result).
	s4 := d.createSession(dir)
	a.send(&protocol.SessionClose{ReqID: "cl-1", SID: s2})
	waitFor(t, "b receives session.closed", func() bool {
		for _, m := range b.messages() {
			if v, ok := m.(*protocol.SessionClosed); ok && v.SID == s2 {
				return true
			}
		}
		return false
	})
	if n := len(b.orders()); n != 5 {
		t.Fatalf("create / close sent session.order: b received %d, want 5", n)
	}
	if got, want := h.sessions.Order(), []uint16{s3, s1, s4}; !slices.Equal(got, want) {
		t.Fatalf("agent order = %v, want %v", got, want)
	}
	e := h.connect(ctx, h.reuse(c), "tab-e", nil, "")
	if got, want := welcomeOrder(e.welcome()), []uint16{s3, s1, s4}; !slices.Equal(got, want) {
		t.Fatalf("welcome.sessions[] after create / close = %v, want %v", got, want)
	}
}
