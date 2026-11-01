package wsconn

import (
	"context"
	"errors"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/session"
)

// Serve runs the connection for its whole life: reading, writing, idle
// detection and revocation checks.
func (c *Conn) Serve(ctx context.Context) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	c.mu.Lock()
	c.cancel = cancel
	c.mu.Unlock()

	var wg sync.WaitGroup
	wg.Add(1)
	go func() { defer wg.Done(); c.writeLoop(ctx) }()
	go c.watchRevocation(ctx)

	err := c.readLoop(ctx)

	c.closeWith(websocket.StatusNormalClosure, "")
	wg.Wait() // let the writer flush the queue, fatal errors in particular
	c.detachAll()

	c.mu.Lock()
	code, msg := c.closeCode, c.closeMsg
	c.mu.Unlock()
	_ = c.ws.Close(code, msg)

	if err != nil && !errors.Is(err, context.Canceled) {
		c.log.Debug("connection ended", "client_id", c.clientID, "err", err)
	}
}

// readLoop reads frames and dispatches them.
func (c *Conn) readLoop(ctx context.Context) error {
	first := true
	for {
		select {
		case <-c.done:
			return nil
		default:
		}
		// Idle detection: close after 60 seconds without any frame (AC-2.8).
		rctx, cancel := context.WithTimeout(ctx, c.deps.idleTimeout())
		typ, data, err := c.ws.Read(rctx)
		cancel()
		if err != nil {
			return err
		}

		if first {
			// Any frame other than hello first → expected_hello and close.
			if typ != websocket.MessageText {
				c.sendError("", nil, protocol.CodeExpectedHello, "First message must be hello", true)
				return nil
			}
			msg, derr := protocol.Decode(data)
			hello, ok := msg.(*protocol.Hello)
			if derr != nil || !ok {
				c.sendError("", nil, protocol.CodeExpectedHello, "First message must be hello", true)
				return nil
			}
			if err := c.handleHello(hello); err != nil {
				return nil
			}
			first = false
			continue
		}

		switch typ {
		case websocket.MessageBinary:
			c.handleBinary(data)
		case websocket.MessageText:
			c.handleControl(data)
		}
	}
}

// writeLoop flushes the write queue to the wire. It runs once per connection
// and closes flushed on every exit path.
func (c *Conn) writeLoop(ctx context.Context) {
	defer close(c.flushed)
	ticker := time.NewTicker(ackThrottle)
	defer ticker.Stop()
	for {
		select {
		case <-c.done:
			c.drain()
			return
		case <-ctx.Done():
			c.drain()
			return
		case <-ticker.C:
			c.flushPendingAcks()
			c.flushPendingHeads()
		case <-c.wake:
			for {
				f, ok := c.pop()
				if !ok {
					break
				}
				// Not Serve's ctx: closeWith cancels it, often while the queue
				// still holds the error that tells the user why the connection
				// dropped. writeTimeout bounds the write instead.
				wctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
				err := c.ws.Write(wctx, frameType(f), f.data)
				cancel()
				if err != nil {
					c.closeWith(websocket.StatusInternalError, "write failed")
					return
				}
			}
		}
	}
}

func frameType(f outFrame) websocket.MessageType {
	if f.binary {
		return websocket.MessageBinary
	}
	return websocket.MessageText
}

// drain flushes the remaining frames before closing.
//
// It uses its own context: Serve's is already canceled at this point, so
// writes with it would fail, and the queue often holds the error that tells
// the user why the connection dropped.
func (c *Conn) drain() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	for {
		f, ok := c.pop()
		if !ok {
			return
		}
		if err := c.ws.Write(ctx, frameType(f), f.data); err != nil {
			return
		}
	}
}

// flushPendingAcks sends acks held back by throttling, using the latest
// cumulative value.
func (c *Conn) flushPendingAcks() {
	c.mu.Lock()
	if len(c.pendAck) == 0 {
		c.mu.Unlock()
		return
	}
	pend := c.pendAck
	c.pendAck = make(map[uint16]uint64, len(pend))
	now := time.Now()
	for sid := range pend {
		c.lastAck[sid] = now
	}
	c.mu.Unlock()

	for sid, inAck := range pend {
		c.send(&protocol.Ack{SID: sid, InAck: inAck})
	}
}

// flushPendingHeads sends head_seq values held back by throttling, using the
// latest value.
//
// This is required: output from an unsubscribed session often comes in short
// bursts. If a burst ends within the throttle window and nothing follows, the
// client's head_seq would stay before the burst forever and the unread dot
// would never light up (AC-4.3).
func (c *Conn) flushPendingHeads() {
	c.mu.Lock()
	if len(c.pendHead) == 0 {
		c.mu.Unlock()
		return
	}
	now := time.Now()
	ready := make(map[uint16]uint64, len(c.pendHead))
	for sid, head := range c.pendHead {
		// Keep waiting while the throttle window is open. If the session got
		// subscribed meanwhile, drop it: OUTPUT frames carry progress.
		if c.subs[sid] {
			delete(c.pendHead, sid)
			continue
		}
		if now.Sub(c.lastHead[sid]) < headSeqThrottle {
			continue
		}
		ready[sid] = head
		c.lastHead[sid] = now
		delete(c.pendHead, sid)
	}
	c.mu.Unlock()

	for sid, head := range ready {
		c.send(&protocol.SessionUpdated{SID: sid, HeadSeq: &head})
	}
}

// watchRevocation checks every 2 seconds whether the device has been
// revoked. AC-1.11 requires a disconnect within 5 seconds; 2 seconds leaves
// headroom.
func (c *Conn) watchRevocation(ctx context.Context) {
	if c.deps.Revoked == nil {
		return
	}
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-c.done:
			return
		case <-t.C:
			if c.deps.Revoked() {
				c.Event(&protocol.Notice{Level: "error", Message: "This device has been revoked"})
				c.sendError("", nil, protocol.CodeUnauthorized, "This device has been revoked", true)
				return
			}
		}
	}
}

// detachAll cleans up when the connection ends: it unsubscribes from every
// session and discards this client's input not yet written to the PTY
// (protocol §5.3).
func (c *Conn) detachAll() {
	c.mu.Lock()
	clear(c.subs)
	c.mu.Unlock()

	for _, s := range c.deps.Sessions.List() {
		s.Unsubscribe(c)
		s.DetachClient(c.clientID)
	}
}

// handleHello handles the first message and replies with welcome.
//
// Deciding the resume, enqueueing catch-up frames and joining the subscriber
// set are one step (Manager.Resume → Session.Subscribe, under the session
// lock). welcome reports that decision, so it is produced after the catch-up
// frames. The write queue has been held since the connection was created (see
// Conn.holding); welcome goes to the front and everything is released
// together, so the client sees welcome → each session's SNAPSHOT / OUTPUT.
func (c *Conn) handleHello(h *protocol.Hello) error {
	if h.Protocol != protocol.Version {
		c.sendError("", nil, protocol.CodeProtocolUnsupported,
			"agent speaks protocol "+strconv.Itoa(protocol.Version)+", client speaks "+strconv.Itoa(h.Protocol)+"; reload the page", true)
		return errors.New("protocol version mismatch")
	}
	c.clientID = h.ClientID
	if c.clientID == "" {
		c.sendError("", nil, protocol.CodeBadRequest, "hello is missing client_id", true)
		return errors.New("missing client_id")
	}

	// Subscribe only to sessions the client asked to resume; it subscribes to
	// the others when it switches to them.
	for _, r := range h.Resume {
		if _, ok := c.deps.Sessions.Get(r.SID); ok {
			c.markSubscribed(r.SID)
		}
	}
	resumed := c.deps.Sessions.Resume(c, h.InstanceID, h.Resume)
	c.mu.Lock()
	for _, r := range resumed {
		if r.Status == protocol.ResumeGone {
			delete(c.subs, r.SID)
		}
	}
	c.mu.Unlock()

	home, _ := os.UserHomeDir()
	b, err := protocol.Encode(&protocol.Welcome{
		Protocol:      protocol.Version,
		ServerVersion: c.deps.ServerVersion,
		InstanceID:    c.deps.Sessions.InstanceID(),
		Home:          home,
		Limits:        c.deps.Sessions.Limits(),
		Sessions:      c.deps.Sessions.Infos(),
		Resumed:       resumed,
	})
	if err != nil {
		c.sendError("", nil, protocol.CodeInternal, "Failed to encode welcome", true)
		return err
	}
	c.releaseWith(b)
	return nil
}

// subscribe subscribes to a session; the session decides between incremental
// and snapshot (protocol §5.1). cols/rows of 0 keep the session's current
// size.
func (c *Conn) subscribe(s *session.Session, outSeq uint64, cols, rows uint16) {
	c.markSubscribed(s.SID())
	s.Subscribe(c, outSeq, cols, rows)
}

func (c *Conn) markSubscribed(sid uint16) {
	c.mu.Lock()
	c.subs[sid] = true
	delete(c.pendHead, sid) // head_seq notifications are pointless once subscribed
	c.mu.Unlock()
}
