package agent_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/sunhaijun/webterm/internal/agent"
	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/session"
	"github.com/sunhaijun/webterm/internal/store"
)

// harness runs a complete in-process agent: real store, real PTYs, real HTTP,
// real WebSocket.
type harness struct {
	t        *testing.T
	srv      *httptest.Server
	agent    *agent.Agent
	store    *store.Store
	sessions *session.Manager
	dataDir  string
	logs     *lockedBuffer
}

// harnessOpts tunes the harness.
type harnessOpts struct {
	ringBytes int
	tune      func(*agent.Config)
}

type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func newHarness(t *testing.T, tune ...func(*agent.Config)) *harness {
	return newHarnessWith(t, harnessOpts{tune: chain(tune)})
}

func chain(fns []func(*agent.Config)) func(*agent.Config) {
	return func(c *agent.Config) {
		for _, f := range fns {
			f(c)
		}
	}
}

func newHarnessWith(t *testing.T, o harnessOpts) *harness {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })

	ring := o.ringBytes
	if ring == 0 {
		ring = 1 << 20
	}
	// bash without dotfiles, so assertions are deterministic.
	sessions := session.NewManager(session.Config{
		MaxSessions: 5, RingBytes: ring, Shell: "bash",
		ShellArgs: []string{"--norc", "--noprofile", "-i"},
	})
	t.Cleanup(sessions.Shutdown)

	logs := &lockedBuffer{}
	cfg := agent.Config{
		Dev:     true, // allow localhost Origin; cookies without Secure
		Version: "test",
		Logger:  slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
	}
	if o.tune != nil {
		o.tune(&cfg)
	}
	a := agent.New(cfg, st, sessions)
	srv := httptest.NewServer(a.Handler())
	t.Cleanup(srv.Close)

	return &harness{
		t: t, srv: srv, agent: a, store: st, sessions: sessions,
		dataDir: dir, logs: logs,
	}
}

// client returns an HTTP client with a cookie jar, standing in for a browser.
func (h *harness) client() *http.Client {
	jar, _ := cookiejar.New(nil)
	return &http.Client{Jar: jar, Timeout: 10 * time.Second}
}

// pair runs the full pairing flow; afterwards c carries the session cookie.
func (h *harness) pair(c *http.Client) *http.Response {
	h.t.Helper()
	code, err := h.agent.Auth().NewPairingCode(time.Now())
	if err != nil {
		h.t.Fatal(err)
	}
	return h.postJSON(c, "/auth/pair", map[string]string{"code": code})
}

func (h *harness) postJSON(c *http.Client, path string, body any) *http.Response {
	h.t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest(http.MethodPost, h.srv.URL+path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Mozilla/5.0 (iPhone) Safari/605")
	resp, err := c.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	return resp
}

func (h *harness) do(c *http.Client, method, path string, body any) *http.Response {
	h.t.Helper()
	var r *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	} else {
		r = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, h.srv.URL+path, r)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	return resp
}

// reuse returns a new client sharing c's cookie jar, like another tab on the
// same device.
func (h *harness) reuse(c *http.Client) *http.Client {
	return &http.Client{Jar: c.Jar, Timeout: 10 * time.Second}
}

// wsURL returns the WebSocket URL.
func (h *harness) wsURL() string { return "ws" + strings.TrimPrefix(h.srv.URL, "http") + "/ws" }

// dial opens a WebSocket with the given client's cookies.
func (h *harness) dial(ctx context.Context, c *http.Client, origin string) (*websocket.Conn, *http.Response, error) {
	hdr := http.Header{}
	if origin != "" {
		hdr.Set("Origin", origin)
	}
	return websocket.Dial(ctx, h.wsURL(), &websocket.DialOptions{
		HTTPClient: c,
		HTTPHeader: hdr,
	})
}

// wsClient is a minimal protocol client, just enough for integration tests.
//
// It handles both frame types like a real client: OUTPUT is appended to the
// screen and advances out_seq; once a SNAPSHOT is complete (the frame with
// MORE cleared) it clears the screen, writes the snapshot and sets
// out_seq = seq.
type wsClient struct {
	t        *testing.T
	ws       *websocket.Conn
	clientID string

	mu        sync.Mutex
	msgs      []any
	screen    map[uint16]*bytes.Buffer
	outSeq    map[uint16]uint64
	inSeq     map[uint16]uint64
	errs      []*protocol.Error
	closed    bool
	stopRead  bool
	reqSeq    int
	partial   map[uint16][]byte // snapshots not yet complete
	snapshots map[uint16]int    // completed snapshots
	frames    []protocol.Frame  // binary frames received (payload dropped), in arrival order
	order     []string          // "welcome" / "binary" / other control message t, in arrival order
	seqErrs   []string          // OUTPUT seq discontinuities
}

// snapshotCount returns how many complete snapshots sid received.
func (c *wsClient) snapshotCount(sid uint16) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.snapshots[sid]
}

// binaryFrames returns the binary frame headers received, in arrival order.
func (c *wsClient) binaryFrames() []protocol.Frame {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]protocol.Frame(nil), c.frames...)
}

// arrival returns the order frames arrived in ("binary" for a binary frame,
// otherwise the control message's t).
func (c *wsClient) arrival() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.order...)
}

func (c *wsClient) seqErrors() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.seqErrs...)
}

// headSeqOf returns the latest head_seq reported by session.updated. While
// unsubscribed no bytes cross the wire, so this is the only way for a test to
// see how far the backlog has grown.
func (c *wsClient) headSeqOf(sid uint16) uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	var v uint64
	for _, m := range c.msgs {
		if u, ok := m.(*protocol.SessionUpdated); ok && u.SID == sid && u.HeadSeq != nil {
			v = *u.HeadSeq
		}
	}
	return v
}

// stopReading stops reading from the socket, to overflow the server's write
// queue.
func (c *wsClient) stopReading() {
	c.mu.Lock()
	c.stopRead = true
	c.mu.Unlock()
}

// connectRaw connects without sending hello, so the test chooses the first
// message.
func (h *harness) connectRaw(ctx context.Context, c *http.Client, clientID string) *wsClient {
	h.t.Helper()
	ws, _, err := h.dial(ctx, c, h.srv.URL)
	if err != nil {
		h.t.Fatalf("WebSocket dial failed: %v", err)
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
	return cl
}

func (h *harness) connect(ctx context.Context, c *http.Client, clientID string, resume []protocol.ResumeReq, instanceID string) *wsClient {
	h.t.Helper()
	cl := h.connectRaw(ctx, c, clientID)
	cl.send(&protocol.Hello{
		Protocol: protocol.Version, ClientID: clientID,
		InstanceID: instanceID, Resume: resume,
	})
	return cl
}

func (c *wsClient) send(msg any) {
	b, err := protocol.Encode(msg)
	if err != nil {
		c.t.Fatal(err)
	}
	if err := c.ws.Write(context.Background(), websocket.MessageText, b); err != nil {
		c.t.Logf("send failed: %v", err)
	}
}

// input sends input, tracking in_seq itself.
func (c *wsClient) input(sid uint16, data string) {
	c.mu.Lock()
	seq := c.inSeq[sid]
	c.inSeq[sid] = seq + uint64(len(data))
	c.mu.Unlock()
	f := protocol.Frame{Type: protocol.TypeInput, SID: sid, Seq: seq, Payload: []byte(data)}
	if err := c.ws.Write(context.Background(), websocket.MessageBinary, protocol.EncodeFrame(f)); err != nil {
		c.t.Logf("send input failed: %v", err)
	}
}

func (c *wsClient) readLoop(ctx context.Context) {
	for {
		c.mu.Lock()
		stopped := c.stopRead
		c.mu.Unlock()
		if stopped {
			// Stop reading but keep the socket open, so the server's write
			// queue grows to its limit.
			select {
			case <-ctx.Done():
				return
			case <-time.After(50 * time.Millisecond):
			}
			continue
		}
		typ, data, err := c.ws.Read(ctx)
		if err != nil {
			c.mu.Lock()
			c.closed = true
			c.mu.Unlock()
			return
		}
		switch typ {
		case websocket.MessageBinary:
			f, err := protocol.DecodeFrame(data)
			if err != nil {
				continue
			}
			c.mu.Lock()
			c.order = append(c.order, "binary")
			c.frames = append(c.frames, protocol.Frame{Type: f.Type, Flags: f.Flags, SID: f.SID, Seq: f.Seq,
				Payload: make([]byte, len(f.Payload))})
			buf := c.screen[f.SID]
			if buf == nil {
				buf = &bytes.Buffer{}
				c.screen[f.SID] = buf
			}
			switch f.Type {
			case protocol.TypeSnapshot:
				c.partial[f.SID] = append(c.partial[f.SID], f.Payload...)
				if !f.More() {
					// Complete: clear, write the snapshot, out_seq = seq
					// (snapshot bytes don't count toward seq).
					buf.Reset()
					buf.Write(c.partial[f.SID])
					delete(c.partial, f.SID)
					c.outSeq[f.SID] = f.Seq
					c.snapshots[f.SID]++
				}
			case protocol.TypeOutput:
				if _, mid := c.partial[f.SID]; mid {
					c.seqErrs = append(c.seqErrs, "OUTPUT between frames of one snapshot")
				}
				if want, ok := c.outSeq[f.SID]; ok && f.Seq != want {
					c.seqErrs = append(c.seqErrs, fmt.Sprintf("sid %d: OUTPUT seq %d, want %d", f.SID, f.Seq, want))
				}
				buf.Write(f.Payload)
				c.outSeq[f.SID] = f.Seq + uint64(f.DataLen())
			}
			c.mu.Unlock()
		case websocket.MessageText:
			msg, err := protocol.Decode(data)
			if err != nil {
				continue
			}
			c.mu.Lock()
			c.msgs = append(c.msgs, msg)
			var probe struct {
				T string `json:"t"`
			}
			_ = json.Unmarshal(data, &probe)
			c.order = append(c.order, probe.T)
			if e, ok := msg.(*protocol.Error); ok {
				c.errs = append(c.errs, e)
			}
			c.mu.Unlock()
		}
	}
}

func (c *wsClient) screenOf(sid uint16) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if b := c.screen[sid]; b != nil {
		return b.String()
	}
	return ""
}

// screenHas doesn't copy the buffer: large-output tests poll every 10ms, and
// copying MiBs each time would slow the read loop.
func (c *wsClient) screenHas(sid uint16, sub string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	b := c.screen[sid]
	return b != nil && bytes.Contains(b.Bytes(), []byte(sub))
}

func (c *wsClient) messages() []any {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]any(nil), c.msgs...)
}

func (c *wsClient) errors() []*protocol.Error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]*protocol.Error(nil), c.errs...)
}

func (c *wsClient) isClosed() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.closed
}

// welcome waits for the welcome message.
func (c *wsClient) welcome() *protocol.Welcome {
	c.t.Helper()
	var w *protocol.Welcome
	waitFor(c.t, "welcome received", func() bool {
		for _, m := range c.messages() {
			if v, ok := m.(*protocol.Welcome); ok {
				w = v
				return true
			}
		}
		return false
	})
	return w
}

// createSession creates a session, waits for its session.created and
// subscribes to it.
//
// It must match on req_id: a connection may create several sessions, and
// taking the first session.created would hand the second call the first
// session's sid, throwing off every later assertion.
func (c *wsClient) createSession(cwd string) uint16 {
	c.t.Helper()
	c.mu.Lock()
	c.reqSeq++
	reqID := "req-" + itoa(c.reqSeq)
	c.mu.Unlock()

	cwdp := cwd
	c.send(&protocol.SessionCreate{ReqID: reqID, CWD: &cwdp, Cols: 80, Rows: 24})
	var sid uint16
	waitFor(c.t, "session.created("+reqID+") received", func() bool {
		for _, m := range c.messages() {
			if v, ok := m.(*protocol.SessionCreated); ok && v.ReqID == reqID {
				sid = v.Session.SID
				return true
			}
		}
		return false
	})
	// Creating doesn't subscribe (protocol §4.1): subscribe like a real client;
	// out_seq 0 means snapshot.
	c.send(&protocol.Subscribe{SID: sid, OutSeq: 0})
	waitFor(c.t, "first snapshot of the new session", func() bool { return c.snapshotCount(sid) >= 1 })
	return sid
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for: %s", what)
}
