package agent_test

import (
	"bytes"
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/sunhaijun/webterm/internal/agent"
	"github.com/sunhaijun/webterm/internal/protocol"
)

// unixHTTP is an HTTP client that dials the Unix socket at path.
func unixHTTP(path string) *http.Client {
	return &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", path)
		},
	}}
}

// connectAttach opens a protocol connection over the attach socket, the way
// webterm attach does (ADR-0050 §2), and sends hello.
func (h *harness) connectAttach(ctx context.Context, path, clientID string) *wsClient {
	h.t.Helper()
	ws, _, err := websocket.Dial(ctx, "ws://webterm/ws", &websocket.DialOptions{HTTPClient: unixHTTP(path)})
	if err != nil {
		h.t.Fatalf("attach socket dial failed: %v", err)
	}
	ws.SetReadLimit(4 << 20)
	cl := &wsClient{
		t: h.t, ws: ws, clientID: clientID,
		screen:    map[uint16]*bytes.Buffer{},
		outSeq:    map[uint16]uint64{},
		inSeq:     map[uint16]uint64{},
		partial:   map[uint16][]byte{},
		snapshots: map[uint16]int{},
	}
	go cl.readLoop(ctx)
	cl.send(&protocol.Hello{Protocol: protocol.Version, ClientID: clientID, Resume: []protocol.ResumeReq{}})
	return cl
}

// IT-attach-1: the attach socket (AC-1.23, ADR-0050 §2).
func TestITAttach1_Socket(t *testing.T) {
	h := newHarness(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	path := filepath.Join(t.TempDir(), "attach.sock")

	as, err := h.agent.ServeAttach(path)
	if err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode()&os.ModeSocket == 0 || fi.Mode().Perm() != 0o600 {
		t.Fatalf("attach socket mode = %v, want a 0600 socket", fi.Mode())
	}

	// A second server on a live socket fails and leaves the first serving.
	if _, err := h.agent.ServeAttach(path); !errors.Is(err, agent.ErrAgentRunning) {
		t.Fatalf("second ServeAttach: err = %v, want ErrAgentRunning", err)
	}

	// Same protocol as /ws: hello → welcome, and a session created through
	// the socket is visible to a browser connection.
	cl := h.connectAttach(ctx, path, "attach-1")
	w := cl.welcome()
	if w.Protocol != protocol.Version || w.InstanceID != h.sessions.InstanceID() {
		t.Fatalf("welcome = %+v", w)
	}
	bc := h.client()
	if resp := h.pair(bc); resp.StatusCode != http.StatusOK {
		t.Fatalf("pairing returned %d", resp.StatusCode)
	} else {
		resp.Body.Close()
	}
	browser := h.connect(ctx, bc, "tab", nil, "")
	browser.welcome()
	sid := cl.createSession(t.TempDir())
	waitFor(t, "browser sees the session created over the socket", func() bool {
		for _, m := range browser.messages() {
			if v, ok := m.(*protocol.SessionCreated); ok && v.Session.SID == sid {
				return true
			}
		}
		return false
	})
	cl.input(sid, "echo attach-$((40+2))\r")
	waitFor(t, "output over the socket", func() bool { return cl.screenHas(sid, "attach-42") })

	// The socket goes away on Close.
	if err := as.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("socket still there after Close: %v", err)
	}

	// A peer with another uid is refused before the upgrade.
	other := filepath.Join(t.TempDir(), "attach.sock")
	as2, err := h.agent.ServeAttachAs(other, uint32(os.Getuid())+1)
	if err != nil {
		t.Fatal(err)
	}
	defer as2.Close()
	_, resp, err := websocket.Dial(ctx, "ws://webterm/ws", &websocket.DialOptions{HTTPClient: unixHTTP(other)})
	if err == nil {
		t.Fatal("a peer with another uid was accepted")
	}
	if resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("other uid: resp = %v, want 403", resp)
	}
}
