package wsconn

import (
	"errors"
	"sync"

	"github.com/coder/websocket"
	"github.com/sunhaijun/webterm/internal/protocol"
)

// ErrTooManyConns 表示并发连接数已达上限。
var ErrTooManyConns = errors.New("wsconn: 并发连接数已达上限")

// Hub 持有当前所有连接。
//
// 连接数【必须有上限】：协议 §1 允许同设备开任意多标签页，而每条连接挂着
// 一个 4 MiB 的写队列 —— 不设限就是一条内存耗尽的路（威胁模型 T6）。
type Hub struct {
	mu       sync.Mutex
	conns    map[*Conn]struct{}
	maxConns int
}

// NewHub 创建连接表。maxConns <= 0 表示用默认值 16。
func NewHub(maxConns int) *Hub {
	if maxConns <= 0 {
		maxConns = 16
	}
	return &Hub{conns: make(map[*Conn]struct{}), maxConns: maxConns}
}

// Add 登记一条连接。超过上限返回 ErrTooManyConns（调用方应在握手阶段就拒绝）。
func (h *Hub) Add(c *Conn) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.conns) >= h.maxConns {
		return ErrTooManyConns
	}
	h.conns[c] = struct{}{}
	return nil
}

// Remove 摘掉一条连接。
func (h *Hub) Remove(c *Conn) {
	h.mu.Lock()
	delete(h.conns, c)
	h.mu.Unlock()
}

// Count 返回当前连接数。
func (h *Hub) Count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.conns)
}

// Full 报告是否已满。
func (h *Hub) Full() bool { return h.Count() >= h.maxConns }

// Broadcast 把 msg 发给除 origin 外的所有连接，把 originMsg 发给 origin。
//
// session.created / closed / updated / order 都要广播 —— 否则 B 标签页看不到
// A 新建的会话。req_id 只出现在发起请求的那条连接的副本上。
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

// NoticeAll 向所有连接广播一条 notice（如 SIGTERM 时的关闭预告）。
func (h *Hub) NoticeAll(level, message string) {
	h.Broadcast(&protocol.Notice{Level: level, Message: message}, nil, nil)
}

// CloseAll 关闭所有连接。
func (h *Hub) CloseAll() {
	h.mu.Lock()
	targets := make([]*Conn, 0, len(h.conns))
	for c := range h.conns {
		targets = append(targets, c)
	}
	h.mu.Unlock()
	for _, c := range targets {
		c.closeWith(websocket.StatusGoingAway, "agent 正在关闭")
	}
}
