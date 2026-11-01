package wsconn

import (
	"errors"

	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/session"
)

// session looks up a session by sid. If there is none it replies with
// unknown_session and keeps the connection open.
func (c *Conn) session(reqID string, sid uint16) (*session.Session, bool) {
	s, ok := c.deps.Sessions.Get(sid)
	if !ok {
		c.unknownSession(reqID, sid)
	}
	return s, ok
}

func (c *Conn) unknownSession(reqID string, sid uint16) {
	c.sendError(reqID, &sid, protocol.CodeUnknownSession, "Session not found", false)
}

// handleBinary handles INPUT frames.
func (c *Conn) handleBinary(data []byte) {
	f, err := protocol.DecodeFrame(data)
	if err != nil {
		code := protocol.CodeBadFrame
		if errors.Is(err, protocol.ErrFrameTooLarge) {
			code = protocol.CodeFrameTooLarge
		}
		c.sendError("", nil, code, "Invalid binary frame", true)
		return
	}
	if !f.FromClient() {
		// Wrong direction: the client sent OUTPUT / SNAPSHOT (protocol §3).
		c.sendError("", nil, protocol.CodeBadFrame, "Clients may only send INPUT frames", true)
		return
	}
	sid := f.SID
	s, ok := c.session("", sid)
	if !ok {
		return
	}
	switch err := s.Write(c.clientID, f.Seq, f.Payload); {
	case err == nil:
	case errors.Is(err, session.ErrSessionExited):
		// Input to an exited session: drop it and reply with an error, but keep
		// the connection open.
		c.sendError("", &sid, protocol.CodeSessionExited, "Session has exited", false)
	case errors.Is(err, session.ErrInputGap):
		c.sendError("", &sid, protocol.CodeInputGap, "Gap in input sequence numbers", true)
	case errors.Is(err, session.ErrInputStalled):
		// The foreground program has not read stdin for a long time. Close this
		// connection rather than block its whole read loop.
		c.sendError("", &sid, protocol.CodeInputStalled, "Session input queue is full", true)
	default:
		c.sendError("", &sid, protocol.CodeInternal, "Write failed", false)
	}
}

// handleControl handles JSON control messages. Unknown t values must be
// ignored, not treated as fatal.
func (c *Conn) handleControl(data []byte) {
	msg, err := protocol.Decode(data)
	if err != nil {
		var unknown *protocol.ErrUnknownType
		if errors.As(err, &unknown) {
			return // forward compatibility: ignore unknown types
		}
		c.sendError("", nil, protocol.CodeBadFrame, "Malformed control message", true)
		return
	}

	switch m := msg.(type) {
	case *protocol.Hello:
		c.sendError("", nil, protocol.CodeBadFrame, "Duplicate hello", true)

	case *protocol.SessionCreate:
		c.handleSessionCreate(m)

	case *protocol.SessionClose:
		// Don't wait in the read loop: a shell that ignores SIGHUP takes a grace
		// period, and this connection carries other sessions too.
		go c.handleSessionClose(m)

	case *protocol.SessionRename:
		if s, ok := c.session(m.ReqID, m.SID); ok {
			s.Rename(m.Name)
		}

	case *protocol.SessionMove:
		c.handleSessionMove(m)

	case *protocol.Subscribe:
		// The session decides between incremental and snapshot (protocol
		// §5.1). The size travels with this message, not as a separate
		// resize: a column change must hit the emulator before the snapshot
		// is taken, and TIOCSWINSZ comes after enqueueing (§4.1).
		if s, ok := c.session("", m.SID); ok {
			c.subscribe(s, m.OutSeq, m.Cols, m.Rows)
		}

	case *protocol.Unsubscribe:
		if s, ok := c.deps.Sessions.Get(m.SID); ok {
			s.Unsubscribe(c)
		}
		c.mu.Lock()
		delete(c.subs, m.SID)
		c.mu.Unlock()

	case *protocol.Resize:
		// On a column change the session resends a snapshot to every subscriber,
		// this connection included (protocol §4.1).
		if s, ok := c.session("", m.SID); ok {
			if err := s.Resize(m.Cols, m.Rows); err != nil {
				c.sendError("", &m.SID, protocol.CodeBadRequest, err.Error(), false)
			}
		}

	case *protocol.Ping:
		c.Event(&protocol.Pong{TS: m.TS})
	}
}

func (c *Conn) handleSessionCreate(m *protocol.SessionCreate) {
	spec := session.Spec{Name: m.Name, Cols: m.Cols, Rows: m.Rows}
	if m.CWD != nil {
		spec.CWD = *m.CWD
	}
	s, err := c.deps.Sessions.Create(spec)
	if err != nil {
		code := protocol.CodeBadRequest
		if errors.Is(err, session.ErrSessionLimit) {
			code = protocol.CodeSessionLimit
		}
		c.sendError(m.ReqID, nil, code, err.Error(), false)
		return
	}
	// Broadcast to all connections; only the originator's copy carries req_id.
	// No auto-subscribe (protocol §4.1): on session.created the client sends
	// subscribe{out_seq: 0} itself and gets the first screen as a snapshot.
	// That is the only way to subscribe.
	info := s.Info()
	c.deps.Hub.Broadcast(&protocol.SessionCreated{Session: info}, c,
		&protocol.SessionCreated{ReqID: m.ReqID, Session: info})
}

// handleSessionClose runs in its own goroutine. It only enqueues, so if the
// connection is gone the messages are simply dropped.
func (c *Conn) handleSessionClose(m *protocol.SessionClose) {
	code, err := c.deps.Sessions.Close(m.SID)
	if err != nil {
		c.unknownSession(m.ReqID, m.SID)
		return
	}
	c.deps.Hub.Broadcast(&protocol.SessionClosed{SID: m.SID, ExitCode: code}, c,
		&protocol.SessionClosed{ReqID: m.ReqID, SID: m.SID, ExitCode: code})
}

// handleSessionMove changes the display order and broadcasts the full order
// to every connection (ADR-0040). It broadcasts even if nothing moved, which
// the originator uses as confirmation. The broadcast happens under Move's
// lock; see Manager.Move.
func (c *Conn) handleSessionMove(m *protocol.SessionMove) {
	err := c.deps.Sessions.Move(m.SID, m.Before, func(sids []uint16) {
		c.deps.Hub.Broadcast(&protocol.SessionOrder{SIDs: sids}, c,
			&protocol.SessionOrder{ReqID: m.ReqID, SIDs: sids})
	})
	if err != nil {
		c.unknownSession(m.ReqID, m.SID)
	}
}
