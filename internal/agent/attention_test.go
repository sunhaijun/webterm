package agent_test

import (
	"context"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/protocol"
)

// attentionOf returns the attention values this connection received in
// session.updated for sid, in order.
func (c *wsClient) attentionOf(sid uint16) []bool {
	var out []bool
	for _, m := range c.messages() {
		if u, ok := m.(*protocol.SessionUpdated); ok && u.SID == sid && u.Attention != nil {
			out = append(out, *u.Attention)
		}
	}
	return out
}

// IT-attention-5 (connection layer, ADR-0052): attention reaches every
// connection, subscribed or not; session.seen from one connection clears it
// for all; welcome carries the current value; an unknown sid gets
// unknown_session and the connection stays open.
func TestITAttention5_SeenOverWebSocket(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	a := h.connect(ctx, c, "tab-a", nil, "")
	a.welcome()
	b := h.connect(ctx, h.reuse(c), "tab-b", nil, "")
	b.welcome()
	sid := a.createSession(t.TempDir())
	a.input(sid, "printf 'READY-%s\\n' MARK\r")
	waitFor(t, "session ready", func() bool { return a.screenHas(sid, "READY-MARK") })

	a.input(sid, "printf '\\a'\r")
	for _, cl := range []*wsClient{a, b} {
		waitFor(t, cl.clientID+" gets attention:true", func() bool {
			u := cl.attentionOf(sid)
			return len(u) == 1 && u[0]
		})
	}

	// A page loaded now sees it in welcome.
	late := h.connect(ctx, h.reuse(c), "tab-late", nil, "")
	w := late.welcome()
	found := false
	for _, s := range w.Sessions {
		if s.SID == sid {
			found = true
			if !s.Attention {
				t.Fatal("welcome.sessions[].attention = false, want true")
			}
		}
	}
	if !found {
		t.Fatal("session missing from welcome")
	}

	b.send(&protocol.SessionSeen{SID: sid})
	for _, cl := range []*wsClient{a, b, late} {
		waitFor(t, cl.clientID+" gets attention:false", func() bool {
			u := cl.attentionOf(sid)
			return len(u) > 0 && !u[len(u)-1]
		})
	}

	gone := sid + 100
	a.send(&protocol.SessionSeen{SID: gone})
	waitFor(t, "unknown_session", func() bool {
		for _, e := range a.errors() {
			if e.SID != nil && *e.SID == gone {
				if e.Code != protocol.CodeUnknownSession {
					t.Fatalf("error = %+v, want unknown_session", e)
				}
				return true
			}
		}
		return false
	})
	if a.isClosed() {
		t.Fatal("session.seen with an unknown sid closed the connection")
	}
}
