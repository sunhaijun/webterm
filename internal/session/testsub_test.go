package session_test

import (
	"bytes"
	"sync"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/session"
)

// fakeConn 是一个测试用订阅者，模拟连接层：它按协议规则做 seq 记账，
// 把收到的 OUTPUT 拼成"客户端屏幕"。
//
// 它【严格校验】seq 连续性 —— 任何重复、空洞、AttrPrefix 记账错误都会
// 当场失败，而不是留到 E2E 才暴露。
type fakeConn struct {
	t        *testing.T
	clientID string

	// inSeqNext 是客户端侧的输入记账：下一个要分配的 in_seq。
	// 重连后必须按 welcome.resumed[].in_ack 裁剪它，见 TrimTo。
	inSeqNext uint64

	mu       sync.Mutex
	screen   bytes.Buffer // 收到的字节流（等价于 xterm 缓冲的输入）
	expected uint64       // 下一帧应有的 seq
	haveSeq  bool
	events   []any
	gaps     int
	dups     int
	resets   int
	detached bool // 连接已断开：迟到的 Push 应当石沉大海
}

// Detach 模拟连接断开。断开后到达的 Push 被丢弃 —— 真实的连接层此时
// socket 已经关了，字节根本发不出去。测试必须忠实模拟这一点，否则
// "断点在哪"会被竞态污染。
func (c *fakeConn) Detach() {
	c.mu.Lock()
	c.detached = true
	c.mu.Unlock()
}

// Attach 模拟重连完成，可以继续接收。
func (c *fakeConn) Attach() {
	c.mu.Lock()
	c.detached = false
	c.mu.Unlock()
}

func newConn(t *testing.T, clientID string) *fakeConn {
	return &fakeConn{t: t, clientID: clientID}
}

func (c *fakeConn) ClientID() string { return c.clientID }

// Send 模拟客户端发一段输入：分配 in_seq 并推进本地计数。
func (c *fakeConn) Send(s *session.Session, data string) error {
	err := s.Write(c.clientID, c.inSeqNext, []byte(data))
	if err == nil {
		c.inSeqNext += uint64(len(data))
	}
	return err
}

// Resend 模拟重发：从指定 seq 起重新发送，不推进本地计数
// （agent 会丢弃其中已处理的前缀）。
func (c *fakeConn) Resend(s *session.Session, from uint64, data string) error {
	return s.Write(c.clientID, from, []byte(data))
}

// TrimTo 按 welcome.resumed[].in_ack 裁剪重发队列。
func (c *fakeConn) TrimTo(inAck uint64) { c.inSeqNext = inAck }

func (c *fakeConn) Push(sid uint16, seq uint64, data []byte, attrPrefix bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.detached {
		return
	}

	if attrPrefix {
		// reset 回放：客户端清屏，然后从这里重新开始记账。
		// 前置的 4 个字节是渲染修正，【不计入 seq】。
		c.resets++
		c.screen.Reset()
		c.screen.Write(protocol.AttrPrefix)
		c.screen.Write(data)
		c.expected = seq + uint64(len(data))
		c.haveSeq = true
		return
	}

	if c.haveSeq {
		switch {
		case seq > c.expected:
			c.gaps++
			c.t.Errorf("seq 空洞：收到 %d，期望 %d（差 %d 字节）", seq, c.expected, seq-c.expected)
			return
		case seq < c.expected:
			c.dups++
			c.t.Errorf("seq 倒退：收到 %d，期望 %d", seq, c.expected)
			return
		}
	}
	c.screen.Write(data)
	c.expected = seq + uint64(len(data))
	c.haveSeq = true
}

func (c *fakeConn) Event(msg any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events = append(c.events, msg)
}

func (c *fakeConn) Screen() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.screen.String()
}

func (c *fakeConn) OutSeq() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.expected
}

func (c *fakeConn) Resets() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.resets
}

// InAck 返回最近一条 ack 里的值。
func (c *fakeConn) InAck() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	var v uint64
	for _, e := range c.events {
		if a, ok := e.(*protocol.Ack); ok {
			v = a.InAck
		}
	}
	return v
}

func (c *fakeConn) Events() []any {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]any(nil), c.events...)
}

// waitFor 轮询到 cond 成立，或超时失败。PTY 是异步的，测试必须等。
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("超时等待：%s", what)
}

// waitScreen 等屏幕内容包含 sub。
func waitScreen(t *testing.T, c *fakeConn, sub string) {
	t.Helper()
	waitFor(t, "屏幕出现 "+sub, func() bool { return bytes.Contains([]byte(c.Screen()), []byte(sub)) })
}

func newManager(t *testing.T, cfg session.Config) *session.Manager {
	t.Helper()
	m := session.NewManager(cfg, nil)
	t.Cleanup(m.Shutdown)
	return m
}
