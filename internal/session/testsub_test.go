package session_test

import (
	"bytes"
	"sync"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/session"
	"github.com/sunhaijun/webterm/internal/vterm"
)

// fakeConn is a test subscriber standing in for the connection layer and the
// client. It keeps seq accounting by the protocol rules and concatenates the
// frames it receives into "the bytes the client terminal consumed".
//
// It checks seq continuity strictly: any duplicate or gap fails immediately
// instead of surfacing only in E2E. On a snapshot it does what a real client
// does: clear (here, reset the bytes), write the snapshot, set out_seq = seq.
type fakeConn struct {
	t        *testing.T
	clientID string

	// inSeqNext is the client-side input accounting: the next in_seq to
	// assign. After reconnecting it must be trimmed to
	// welcome.resumed[].in_ack; see TrimTo.
	inSeqNext uint64

	mu        sync.Mutex
	screen    bytes.Buffer // bytes the client terminal consumed since the last snapshot
	expected  uint64       // seq the next frame should have
	haveSeq   bool
	events    []any
	frames    []frameRec // frames in arrival order
	timeline  []any      // frames (frameRec) and control messages interleaved in arrival order on this connection
	gaps      int
	dups      int
	snapshots int
	lastSnap  []byte
	detached  bool // connection dropped: late frames go nowhere
}

// frameRec records a frame (snapshot or output, seq, length) for ordering
// assertions (IT-resize-2).
type frameRec struct {
	snapshot bool
	seq      uint64
	n        int
}

// Detach simulates a dropped connection. Frames arriving afterward are
// discarded, since a real connection's socket is already closed by then. The
// test has to model this faithfully or races blur where the cut happened.
func (c *fakeConn) Detach() {
	c.mu.Lock()
	c.detached = true
	c.mu.Unlock()
}

// Attach simulates a completed reconnect; frames are received again.
func (c *fakeConn) Attach() {
	c.mu.Lock()
	c.detached = false
	c.mu.Unlock()
}

// newConn creates a test connection and registers it as a manager observer.
//
// Subscribing and observing are separate: Subscribe controls OUTPUT / SNAPSHOT
// frames, while control messages go to observers. Unsubscribed connections
// still get session.updated, from which unread state is derived.
func newConn(t *testing.T, m *session.Manager, clientID string) *fakeConn {
	c := &fakeConn{t: t, clientID: clientID}
	m.AddObserver(c)
	t.Cleanup(func() { m.RemoveObserver(c) })
	return c
}

func (c *fakeConn) ClientID() string { return c.clientID }

// Send simulates client input: assign in_seq and advance the local counter.
func (c *fakeConn) Send(s *session.Session, data string) error {
	err := s.Write(c.clientID, c.inSeqNext, []byte(data))
	if err == nil {
		c.inSeqNext += uint64(len(data))
	}
	return err
}

// Resend simulates a resend from the given seq without advancing the local
// counter (the agent drops the already-processed prefix).
func (c *fakeConn) Resend(s *session.Session, from uint64, data string) error {
	return s.Write(c.clientID, from, []byte(data))
}

// TrimTo trims the resend queue to welcome.resumed[].in_ack.
func (c *fakeConn) TrimTo(inAck uint64) { c.inSeqNext = inAck }

func (c *fakeConn) Push(sid uint16, seq uint64, data []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.detached {
		return
	}
	if c.haveSeq {
		switch {
		case seq > c.expected:
			c.gaps++
			c.t.Errorf("seq gap: got %d, want %d (%d bytes missing)", seq, c.expected, seq-c.expected)
			return
		case seq < c.expected:
			c.dups++
			c.t.Errorf("seq went backward: got %d, want %d", seq, c.expected)
			return
		}
	}
	c.frames = append(c.frames, frameRec{seq: seq, n: len(data)})
	c.timeline = append(c.timeline, frameRec{seq: seq, n: len(data)})
	c.screen.Write(data)
	c.expected = seq + uint64(len(data))
	c.haveSeq = true
}

// SubscribeAt simulates a client subscribing with the out_seq it holds. As with
// a real client, its out_seq starts from the reported value: on the
// incremental path with nothing to catch up, the next frame continues there.
func (c *fakeConn) SubscribeAt(s *session.Session, outSeq uint64) (string, uint64) {
	c.mu.Lock()
	c.expected, c.haveSeq = outSeq, true
	c.mu.Unlock()
	return s.Subscribe(c, outSeq, 0, 0)
}

func (c *fakeConn) Snapshot(sid uint16, seq uint64, data []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.detached {
		return
	}
	if len(data) == 0 {
		c.t.Errorf("empty snapshot (zero-length payloads are invalid)")
	}
	// Client: terminal.reset(), write the snapshot, out_seq = seq. Snapshot
	// bytes do not count toward seq.
	c.snapshots++
	c.lastSnap = append([]byte(nil), data...)
	c.frames = append(c.frames, frameRec{snapshot: true, seq: seq, n: len(data)})
	c.timeline = append(c.timeline, frameRec{snapshot: true, seq: seq, n: len(data)})
	c.screen.Reset()
	c.screen.Write(data)
	c.expected = seq
	c.haveSeq = true
}

func (c *fakeConn) Event(msg any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events = append(c.events, msg)
	c.timeline = append(c.timeline, msg)
}

// Timeline returns frames and control messages interleaved in arrival order.
func (c *fakeConn) Timeline() []any {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]any(nil), c.timeline...)
}

func (c *fakeConn) Screen() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.screen.String()
}

func (c *fakeConn) OutSeq() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.expected
}

// Snapshots returns how many snapshots were received.
func (c *fakeConn) Snapshots() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.snapshots
}

// LastSnapshot returns the bytes of the latest snapshot.
func (c *fakeConn) LastSnapshot() []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lastSnap
}

// Frames returns the frames in arrival order.
func (c *fakeConn) Frames() []frameRec {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]frameRec(nil), c.frames...)
}

// Events returns the control messages received.
func (c *fakeConn) Events() []any {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]any(nil), c.events...)
}

// waitFor polls until cond holds or fails on timeout. PTYs are asynchronous, so
// tests have to wait.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for: %s", what)
}

// waitQuiet waits until the session's output stops advancing.
//
// Byte-level comparisons can't stop as soon as a marker appears: more output
// follows (the next prompt, say), and where each run stops would be random,
// so differences would reflect sampling rather than resume bugs. Waiting for
// quiet gives both runs a deterministic cutoff.
func waitQuiet(t *testing.T, s *session.Session, quiet time.Duration) {
	t.Helper()
	last := s.HeadSeq()
	stableSince := time.Now()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
		if h := s.HeadSeq(); h != last {
			last, stableSince = h, time.Now()
			continue
		}
		if time.Since(stableSince) >= quiet {
			return
		}
	}
	t.Fatal("timed out waiting for output to go quiet")
}

// waitScreen waits until the screen contains sub.
func waitScreen(t *testing.T, c *fakeConn, sub string) {
	t.Helper()
	waitFor(t, "screen to show "+sub, func() bool { return bytes.Contains([]byte(c.Screen()), []byte(sub)) })
}

func newManager(t *testing.T, cfg session.Config) *session.Manager {
	t.Helper()
	m := session.NewManager(cfg)
	t.Cleanup(m.Shutdown)
	return m
}

// render feeds the bytes the client consumed to an emulator and returns its
// screen text. Use it to assert what is on screen rather than searching
// snapshot bytes, which are render instructions that may interleave style
// sequences with the text.
func render(c *fakeConn, cols, rows int) string {
	t := vterm.New(cols, rows)
	t.Write([]byte(c.Screen()))
	return t.String()
}
