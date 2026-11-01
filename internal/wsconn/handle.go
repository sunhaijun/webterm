package wsconn

import (
	"errors"

	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/session"
)

// session 按 sid 取会话；不存在就回 unknown_session（不关连接）。
func (c *Conn) session(reqID string, sid uint16) (*session.Session, bool) {
	s, ok := c.deps.Sessions.Get(sid)
	if !ok {
		c.unknownSession(reqID, sid)
	}
	return s, ok
}

func (c *Conn) unknownSession(reqID string, sid uint16) {
	c.sendError(reqID, &sid, protocol.CodeUnknownSession, "会话不存在", false)
}

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
	if !f.FromClient() {
		// 方向不对：client 发来 OUTPUT / SNAPSHOT（协议 §3）
		c.sendError("", nil, protocol.CodeBadFrame, "client 只能发 INPUT 帧", true)
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
		// 不在读循环里等：shell 不理 SIGHUP 时要等宽限期，而这条连接还载着别的会话
		go c.handleSessionClose(m)

	case *protocol.SessionRename:
		if s, ok := c.session(m.ReqID, m.SID); ok {
			s.Rename(m.Name)
		}

	case *protocol.SessionMove:
		c.handleSessionMove(m)

	case *protocol.Subscribe:
		// 增量还是快照由会话判定（协议 §5.1）。尺寸跟着这条消息走，【不能单发
		// resize】：列数变了要先改模拟器再出快照，TIOCSWINSZ 排在入队之后（§4.1）
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
		// 列数变了：会话给每个订阅者（包括本连接）重发一份快照（协议 §4.1）
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
	// 广播给该设备的所有连接；req_id 只出现在发起方的副本上。
	// 【不自动订阅】（协议 §4.1）：client 收到 session.created 后自己发
	// subscribe{out_seq: 0}，走快照拿第一屏 —— 订阅只有这一条路。
	info := s.Info()
	c.deps.Hub.Broadcast(&protocol.SessionCreated{Session: info}, c,
		&protocol.SessionCreated{ReqID: m.ReqID, Session: info})
}

// handleSessionClose 在自己的 goroutine 里跑：里面只有入队，连接关了也只是丢弃。
func (c *Conn) handleSessionClose(m *protocol.SessionClose) {
	code, err := c.deps.Sessions.Close(m.SID)
	if err != nil {
		c.unknownSession(m.ReqID, m.SID)
		return
	}
	c.deps.Hub.Broadcast(&protocol.SessionClosed{SID: m.SID, ExitCode: code}, c,
		&protocol.SessionClosed{ReqID: m.ReqID, SID: m.SID, ExitCode: code})
}

// handleSessionMove 改显示顺序并把完整顺序广播给所有连接（ADR-0040）。位置没变
// 也广播，发起方据此确认。广播在 Move 的锁里做，见 Manager.Move。
func (c *Conn) handleSessionMove(m *protocol.SessionMove) {
	err := c.deps.Sessions.Move(m.SID, m.Before, func(sids []uint16) {
		c.deps.Hub.Broadcast(&protocol.SessionOrder{SIDs: sids}, c,
			&protocol.SessionOrder{ReqID: m.ReqID, SIDs: sids})
	})
	if err != nil {
		c.unknownSession(m.ReqID, m.SID)
	}
}
