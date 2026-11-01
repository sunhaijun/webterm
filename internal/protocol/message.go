package protocol

import (
	"encoding/json"
	"fmt"
)

// Control message types (protocol §4). Receivers must ignore unknown t values.
const (
	THello         = "hello"
	TSessionCreate = "session.create"
	TSessionClose  = "session.close"
	TSessionRename = "session.rename"
	TSessionMove   = "session.move"
	TSubscribe     = "subscribe"
	TUnsubscribe   = "unsubscribe"
	TResize        = "resize"
	TPing          = "ping"

	TWelcome        = "welcome"
	TSessionCreated = "session.created"
	TSessionClosed  = "session.closed"
	TSessionUpdated = "session.updated"
	TSessionOrder   = "session.order"
	TAck            = "ack"
	TPong           = "pong"
	TError          = "error"
	TNotice         = "notice"
)

// Error codes (protocol §7).
const (
	CodeExpectedHello       = "expected_hello"
	CodeProtocolUnsupported = "protocol_unsupported"
	CodeBadFrame            = "bad_frame"
	CodeFrameTooLarge       = "frame_too_large"
	CodeInputGap            = "input_gap"
	CodeInputStalled        = "input_stalled"
	CodeUnauthorized        = "unauthorized"
	CodeUnknownSession      = "unknown_session"
	CodeSessionExited       = "session_exited"
	CodeSessionLimit        = "session_limit"
	CodeBadRequest          = "bad_request"
	CodeInternal            = "internal"
)

// Session status values.
const (
	StatusRunning = "running"
	StatusExited  = "exited"
)

// Values of resumed[].status (protocol §4.2 / §5.1).
const (
	ResumeOK       = "ok"       // incremental: OUTPUT continues from from_seq (the client's out_seq)
	ResumeSnapshot = "snapshot" // expect SNAPSHOT frames; from_seq is the snapshot's seq
	ResumeGone     = "gone"     // unknown sid or instance_id mismatch
)

// ---------- client -> agent ----------

type ResumeReq struct {
	SID    uint16 `json:"sid"`
	OutSeq uint64 `json:"out_seq"`
}

// Hello is the first message on a connection.
//
// ClientID is generated once per page load and kept in memory only (never in
// sessionStorage or localStorage, protocol §4.1). It keys input accounting.
// InstanceID is the value from the previous welcome; if it differs from the
// agent's current one, every resume is answered with gone.
type Hello struct {
	T          string      `json:"t"`
	Protocol   int         `json:"protocol"`
	ClientID   string      `json:"client_id"`
	InstanceID string      `json:"instance_id,omitempty"`
	Resume     []ResumeReq `json:"resume"`
}

type SessionCreate struct {
	T     string  `json:"t"`
	ReqID string  `json:"req_id"`
	Name  *string `json:"name"`
	CWD   *string `json:"cwd"`
	Cols  uint16  `json:"cols"`
	Rows  uint16  `json:"rows"`
}

type SessionClose struct {
	T     string `json:"t"`
	ReqID string `json:"req_id"`
	SID   uint16 `json:"sid"`
}

type SessionRename struct {
	T     string  `json:"t"`
	ReqID string  `json:"req_id"`
	SID   uint16  `json:"sid"`
	Name  *string `json:"name"` // null restores automatic naming
}

// SessionMove moves session SID in front of Before (ADR-0040).
//
// A null Before moves it to the end. A Before that no longer exists (closed
// elsewhere) is treated as null, and Before == SID is a no-op; neither is an
// error. The message names a neighbor rather than a target index because,
// with two devices reordering at once, an index may already point elsewhere.
type SessionMove struct {
	T      string  `json:"t"`
	ReqID  string  `json:"req_id"`
	SID    uint16  `json:"sid"`
	Before *uint16 `json:"before"` // null = move to the end
}

type Subscribe struct {
	T      string `json:"t"`
	SID    uint16 `json:"sid"`
	OutSeq uint64 `json:"out_seq"`
	// Cols/Rows are the current terminal size; 0 keeps the session's size.
	//
	// The size must ride on subscribe, not a separate resize. Under one lock
	// the agent resizes the emulator, decides incremental vs snapshot, and
	// enqueues; only then, outside the lock, does it TIOCSWINSZ. The bytes a
	// program redraws on SIGWINCH therefore always follow the snapshot or
	// delta (protocol §4.1).
	Cols uint16 `json:"cols,omitempty"`
	Rows uint16 `json:"rows,omitempty"`
}

type Unsubscribe struct {
	T   string `json:"t"`
	SID uint16 `json:"sid"`
}

type Resize struct {
	T    string `json:"t"`
	SID  uint16 `json:"sid"`
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

type Ping struct {
	T  string `json:"t"`
	TS int64  `json:"ts"`
}

// ---------- agent -> client ----------

type Limits struct {
	MaxSessions   int `json:"max_sessions"`
	RingBytes     int `json:"ring_bytes"`
	MaxFrameBytes int `json:"max_frame_bytes"`
}

// SessionInfo is the full state of a session (welcome.sessions[] and
// session.created). There is no unread field: clients derive it from
// head_seq > local out_seq. Unread is inherently per client; tracking it on
// the server would let two tabs clear each other's unread state.
type SessionInfo struct {
	SID          uint16 `json:"sid"`
	Name         string `json:"name"`
	NameIsManual bool   `json:"name_is_manual"`
	CWD          string `json:"cwd"`
	Status       string `json:"status"`
	ExitCode     *int   `json:"exit_code"`
	Cols         uint16 `json:"cols"`
	Rows         uint16 `json:"rows"`
	BaseSeq      uint64 `json:"base_seq"`
	HeadSeq      uint64 `json:"head_seq"`
	CreatedAt    int64  `json:"created_at"`
}

// ResumeResult is one entry of welcome.resumed[].
//
// FromSeq is the client's own out_seq for ok, the snapshot's seq for snapshot
// (later OUTPUT continues from there), and 0 for gone.
type ResumeResult struct {
	SID     uint16 `json:"sid"`
	Status  string `json:"status"`
	FromSeq uint64 `json:"from_seq"`
	InAck   uint64 `json:"in_ack"`
}

type Welcome struct {
	T             string `json:"t"`
	Protocol      int    `json:"protocol"`
	ServerVersion string `json:"server_version"`
	InstanceID    string `json:"instance_id"`
	// Home is the agent user's home directory; the frontend uses it to
	// abbreviate CWD as ~ (protocol §4.2).
	Home     string         `json:"home"`
	Limits   Limits         `json:"limits"`
	Sessions []SessionInfo  `json:"sessions"`
	Resumed  []ResumeResult `json:"resumed"`
}

type SessionCreated struct {
	T       string      `json:"t"`
	ReqID   string      `json:"req_id,omitempty"` // set only on the copy sent to the requesting connection
	Session SessionInfo `json:"session"`
}

type SessionClosed struct {
	T        string `json:"t"`
	ReqID    string `json:"req_id,omitempty"`
	SID      uint16 `json:"sid"`
	ExitCode *int   `json:"exit_code"`
}

// SessionUpdated carries sid plus only the fields that changed; clients merge
// it into their state.
type SessionUpdated struct {
	T            string  `json:"t"`
	SID          uint16  `json:"sid"`
	Name         *string `json:"name,omitempty"`
	NameIsManual *bool   `json:"name_is_manual,omitempty"`
	CWD          *string `json:"cwd,omitempty"`
	Status       *string `json:"status,omitempty"`
	ExitCode     *int    `json:"exit_code,omitempty"`
	Cols         *uint16 `json:"cols,omitempty"`
	Rows         *uint16 `json:"rows,omitempty"`
	HeadSeq      *uint64 `json:"head_seq,omitempty"`
}

// SessionOrder is the full display order after a session.move; clients replace
// theirs wholesale (ADR-0040). It is not sent on create or close: new sessions
// go last and closed ones drop out, which both sides can derive.
type SessionOrder struct {
	T     string   `json:"t"`
	ReqID string   `json:"req_id,omitempty"` // set only on the copy sent to the requesting connection
	SIDs  []uint16 `json:"sids"`
}

type Ack struct {
	T     string `json:"t"`
	SID   uint16 `json:"sid"`
	InAck uint64 `json:"in_ack"`
}

type Pong struct {
	T  string `json:"t"`
	TS int64  `json:"ts"`
}

type Error struct {
	T       string  `json:"t"`
	ReqID   string  `json:"req_id,omitempty"`
	SID     *uint16 `json:"sid,omitempty"`
	Code    string  `json:"code"`
	Message string  `json:"message"`
}

type Notice struct {
	T       string `json:"t"`
	Level   string `json:"level"` // info | warn | error
	Message string `json:"message"`
}

// ---------- encoding ----------

// ErrUnknownType reports a message whose t this implementation does not know.
// Callers must ignore such messages rather than disconnect; forward
// compatibility depends on it (protocol §4).
type ErrUnknownType struct{ T string }

func (e *ErrUnknownType) Error() string { return "protocol: unknown message type " + e.T }

// Encode marshals a control message to JSON, setting t from its type.
func Encode(msg any) ([]byte, error) {
	switch m := msg.(type) {
	case *Hello:
		m.T = THello
	case *SessionCreate:
		m.T = TSessionCreate
	case *SessionClose:
		m.T = TSessionClose
	case *SessionRename:
		m.T = TSessionRename
	case *SessionMove:
		m.T = TSessionMove
	case *Subscribe:
		m.T = TSubscribe
	case *Unsubscribe:
		m.T = TUnsubscribe
	case *Resize:
		m.T = TResize
	case *Ping:
		m.T = TPing
	case *Welcome:
		m.T = TWelcome
	case *SessionCreated:
		m.T = TSessionCreated
	case *SessionClosed:
		m.T = TSessionClosed
	case *SessionUpdated:
		m.T = TSessionUpdated
	case *SessionOrder:
		m.T = TSessionOrder
	case *Ack:
		m.T = TAck
	case *Pong:
		m.T = TPong
	case *Error:
		m.T = TError
	case *Notice:
		m.T = TNotice
	default:
		return nil, fmt.Errorf("protocol: not a control message: %T", msg)
	}
	return json.Marshal(msg)
}

// Decode parses a control message and returns a pointer to its concrete type.
// An unknown t returns *ErrUnknownType, which callers should ignore rather than
// close the connection.
func Decode(data []byte) (any, error) {
	var probe struct {
		T string `json:"t"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return nil, ErrBadFrame
	}
	if probe.T == "" {
		return nil, ErrBadFrame
	}
	var dst any
	switch probe.T {
	case THello:
		dst = &Hello{}
	case TSessionCreate:
		dst = &SessionCreate{}
	case TSessionClose:
		dst = &SessionClose{}
	case TSessionRename:
		dst = &SessionRename{}
	case TSessionMove:
		dst = &SessionMove{}
	case TSubscribe:
		dst = &Subscribe{}
	case TUnsubscribe:
		dst = &Unsubscribe{}
	case TResize:
		dst = &Resize{}
	case TPing:
		dst = &Ping{}
	case TWelcome:
		dst = &Welcome{}
	case TSessionCreated:
		dst = &SessionCreated{}
	case TSessionClosed:
		dst = &SessionClosed{}
	case TSessionUpdated:
		dst = &SessionUpdated{}
	case TSessionOrder:
		dst = &SessionOrder{}
	case TAck:
		dst = &Ack{}
	case TPong:
		dst = &Pong{}
	case TError:
		dst = &Error{}
	case TNotice:
		dst = &Notice{}
	default:
		return nil, &ErrUnknownType{T: probe.T}
	}
	if err := json.Unmarshal(data, dst); err != nil {
		return nil, ErrBadFrame
	}
	return dst, nil
}
