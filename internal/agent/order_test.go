package agent_test

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/protocol"
)

// orders 返回这条连接收到的 session.order（按到达顺序）。
func (c *wsClient) orders() []*protocol.SessionOrder {
	var out []*protocol.SessionOrder
	for _, m := range c.messages() {
		if o, ok := m.(*protocol.SessionOrder); ok {
			out = append(out, o)
		}
	}
	return out
}

// waitOrder 等到第 n 条 session.order（从 1 数），检查它的 req_id 与 sids。
func (c *wsClient) waitOrder(n int, reqID string, want []uint16) {
	c.t.Helper()
	waitFor(c.t, "第 "+itoa(n)+" 条 session.order", func() bool { return len(c.orders()) >= n })
	got := c.orders()[n-1]
	if got.ReqID != reqID || !slices.Equal(got.SIDs, want) {
		c.t.Fatalf("%s 的第 %d 条 session.order = {req_id:%q sids:%v}, want {req_id:%q sids:%v}",
			c.clientID, n, got.ReqID, got.SIDs, reqID, want)
	}
}

func welcomeOrder(w *protocol.Welcome) []uint16 {
	out := make([]uint16, 0, len(w.Sessions))
	for _, s := range w.Sessions {
		out = append(out, s.SID)
	}
	return out
}

// IT-order-1（连接层，ADR-0040，AC-4.13）：session.move 改完顺序后把完整顺序
// session.order 广播给所有连接，req_id 只在发起方的副本上，位置没变也广播；
// sid 不存在回 unknown_session、不广播；新建 / 关闭不发 session.order；
// welcome.sessions[] 按显示顺序给出。会话管理器那一半在 internal/session。
func TestITOrder1_MoveBroadcastsOrder(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	a := h.connect(ctx, c, "tab-a", nil, "")
	a.welcome()
	b := h.connect(ctx, h.reuse(c), "tab-b", nil, "")
	b.welcome()

	dir := t.TempDir()
	s1, s2, s3 := a.createSession(dir), a.createSession(dir), a.createSession(dir)

	// 挪到某个会话前面
	a.send(&protocol.SessionMove{ReqID: "mv-1", SID: s3, Before: &s1})
	a.waitOrder(1, "mv-1", []uint16{s3, s1, s2})
	b.waitOrder(1, "", []uint16{s3, s1, s2})

	// before 不存在：当最后
	gone := uint16(999)
	a.send(&protocol.SessionMove{ReqID: "mv-2", SID: s1, Before: &gone})
	a.waitOrder(2, "mv-2", []uint16{s3, s2, s1})
	b.waitOrder(2, "", []uint16{s3, s2, s1})

	// before 为 null：放最后
	a.send(&protocol.SessionMove{ReqID: "mv-3", SID: s3})
	a.waitOrder(3, "mv-3", []uint16{s2, s1, s3})
	b.waitOrder(3, "", []uint16{s2, s1, s3})

	// 位置没变也广播：发起方据此确认
	a.send(&protocol.SessionMove{ReqID: "mv-4", SID: s1, Before: &s3})
	a.waitOrder(4, "mv-4", []uint16{s2, s1, s3})
	b.waitOrder(4, "", []uint16{s2, s1, s3})

	// sid 不存在：只回发起方 unknown_session，不广播
	a.send(&protocol.SessionMove{ReqID: "mv-5", SID: gone, Before: &s1})
	waitFor(t, "unknown_session", func() bool {
		for _, e := range a.errors() {
			if e.ReqID == "mv-5" {
				if e.Code != protocol.CodeUnknownSession || e.SID == nil || *e.SID != gone {
					t.Fatalf("error = %+v, want unknown_session sid %d", e, gone)
				}
				return true
			}
		}
		return false
	})
	if a.isClosed() {
		t.Fatal("sid 不存在的 move 把连接关了")
	}

	// 另一条连接发起：req_id 只在它自己的副本上。b 收到的第 5 条就是这一条 ——
	// mv-5 没有广播（同一条连接上的帧按入队顺序到达）
	b.send(&protocol.SessionMove{ReqID: "mv-6", SID: s3, Before: &s2})
	b.waitOrder(5, "mv-6", []uint16{s3, s2, s1})
	a.waitOrder(5, "", []uint16{s3, s2, s1})

	// welcome.sessions[] 按显示顺序
	d := h.connect(ctx, h.reuse(c), "tab-d", nil, "")
	if got, want := welcomeOrder(d.welcome()), []uint16{s3, s2, s1}; !slices.Equal(got, want) {
		t.Fatalf("welcome.sessions[] 的顺序 = %v, want %v", got, want)
	}

	// 新建排最后、关闭去掉，都不发 session.order（两边各自推得出来）
	s4 := d.createSession(dir)
	a.send(&protocol.SessionClose{ReqID: "cl-1", SID: s2})
	waitFor(t, "b 收到 session.closed", func() bool {
		for _, m := range b.messages() {
			if v, ok := m.(*protocol.SessionClosed); ok && v.SID == s2 {
				return true
			}
		}
		return false
	})
	if n := len(b.orders()); n != 5 {
		t.Fatalf("新建 / 关闭发了 session.order：b 一共收到 %d 条，want 5", n)
	}
	if got, want := h.sessions.Order(), []uint16{s3, s1, s4}; !slices.Equal(got, want) {
		t.Fatalf("agent 上的顺序 = %v, want %v", got, want)
	}
	e := h.connect(ctx, h.reuse(c), "tab-e", nil, "")
	if got, want := welcomeOrder(e.welcome()), []uint16{s3, s1, s4}; !slices.Equal(got, want) {
		t.Fatalf("新建 / 关闭之后 welcome.sessions[] = %v, want %v", got, want)
	}
}
