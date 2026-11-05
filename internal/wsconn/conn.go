// Package wsconn is the WebSocket connection layer. It puts session output
// and events on the wire and turns incoming frames into session calls.
//
// The contract is docs/30-protocol/websocket-protocol.md. Conn implements
// session.Subscriber; package session knows nothing about WebSockets.
package wsconn

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/session"
)

const (
	// writeQueueBytes caps each connection's write queue (protocol §5.6).
	// When it fills up the connection is closed: blocking would push back
	// into PTY.Read(), and one slow client must not slow down the real work
	// running on the server.
	writeQueueBytes = 4 << 20
	// idleTimeout closes a connection that sends no frame for 60 seconds
	// (AC-2.8).
	idleTimeout = 60 * time.Second
	// ackThrottle: at most one ack per session per 50ms. Acks are cumulative,
	// so dropping intermediate values is harmless.
	ackThrottle = 50 * time.Millisecond
	// headSeqThrottle: at most one head_seq notification per second for an
	// unsubscribed session.
	headSeqThrottle = time.Second
	// writeTimeout bounds a single write so a stuck socket can't hold the
	// write goroutine.
	writeTimeout = 30 * time.Second
)

// Deps are the external dependencies of the connection layer.
type Deps struct {
	Sessions      *session.Manager
	Hub           *Hub
	ServerVersion string
	Logger        *slog.Logger
	// Revoked reports whether this connection's device has been revoked. It
	// is polled every 2 seconds (AC-1.11).
	Revoked func() bool
	// IdleTimeout overrides the default 60-second idle timeout; 0 means the
	// default. It exists so IT-hb-1 doesn't have to wait 60 seconds.
	IdleTimeout time.Duration
	// WriteQueueBytes overrides the default 4 MiB write queue limit; 0 means
	// the default.
	WriteQueueBytes int
}

func (d Deps) idleTimeout() time.Duration {
	if d.IdleTimeout > 0 {
		return d.IdleTimeout
	}
	return idleTimeout
}

func (d Deps) writeQueueBytes() int {
	if d.WriteQueueBytes > 0 {
		return d.WriteQueueBytes
	}
	return writeQueueBytes
}

type outFrame struct {
	binary bool
	data   []byte
	// resume marks frames produced before welcome (the hello catch-up); they
	// don't count against the write queue limit, see enqueue.
	resume bool
}

// Conn is one WebSocket connection.
type Conn struct {
	ws   *websocket.Conn
	deps Deps
	log  *slog.Logger

	// clientID is set once by hello on the read goroutine and read from
	// others (session fan-out, the hub), hence atomic.
	clientID atomic.Pointer[string]

	mu       sync.Mutex
	subs     map[uint16]bool      // subscribed sessions
	lastAck  map[uint16]time.Time // ack throttling
	pendAck  map[uint16]uint64
	lastHead map[uint16]time.Time // head_seq throttling
	pendHead map[uint16]uint64

	// The write queue is a slice plus a wake signal rather than a channel: a
	// batch of frames (all frames of one snapshot) must be enqueued
	// atomically, and welcome must be able to jump ahead of frames enqueued
	// while hello was being handled.
	q      []outFrame
	queued int // bytes in the write queue, including held
	// resumeBytes is the part of queued that came from before welcome.
	resumeBytes int
	// holding: everything enqueued before welcome is parked in held.
	//
	// Deciding hello.resume and enqueueing the catch-up frames must be one
	// step (protocol §5.1, under the session lock), and welcome.resumed[]
	// reports that decision, so those frames are produced before welcome.
	// The queue is held, and once welcome exists it goes first and everything
	// is released together, so the client sees welcome first. Holding starts
	// as soon as the connection exists: the observer registers before hello,
	// and broadcasts in that window must not overtake welcome either.
	holding   bool
	held      []outFrame
	wake      chan struct{} // cap 1
	closed    bool
	closeCode websocket.StatusCode
	closeMsg  string

	done chan struct{} // closed by the closeWith call that sets closed
	// flushed is closed when writeLoop exits (queue drained or write failed).
	flushed chan struct{}
	// cancel cancels Serve's context to wake a readLoop blocked in ws.Read;
	// otherwise the connection would only drop at the 60-second idle timeout
	// and AC-1.11 would fail.
	//
	// It must only be called after the write queue is flushed: coder/websocket
	// tears down the underlying connection when the read context is canceled,
	// so calling it early throws away the error that explains the disconnect,
	// leaving the user with an unexplained reconnect failure.
	cancel context.CancelFunc
}

// New wraps an upgraded WebSocket.
func New(ws *websocket.Conn, deps Deps) *Conn {
	log := deps.Logger
	if log == nil {
		log = slog.Default()
	}
	return &Conn{
		ws:       ws,
		deps:     deps,
		log:      log,
		subs:     make(map[uint16]bool),
		lastAck:  make(map[uint16]time.Time),
		pendAck:  make(map[uint16]uint64),
		lastHead: make(map[uint16]time.Time),
		pendHead: make(map[uint16]uint64),
		holding:  true,
		wake:     make(chan struct{}, 1),
		done:     make(chan struct{}),
		flushed:  make(chan struct{}),
	}
}

// ClientID implements session.Subscriber.
func (c *Conn) ClientID() string {
	if p := c.clientID.Load(); p != nil {
		return *p
	}
	return ""
}

// Push implements session.Subscriber: it encodes output as OUTPUT frames and
// enqueues them.
//
// It must not block. When the queue is full the connection is closed, and the
// client reconnects and resumes.
func (c *Conn) Push(sid uint16, seq uint64, data []byte) {
	frames := make([]outFrame, 0, 1)
	// Split large output into frames of at most MaxPayload.
	for off := 0; off < len(data); {
		end := min(off+protocol.MaxPayload, len(data))
		f := protocol.Frame{Type: protocol.TypeOutput, SID: sid, Seq: seq + uint64(off), Payload: data[off:end]}
		frames = append(frames, outFrame{binary: true, data: protocol.EncodeFrame(f)})
		off = end
	}
	c.enqueue(frames...)
}

// Snapshot implements session.Subscriber: it encodes a snapshot as SNAPSHOT
// frames and enqueues them.
//
// A snapshot larger than one frame is split: all parts share the seq, and all
// but the last carry MORE (protocol §3). The parts are enqueued atomically;
// the protocol guarantees no other frame for the same sid lands between them.
func (c *Conn) Snapshot(sid uint16, seq uint64, data []byte) {
	fs := protocol.SnapshotFrames(sid, seq, data)
	frames := make([]outFrame, 0, len(fs))
	for _, f := range fs {
		frames = append(frames, outFrame{binary: true, data: protocol.EncodeFrame(f)})
	}
	c.enqueue(frames...)
}

// Event implements session.Subscriber: it enqueues a control message.
func (c *Conn) Event(msg any) {
	// ack and head_seq are throttled; everything else goes out as is.
	switch m := msg.(type) {
	case *protocol.Ack:
		if !c.allowAck(m.SID, m.InAck) {
			return
		}
	case *protocol.SessionUpdated:
		if m.HeadSeq != nil && onlyHeadSeq(m) {
			// A head_seq-only update (for unread tracking). Subscribed sessions
			// don't need it: OUTPUT frames already carry progress, and they
			// are never unread. Unsubscribed sessions are throttled to 1/s.
			c.mu.Lock()
			subscribed := c.subs[m.SID]
			c.mu.Unlock()
			if subscribed || !c.allowHeadSeq(m.SID, *m.HeadSeq) {
				return
			}
		} else if m.HeadSeq != nil {
			// Carries other fields too (status + head_seq when a session
			// exits): send it unthrottled. Also drop any throttled pending
			// value, or the later flush would deliver a smaller head_seq after it.
			c.mu.Lock()
			c.lastHead[m.SID] = time.Now()
			delete(c.pendHead, m.SID)
			c.mu.Unlock()
		}
	}
	c.send(msg)
}

// send encodes and enqueues a control message, bypassing throttling.
func (c *Conn) send(msg any) {
	b, err := protocol.Encode(msg)
	if err != nil {
		c.log.Error("encode control message failed", "err", err)
		return
	}
	c.enqueue(outFrame{data: b})
}

func (c *Conn) allowAck(sid uint16, inAck uint64) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	if now.Sub(c.lastAck[sid]) < ackThrottle {
		c.pendAck[sid] = inAck // keep the latest; writeLoop's ticker sends it later
		return false
	}
	c.lastAck[sid] = now
	delete(c.pendAck, sid)
	return true
}

func (c *Conn) allowHeadSeq(sid uint16, head uint64) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	if now.Sub(c.lastHead[sid]) < headSeqThrottle {
		c.pendHead[sid] = head // keep the latest; writeLoop's ticker sends it later
		return false
	}
	c.lastHead[sid] = now
	delete(c.pendHead, sid)
	return true
}

// enqueue atomically appends a batch of frames to the write queue. If the
// queue is full it closes the connection; it never blocks.
//
// Frames enqueued before welcome are exempt from the limit. They are the
// catch-up the client asked for in hello (bounded by the sessions it resumes),
// and closing over them would repeat on every reconnect: the client would
// never get back in. The limit applies to everything after, on top of them.
func (c *Conn) enqueue(frames ...outFrame) {
	if len(frames) == 0 {
		return
	}
	n := 0
	for _, f := range frames {
		n += len(f.data)
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	holding := c.holding
	if !holding && c.queued-c.resumeBytes+n > c.deps.writeQueueBytes() {
		c.mu.Unlock()
		c.log.Warn("conn queue full, disconnecting slow client", "client_id", c.ClientID())
		c.closeWith(websocket.StatusTryAgainLater, "write queue full")
		return
	}
	c.queued += n
	if holding {
		for i := range frames {
			frames[i].resume = true
		}
		c.resumeBytes += n
		c.held = append(c.held, frames...)
	} else {
		c.q = append(c.q, frames...)
	}
	c.mu.Unlock()
	if !holding {
		c.signal()
	}
}

// releaseWith ends holding: first goes to the front, followed by everything
// enqueued while holding. When not holding it is a plain enqueue.
func (c *Conn) releaseWith(first []byte) {
	f := outFrame{data: first}
	c.mu.Lock()
	if !c.holding {
		c.mu.Unlock()
		c.enqueue(f)
		return
	}
	c.holding = false
	held := c.held
	c.held = nil
	if c.closed {
		c.queued, c.resumeBytes = 0, 0
		c.mu.Unlock()
		return
	}
	f.resume = true // welcome goes out whatever the budget
	c.queued += len(first)
	c.resumeBytes += len(first)
	c.q = append(c.q, f)
	c.q = append(c.q, held...)
	c.mu.Unlock()
	c.signal()
}

func (c *Conn) signal() {
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

// pop removes and returns the head of the write queue.
func (c *Conn) pop() (outFrame, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.q) == 0 {
		return outFrame{}, false
	}
	f := c.q[0]
	c.q[0] = outFrame{}
	c.q = c.q[1:]
	c.queued -= len(f.data)
	if f.resume {
		c.resumeBytes -= len(f.data)
	}
	return f, true
}

// closeWith requests that the connection close. It is idempotent; the first
// caller's reason wins.
func (c *Conn) closeWith(code websocket.StatusCode, msg string) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	c.closeCode, c.closeMsg = code, msg
	cancel := c.cancel
	c.mu.Unlock()
	close(c.done) // only the call that set closed gets here
	if cancel == nil {
		return
	}
	// Let writeLoop flush the queue first, then wake readLoop.
	go func() {
		select {
		case <-c.flushed:
		case <-time.After(3 * time.Second):
		}
		cancel()
	}()
}

// sendError sends an error control message and, if fatal, then closes the
// connection.
//
// A fatal error is enqueued before closing, and Serve waits for the write
// goroutine to flush the queue before closing the socket; otherwise the
// client would only see a bare close. Giving a readable error instead of a
// bare handshake failure is exactly why version negotiation does not happen
// during the handshake (protocol §1).
//
// Errors before welcome (expected_hello, protocol_unsupported) have no
// welcome to wait for, so they end holding and go to the front.
func (c *Conn) sendError(reqID string, sid *uint16, code, message string, fatal bool) {
	b, err := protocol.Encode(&protocol.Error{ReqID: reqID, SID: sid, Code: code, Message: message})
	if err == nil {
		c.mu.Lock()
		holding := c.holding
		c.mu.Unlock()
		if holding {
			c.releaseWith(b)
		} else {
			c.enqueue(outFrame{data: b})
		}
	}
	if fatal {
		c.closeWith(websocket.StatusPolicyViolation, code)
	}
}

func (c *Conn) String() string { return fmt.Sprintf("conn(%s)", c.ClientID()) }

// onlyHeadSeq reports whether m carries only head_seq (plus sid).
func onlyHeadSeq(m *protocol.SessionUpdated) bool {
	return m.Name == nil && m.NameIsManual == nil && m.CWD == nil && m.Status == nil &&
		m.ExitCode == nil && m.Cols == nil && m.Rows == nil
}
