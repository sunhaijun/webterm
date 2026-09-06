package wsconn

import (
	"errors"

	"github.com/coder/websocket"
	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/session"
)

// handleBinary 处理 INPUT 帧。
func (c *Conn) handleBinary(data []byte) {
	f, err := protocol.DecodeFrame(data)
	if err != nil {
		code := protocol.CodeBadFrame
		if errors.Is(err, protocol.ErrFrameTooLarge) {
			code = protocol.CodeFrameTooLarge
		}
		c.sendError("", nil, code, "二进制帧非法", true)
		return
	}
	if f.Type != protocol.TypeInput {
		c.sendError("", nil, protocol.CodeBadFrame, "client 只能发 INPUT 帧", true)
		return
	}
	sid := f.SID
	s, ok := c.deps.Sessions.Get(sid)
	if !ok {
		c.sendError("", &sid, protocol.CodeUnknownSession, "会话不存在", false)
		return
	}
	switch err := s.Write(c.clientID, f.Seq, f.Payload); {
	case err == nil:
	case errors.Is(err, session.ErrSessionExited):
		// 向已退出的会话写输入：丢弃并回错误，但【不关连接】
		c.sendError("", &sid, protocol.CodeSessionExited, "会话已结束", false)
	case errors.Is(err, session.ErrInputGap):
		c.sendError("", &sid, protocol.CodeInputGap, "输入序列号出现空洞", true)
	case errors.Is(err, session.ErrInputStalled):
		// 前台程序长时间不读 stdin。关掉这条连接而不是阻塞整条连接的读循环。
		c.sendError("", &sid, protocol.CodeInputStalled, "会话输入队列已满", true)
	default:
		c.sendError("", &sid, protocol.CodeInternal, "写入失败", false)
	}
}

// handleControl 处理 JSON 控制消息。未知 t 值必须【忽略】而不是关连接。
func (c *Conn) handleControl(data []byte) {
	msg, err := protocol.Decode(data)
	if err != nil {
		var unknown *protocol.ErrUnknownType
		if errors.As(err, &unknown) {
			return // 前向兼容：忽略不认识的类型
		}
		c.sendError("", nil, protocol.CodeBadFrame, "控制消息无法解析", true)
		return
	}

	switch m := msg.(type) {
	case *protocol.Hello:
		c.sendError("", nil, protocol.CodeBadFrame, "重复的 hello", true)

	case *protocol.SessionCreate:
		c.handleSessionCreate(m)

	case *protocol.SessionClose:
		c.handleSessionClose(m)

	case *protocol.SessionRename:
		s, ok := c.deps.Sessions.Get(m.SID)
		if !ok {
			c.sendError(m.ReqID, &m.SID, protocol.CodeUnknownSession, "会话不存在", false)
			return
		}
		s.Rename(m.Name)

	case *protocol.Subscribe:
		s, ok := c.deps.Sessions.Get(m.SID)
		if !ok {
			c.sendError("", &m.SID, protocol.CodeUnknownSession, "会话不存在", false)
			return
		}
		c.subscribe(s, m.OutSeq)

	case *protocol.Unsubscribe:
		if s, ok := c.deps.Sessions.Get(m.SID); ok {
			s.Unsubscribe(c)
		}
		c.mu.Lock()
		delete(c.subs, m.SID)
		c.mu.Unlock()

	case *protocol.Resize:
		s, ok := c.deps.Sessions.Get(m.SID)
		if !ok {
			c.sendError("", &m.SID, protocol.CodeUnknownSession, "会话不存在", false)
			return
		}
		if err := s.Resize(m.Cols, m.Rows); err != nil {
			c.sendError("", &m.SID, protocol.CodeBadRequest, err.Error(), false)
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
	// 广播给该设备的所有连接；req_id 只出现在发起方的副本上
	c.deps.Hub.Broadcast(&protocol.SessionCreated{Session: s.Snapshot()}, c,
		&protocol.SessionCreated{ReqID: m.ReqID, Session: s.Snapshot()})
	c.subscribe(s, 0)
}

func (c *Conn) handleSessionClose(m *protocol.SessionClose) {
	code, err := c.deps.Sessions.Close(m.SID)
	if err != nil {
		c.sendError(m.ReqID, &m.SID, protocol.CodeUnknownSession, "会话不存在", false)
		return
	}
	c.deps.Hub.Broadcast(&protocol.SessionClosed{SID: m.SID, ExitCode: code}, c,
		&protocol.SessionClosed{ReqID: m.ReqID, SID: m.SID, ExitCode: code})
}

var _ = websocket.StatusNormalClosure
