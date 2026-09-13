package wsconn

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/session"
)

// Serve 跑完这条连接的一生：读、写、心跳、吊销巡检。
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
	wg.Wait() // 等写 goroutine 把队列（尤其是致命 error）刷完
	c.detachAll()

	c.mu.Lock()
	code, msg := c.closeCode, c.closeMsg
	c.mu.Unlock()
	_ = c.ws.Close(code, msg)

	if err != nil && !errors.Is(err, context.Canceled) {
		c.log.Debug("连接结束", "client_id", c.clientID, "err", err)
	}
}

// readLoop 读帧并分发。
func (c *Conn) readLoop(ctx context.Context) error {
	first := true
	for {
		select {
		case <-c.done:
			return nil
		default:
		}
		// agent 判死：60 秒没收到任何帧就关连接（AC-2.8）
		rctx, cancel := context.WithTimeout(ctx, c.deps.idleTimeout())
		typ, data, err := c.ws.Read(rctx)
		cancel()
		if err != nil {
			return err
		}

		if first {
			// 收到 hello 之前收到任何其它帧 → expected_hello 并关闭
			if typ != websocket.MessageText {
				c.sendError("", nil, protocol.CodeExpectedHello, "第一条消息必须是 hello", true)
				return nil
			}
			msg, derr := protocol.Decode(data)
			hello, ok := msg.(*protocol.Hello)
			if derr != nil || !ok {
				c.sendError("", nil, protocol.CodeExpectedHello, "第一条消息必须是 hello", true)
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

// writeLoop 把写队列刷到线上。
func (c *Conn) writeLoop(ctx context.Context) {
	ticker := time.NewTicker(ackThrottle)
	defer ticker.Stop()
	for {
		select {
		case <-c.done:
			c.drain()
			c.flushedOnce.Do(func() { close(c.flushed) })
			return
		case <-ctx.Done():
			c.drain()
			c.flushedOnce.Do(func() { close(c.flushed) })
			return
		case <-ticker.C:
			c.flushPendingAcks()
			c.flushPendingHeads()
		case f := <-c.out:
			c.mu.Lock()
			c.queued -= len(f.data)
			c.mu.Unlock()

			typ := websocket.MessageText
			if f.binary {
				typ = websocket.MessageBinary
			}
			// 【不能用 Serve 的 ctx】：closeWith 会把它取消，而 select 在
			// done 与 c.out 同时就绪时是随机挑的 —— 挑中 c.out 就会拿着
			// 一个已取消的 ctx 去写，那条正要告诉用户"为什么断"的 error
			// 就这么丢了。写的时限由 writeTimeout 自己兜。
			wctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
			err := c.ws.Write(wctx, typ, f.data)
			cancel()
			if err != nil {
				c.flushedOnce.Do(func() { close(c.flushed) })
				c.closeWith(websocket.StatusInternalError, "写失败")
				return
			}
		}
	}
}

// drain 在关闭前把写队列里剩下的帧刷出去。
//
// 用独立的 context —— Serve 的那个此刻已经被 cancel 了，拿它写必然失败，
// 而队列里往往正躺着那条要告诉用户"为什么断"的 error。
func (c *Conn) drain() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	for {
		select {
		case f := <-c.out:
			typ := websocket.MessageText
			if f.binary {
				typ = websocket.MessageBinary
			}
			if err := c.ws.Write(ctx, typ, f.data); err != nil {
				return
			}
		default:
			return
		}
	}
}

// flushPendingAcks 补发被节流吞掉的 ack（取最新累计值）。
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
		b, err := protocol.Encode(&protocol.Ack{SID: sid, InAck: inAck})
		if err == nil {
			c.enqueue(outFrame{data: b})
		}
	}
}

// flushPendingHeads 补发被节流吞掉的 head_seq（取最新值）。
//
// 【必须补发】：未订阅会话的输出常常是一阵一阵的 —— 一秒内打完就安静了，
// 后面再没有新输出来触发下一条通知，客户端手里的 head_seq 就永远停在那一阵
// 之前，未读标记不亮（AC-4.3）。ack 一直是这么补的，head_seq 漏了。
func (c *Conn) flushPendingHeads() {
	c.mu.Lock()
	if len(c.pendHead) == 0 {
		c.mu.Unlock()
		return
	}
	now := time.Now()
	ready := make(map[uint16]uint64, len(c.pendHead))
	for sid, head := range c.pendHead {
		// 节流窗口还没过就继续等；期间又订阅了就直接丢（OUTPUT 帧自带进度）
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
		h := head
		b, err := protocol.Encode(&protocol.SessionUpdated{SID: sid, HeadSeq: &h})
		if err == nil {
			c.enqueue(outFrame{data: b})
		}
	}
}

// watchRevocation 每 2 秒查一次设备是否已被吊销（AC-1.11 要求 5 秒内断开，
// 周期取 2 秒是为了留余量）。
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
				c.Event(&protocol.Notice{Level: "error", Message: "此设备已被吊销"})
				c.sendError("", nil, protocol.CodeUnauthorized, "此设备已被吊销", true)
				return
			}
		}
	}
}

// detachAll 连接结束时清理：退订所有会话，并丢弃本 client 尚未写入 PTY
// 的输入（协议 §5.3）。
func (c *Conn) detachAll() {
	c.mu.Lock()
	sids := make([]uint16, 0, len(c.subs))
	for sid := range c.subs {
		sids = append(sids, sid)
	}
	c.subs = make(map[uint16]bool)
	c.mu.Unlock()

	for _, s := range c.deps.Sessions.List() {
		s.Unsubscribe(c)
		s.DetachClient(c.clientID)
	}
	_ = sids
}

// handleHello 处理首条消息并回 welcome。
func (c *Conn) handleHello(h *protocol.Hello) error {
	if h.Protocol != protocol.Version {
		c.sendError("", nil, protocol.CodeProtocolUnsupported,
			"agent 支持协议版本 "+itoa(protocol.Version)+"，client 是 "+itoa(h.Protocol)+"；请刷新页面", true)
		return errors.New("协议版本不匹配")
	}
	c.clientID = h.ClientID
	if c.clientID == "" {
		c.sendError("", nil, protocol.CodeBadRequest, "hello 缺少 client_id", true)
		return errors.New("缺少 client_id")
	}

	resumed := c.deps.Sessions.Resume(c.clientID, h.InstanceID, h.Resume)
	c.Event(&protocol.Welcome{
		Protocol:      protocol.Version,
		ServerVersion: c.deps.ServerVersion,
		InstanceID:    c.deps.Sessions.InstanceID(),
		Limits:        c.deps.Sessions.Limits(),
		Sessions:      c.deps.Sessions.Snapshot(),
		Resumed:       resumed,
	})

	// welcome 之后立刻按 resume 结果补齐输出。
	// 只订阅 client 明确要求续传的会话 —— 其余的它会在切过去时 subscribe。
	want := make(map[uint16]uint64, len(h.Resume))
	for _, req := range h.Resume {
		want[req.SID] = req.OutSeq
	}
	for _, r := range resumed {
		if r.Status == protocol.ResumeGone {
			continue
		}
		s, ok := c.deps.Sessions.Get(r.SID)
		if !ok {
			continue
		}
		// 【传 client 原本要的位置，不是钳过的 from_seq】。
		//
		// 缓冲被覆盖时 from_seq 已经被钳到 base_seq 上，拿它去 Replay
		// 会落进"正常增量"分支 —— 于是 ESC[0m 属性修正不发、flags 不置位，
		// 客户端也就不知道该清屏，会把一段毫不相干的内容接到旧屏幕后面。
		// 钳位是 ring 自己的事，它比谁都清楚要不要 reset。
		c.subscribe(s, want[r.SID])
	}
	return nil
}

func (c *Conn) subscribe(s *session.Session, fromSeq uint64) {
	c.markSubscribed(s.SID())
	s.Subscribe(c, fromSeq)
}

// subscribeNotifyReset 用于 `subscribe` 消息：缓冲被覆盖时先发 reset 通知。
func (c *Conn) subscribeNotifyReset(s *session.Session, fromSeq uint64) {
	c.markSubscribed(s.SID())
	s.SubscribeNotifyReset(c, fromSeq)
}

func (c *Conn) markSubscribed(sid uint16) {
	c.mu.Lock()
	c.subs[sid] = true
	delete(c.pendHead, sid) // 订阅之后 head_seq 通知没有意义了
	c.mu.Unlock()
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	if neg {
		return "-" + string(b)
	}
	return string(b)
}
