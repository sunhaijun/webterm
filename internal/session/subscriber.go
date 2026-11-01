// Package session manages PTY sessions. Each session is a PTY, a ring buffer,
// a terminal emulator, and a set of subscribers.
//
// The contract is in docs/50-backend/session-manager.md and ADR-0026.
//
// Sessions know nothing about WebSockets; they see only the Subscriber
// interface, so session logic can be tested without a network
// (IT-session-* / IT-resume-*).
package session

// Subscriber receives session output. The connection layer implements it.
//
// The three push methods must not block: use a bounded queue and disconnect
// when it fills. Blocking would back-pressure PTY.Read(), letting one slow
// client stall real work on the server.
//
// Push and Snapshot for a session are called under the session lock (see
// Session.consume), so their call order is the protocol order; implementations
// only need to enqueue in call order.
type Subscriber interface {
	// ClientID returns the id of the browser tab this subscriber belongs to.
	// Input is accounted per (client_id, sid), and acks go only to that
	// client.
	ClientID() string

	// Push sends raw output (an OUTPUT frame). seq is the out_seq of data's
	// first byte; data is a copy the callee may keep.
	Push(sid uint16, seq uint64, data []byte)

	// Snapshot sends a snapshot (SNAPSHOT frames). seq is the out_seq the
	// snapshot represents; data does not count toward seq. The connection
	// layer splits it at the frame size limit and must enqueue the frames of
	// one snapshot contiguously (protocol §3).
	Snapshot(sid uint16, seq uint64, data []byte)

	// Event sends a control message (*protocol.SessionUpdated,
	// *protocol.Ack, ...).
	Event(msg any)
}
