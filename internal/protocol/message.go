package protocol

import (
	"encoding/json"
	"fmt"
)

// 控制消息类型（协议 §4）。未知的 t 值接收方必须忽略。
const (
	THello         = "hello"
	TSessionCreate = "session.create"
	TSessionClose  = "session.close"
	TSessionRename = "session.rename"
	TSubscribe     = "subscribe"
	TUnsubscribe   = "unsubscribe"
	TResize        = "resize"
	TPing          = "ping"

	TWelcome        = "welcome"
	TSessionCreated = "session.created"
	TSessionClosed  = "session.closed"
	TSessionUpdated = "session.updated"
	TAck            = "ack"
	TReset          = "reset"
	TCWD            = "cwd"
	TPrompt         = "prompt"
	TCommandStart   = "command.start"
	TCommandEnd     = "command.end"
	TPong           = "pong"
	TError          = "error"
	TNotice         = "notice"
)

// 错误码（协议 §7）。
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

// 会话状态与集成状态。
const (
	StatusRunning = "running"
	StatusExited  = "exited"

	IntegrationPending  = "pending"
	IntegrationActive   = "active"
	IntegrationInactive = "inactive"
)

// prompt 状态（驱动输入模式自动切换）。
const (
	PromptInput   = "input"
	PromptRunning = "running"
	PromptDone    = "done"
)

// resumed[].status。
const (
	ResumeOK    = "ok"
	ResumeReset = "reset"
	ResumeGone  = "gone"
)

// ---------- client → agent ----------

type ResumeReq struct {
	SID    uint16 `json:"sid"`
	OutSeq uint64 `json:"out_seq"`
}

// Hello 是连接后的第一条消息。
//
// ClientID 是【每个标签页一个】的 id（存 sessionStorage，不是 localStorage ——
// 后者同源共享，区分不了标签页），也是输入记账的 key。
// InstanceID 是上次 welcome 里拿到的值，与 agent 当前值不符时所有 resume 判 gone。
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
	Name  *string `json:"name"` // null 恢复自动改名
}

type Subscribe struct {
	T      string `json:"t"`
	SID    uint16 `json:"sid"`
	OutSeq uint64 `json:"out_seq"`
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

// ---------- agent → client ----------

type Limits struct {
	MaxSessions   int `json:"max_sessions"`
	RingBytes     int `json:"ring_bytes"`
	MaxFrameBytes int `json:"max_frame_bytes"`
}

// SessionInfo 是会话的完整快照（welcome.sessions[] 与 session.created）。
// 没有 unread 字段 —— 未读由 client 按 head_seq > 本地 out_seq 推导，
// 因为未读天然是 per-client 的，放服务端会让两个标签页互相清对方的未读。
type SessionInfo struct {
	SID          uint16 `json:"sid"`
	Name         string `json:"name"`
	NameIsManual bool   `json:"name_is_manual"`
	CWD          string `json:"cwd"`
	Status       string `json:"status"`
	ExitCode     *int   `json:"exit_code"`
	Cols         uint16 `json:"cols"`
	Rows         uint16 `json:"rows"`
	Integration  string `json:"integration"`
	// PromptState 是重连时重新对齐输入模式用的（协议 §4.2）。
	// prompt 消息只在状态变化时发一次，离线期间的那些就丢了 ——
	// 断线跨过命令边界的话，客户端会停在 Raw、Composer 收起，用户连字都
	// 打不了。集成不可用时为 nil。
	PromptState *string `json:"prompt_state"`
	BaseSeq     uint64  `json:"base_seq"`
	HeadSeq     uint64  `json:"head_seq"`
	CreatedAt   int64   `json:"created_at"`
}

type ResumeResult struct {
	SID     uint16 `json:"sid"`
	Status  string `json:"status"`
	FromSeq uint64 `json:"from_seq"`
	InAck   uint64 `json:"in_ack"`
}

type Welcome struct {
	T             string         `json:"t"`
	Protocol      int            `json:"protocol"`
	ServerVersion string         `json:"server_version"`
	InstanceID    string         `json:"instance_id"`
	Limits        Limits         `json:"limits"`
	Sessions      []SessionInfo  `json:"sessions"`
	Resumed       []ResumeResult `json:"resumed"`
}

type SessionCreated struct {
	T       string      `json:"t"`
	ReqID   string      `json:"req_id,omitempty"` // 只出现在发起请求的那条连接的副本上
	Session SessionInfo `json:"session"`
}

type SessionClosed struct {
	T        string `json:"t"`
	ReqID    string `json:"req_id,omitempty"`
	SID      uint16 `json:"sid"`
	ExitCode *int   `json:"exit_code"`
}

// SessionUpdated 只携带发生变化的字段 + sid，client 做增量合并。
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
	Integration  *string `json:"integration,omitempty"`
	HeadSeq      *uint64 `json:"head_seq,omitempty"`
}

type Ack struct {
	T     string `json:"t"`
	SID   uint16 `json:"sid"`
	InAck uint64 `json:"in_ack"`
}

type Reset struct {
	T       string `json:"t"`
	SID     uint16 `json:"sid"`
	BaseSeq uint64 `json:"base_seq"`
}

type CWD struct {
	T    string `json:"t"`
	SID  uint16 `json:"sid"`
	Path string `json:"path"`
}

type Prompt struct {
	T     string `json:"t"`
	SID   uint16 `json:"sid"`
	State string `json:"state"`
}

type CommandStart struct {
	T      string `json:"t"`
	SID    uint16 `json:"sid"`
	CmdID  int64  `json:"cmd_id"`
	Text   string `json:"text"`
	CWD    string `json:"cwd"`
	At     int64  `json:"at"`
	OutSeq uint64 `json:"out_seq"`
}

type CommandEnd struct {
	T          string `json:"t"`
	SID        uint16 `json:"sid"`
	CmdID      int64  `json:"cmd_id"`
	ExitCode   *int   `json:"exit_code"`
	DurationMS int64  `json:"duration_ms"`
	OutSeq     uint64 `json:"out_seq"`
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

// ---------- 编解码 ----------

// ErrUnknownType 表示 t 是本实现不认识的类型。
// 调用方【必须忽略】这种消息而不是断开连接 —— 前向兼容靠的就是这条（协议 §4）。
type ErrUnknownType struct{ T string }

func (e *ErrUnknownType) Error() string { return "protocol: unknown message type " + e.T }

// Encode 把控制消息编成 JSON，并按类型填好 t 字段。
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
	case *Ack:
		m.T = TAck
	case *Reset:
		m.T = TReset
	case *CWD:
		m.T = TCWD
	case *Prompt:
		m.T = TPrompt
	case *CommandStart:
		m.T = TCommandStart
	case *CommandEnd:
		m.T = TCommandEnd
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

// Decode 解析一条控制消息，返回具体类型的指针。
// t 不认识时返回 *ErrUnknownType —— 调用方应当忽略而不是关连接。
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
	case TAck:
		dst = &Ack{}
	case TReset:
		dst = &Reset{}
	case TCWD:
		dst = &CWD{}
	case TPrompt:
		dst = &Prompt{}
	case TCommandStart:
		dst = &CommandStart{}
	case TCommandEnd:
		dst = &CommandEnd{}
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
