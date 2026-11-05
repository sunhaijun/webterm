package wsconn

import (
	"errors"
	"sync"

	"github.com/coder/websocket"
	"github.com/sunhaijun/webterm/internal/protocol"
)

// ErrTooManyConns means the concurrent connection limit has been reached.
var ErrTooManyConns = errors.New("wsconn: too many concurrent connections")

// Hub holds all live connections.
//
// The connection count must be capped: protocol §1 allows any number of tabs
// per device, and each connection carries a 4 MiB write queue. Without a cap
// that is a path to memory exhaustion (threat model T6).
type Hub struct {
	mu       sync.Mutex
	conns    map[*Conn]struct{}
	maxConns int
}

// NewHub creates a Hub. maxConns <= 0 means the default of 16.
func NewHub(maxConns int) *Hub {
	if maxConns <= 0 {
		maxConns = 16
	}
	return &Hub{conns: make(map[*Conn]struct{}), maxConns: maxConns}
}

// Add registers a connection. It returns ErrTooManyConns when the hub is
// full; callers should reject the connection during the handshake.
func (h *Hub) Add(c *Conn) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.conns) >= h.maxConns {
		return ErrTooManyConns
	}
	h.conns[c] = struct{}{}
	return nil
}

// Remove unregisters a connection.
func (h *Hub) Remove(c *Conn) {
	h.mu.Lock()
	delete(h.conns, c)
	h.mu.Unlock()
}

// Supersede closes the other connections with c's client_id. A page holds
// one socket at a time, so those are sockets it abandoned without a close
// reaching us (a dead link). Left alone they would linger until the idle
// timeout, pushing output into the void.
func (h *Hub) Supersede(c *Conn) {
	id := c.ClientID()
	h.mu.Lock()
	var old []*Conn
	for o := range h.conns {
		if o != c && o.ClientID() == id {
			old = append(old, o)
		}
	}
	h.mu.Unlock()
	for _, o := range old {
		o.closeWith(websocket.StatusGoingAway, "superseded by a newer connection")
	}
}

// Count returns the number of live connections.
func (h *Hub) Count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.conns)
}

// Full reports whether the hub is at its limit.
func (h *Hub) Full() bool { return h.Count() >= h.maxConns }

// Broadcast sends msg to every connection except origin, and originMsg to
// origin.
//
// session.created / closed / order go through here; otherwise tab B would not
// see a session created in tab A. Only the originating connection's copy
// carries req_id. session.updated is sent by the session through the
// Manager's observer.
func (h *Hub) Broadcast(msg any, origin *Conn, originMsg any) {
	h.mu.Lock()
	targets := make([]*Conn, 0, len(h.conns))
	for c := range h.conns {
		targets = append(targets, c)
	}
	h.mu.Unlock()

	for _, c := range targets {
		if c == origin {
			if originMsg != nil {
				c.Event(originMsg)
			}
			continue
		}
		c.Event(msg)
	}
}

// NoticeAll broadcasts a notice to every connection, such as the shutdown
// warning on SIGTERM.
func (h *Hub) NoticeAll(level, message string) {
	h.Broadcast(&protocol.Notice{Level: level, Message: message}, nil, nil)
}

// CloseAll closes every connection.
func (h *Hub) CloseAll() {
	h.mu.Lock()
	targets := make([]*Conn, 0, len(h.conns))
	for c := range h.conns {
		targets = append(targets, c)
	}
	h.mu.Unlock()
	for _, c := range targets {
		c.closeWith(websocket.StatusGoingAway, "agent is shutting down")
	}
}
