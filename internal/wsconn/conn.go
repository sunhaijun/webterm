// Package wsconn 是 WebSocket 连接层：把 session 的输出与事件搬到线上，
// 把线上的帧翻译成 session 的调用。
//
// 契约见 docs/30-protocol/websocket-protocol.md。它实现 session.Subscriber，
// 而 session 完全不知道 WebSocket 的存在。
package wsconn

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/session"
)

const (
	// writeQueueBytes 是每连接写队列上限（协议 §5.5）。
	// 满了就关闭该连接 —— 阻塞写会反压到 PTY.Read()，一个慢客户端不能
	// 拖慢服务器上真正在跑的活。
	writeQueueBytes = 4 << 20
	// idleTimeout：60 秒没收到任何帧就关连接（AC-2.8）。
	idleTimeout = 60 * time.Second
	// ackThrottle：同一会话的 ack 最多每 50ms 一条（累计量，丢中间值无害）。
	ackThrottle = 50 * time.Millisecond
	// headSeqThrottle：未订阅会话的 head_seq 通知最多每秒一条。
	headSeqThrottle = time.Second
	// writeTimeout 是单次写的上限，防止一个卡住的 socket 占住写 goroutine。
	writeTimeout = 30 * time.Second
)

// Deps 是连接层需要的外部依赖。
type Deps struct {
	Sessions      *session.Manager
	Hub           *Hub
	ServerVersion string
	Logger        *slog.Logger
	// Revoked 报告本连接对应的设备是否已被吊销。每 2 秒轮询一次（AC-1.11）。
	Revoked func() bool
	// IdleTimeout 覆盖默认的 60 秒判死间隔。0 表示用默认值。
	// 存在只是为了让 IT-hb-1 不必真的等 60 秒。
	IdleTimeout time.Duration
	// WriteQueueBytes 覆盖默认的 4 MiB 写队列上限。0 表示用默认值。
	WriteQueueBytes int
}

func (d Deps) idleTimeout() time.Duration {
	if d.IdleTimeout > 0 {
		return d.IdleTimeout
	}
	return idleTimeout
}

func (d Deps) writeQueueBytes() int {
	if d.WriteQueueBytes > 0 {
		return d.WriteQueueBytes
	}
	return writeQueueBytes
}

type outFrame struct {
	binary bool
	data   []byte
}

// Conn 是一条 WebSocket 连接。
type Conn struct {
	ws   *websocket.Conn
	deps Deps
	log  *slog.Logger

	clientID string

	mu        sync.Mutex
	subs      map[uint16]bool      // 已订阅的会话
	lastAck   map[uint16]time.Time // ack 节流
	pendAck   map[uint16]uint64
	lastHead  map[uint16]time.Time // head_seq 节流
	pendHead  map[uint16]uint64
	queued    int // 写队列已占字节数
	closed    bool
	closeCode websocket.StatusCode
	closeMsg  string

	out      chan outFrame
	done     chan struct{}
	doneOnce sync.Once
	// flushed 在写队列刷干净之后关闭。
	flushed     chan struct{}
	flushedOnce sync.Once
	// cancel 取消 Serve 的 context，用来把阻塞在 ws.Read 上的 readLoop 叫醒
	// （否则连接要等到 60 秒判死才真的断，AC-1.11 会挂）。
	//
	// 但它【必须等写队列刷完再调】：coder/websocket 在读 context 被取消时
	// 会直接销毁底层连接，抢在刷完之前调等于把那条"为什么断"的 error 一起
	// 扔掉 —— 用户又只剩一个莫名的重连失败。
	cancel context.CancelFunc
}

// New 包一条已升级的 WebSocket。
func New(ws *websocket.Conn, deps Deps) *Conn {
	log := deps.Logger
	if log == nil {
		log = slog.Default()
	}
	return &Conn{
		ws:       ws,
		deps:     deps,
		log:      log,
		subs:     make(map[uint16]bool),
		lastAck:  make(map[uint16]time.Time),
		pendAck:  make(map[uint16]uint64),
		lastHead: make(map[uint16]time.Time),
		pendHead: make(map[uint16]uint64),
		out:      make(chan outFrame, 256),
		done:     make(chan struct{}),
		flushed:  make(chan struct{}),
	}
}

// ClientID 实现 session.Subscriber。
func (c *Conn) ClientID() string { return c.clientID }

// Push 实现 session.Subscriber：把一段输出编成 OUTPUT 帧排进写队列。
//
// 【必须非阻塞】。队列满就关闭连接，客户端会自动重连走续传。
func (c *Conn) Push(sid uint16, seq uint64, data []byte, attrPrefix bool) {
	payload := data
	flags := uint8(0)
	if attrPrefix {
		// 前置的 4 个字节是渲染修正，不计入 seq —— 用 flags bit0 标出来，
		// 让客户端把它从 seq 记账里排除（协议 §3）。
		flags = protocol.FlagAttrPrefix
		payload = make([]byte, 0, len(protocol.AttrPrefix)+len(data))
		payload = append(payload, protocol.AttrPrefix...)
		payload = append(payload, data...)
	}
	// 大段输出要切成不超过 MaxPayload 的帧
	for off := 0; off < len(payload); {
		end := min(off+protocol.MaxPayload, len(payload))
		chunk := payload[off:end]
		f := protocol.Frame{Type: protocol.TypeOutput, Flags: flags, SID: sid, Seq: seq, Payload: chunk}
		if off > 0 {
			f.Flags = 0 // 属性前缀只在第一帧上
		}
		c.enqueue(outFrame{binary: true, data: protocol.EncodeFrame(f)})
		seq += uint64(f.DataLen())
		off = end
		flags = 0
	}
}

// Event 实现 session.Subscriber：把控制消息排进写队列。
func (c *Conn) Event(msg any) {
	// ack 与 head_seq 做节流，其余原样发
	switch m := msg.(type) {
	case *protocol.Ack:
		if !c.allowAck(m.SID, m.InAck) {
			return
		}
	case *protocol.SessionUpdated:
		if m.HeadSeq != nil {
			// 已订阅的会话不需要它 —— OUTPUT 帧本身就带着进度，
			// 未读也永远是 false
			c.mu.Lock()
			subscribed := c.subs[m.SID]
			c.mu.Unlock()
			if subscribed || !c.allowHeadSeq(m.SID, *m.HeadSeq) {
				return
			}
		}
	}
	b, err := protocol.Encode(msg)
	if err != nil {
		c.log.Error("编码控制消息失败", "err", err)
		return
	}
	c.enqueue(outFrame{data: b})
}

func (c *Conn) allowAck(sid uint16, inAck uint64) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	if now.Sub(c.lastAck[sid]) < ackThrottle {
		c.pendAck[sid] = inAck // 记下最新值，由 flushLoop 补发
		return false
	}
	c.lastAck[sid] = now
	delete(c.pendAck, sid)
	return true
}

func (c *Conn) allowHeadSeq(sid uint16, head uint64) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	if now.Sub(c.lastHead[sid]) < headSeqThrottle {
		c.pendHead[sid] = head // 记下最新值，由 writeLoop 的 ticker 补发
		return false
	}
	c.lastHead[sid] = now
	delete(c.pendHead, sid)
	return true
}

// enqueue 把一帧排进写队列。队列满 → 关闭连接（绝不阻塞）。
func (c *Conn) enqueue(f outFrame) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	if c.queued+len(f.data) > c.deps.writeQueueBytes() {
		c.mu.Unlock()
		c.log.Warn("conn queue full，断开慢客户端", "client_id", c.clientID)
		c.closeWith(websocket.StatusTryAgainLater, "写队列已满")
		return
	}
	c.queued += len(f.data)
	c.mu.Unlock()

	select {
	case c.out <- f:
	case <-c.done:
	default:
		// channel 也满了（写 goroutine 卡住）→ 同样断开，不阻塞
		c.mu.Lock()
		c.queued -= len(f.data)
		c.mu.Unlock()
		c.closeWith(websocket.StatusTryAgainLater, "写队列已满")
	}
}

// closeWith 请求关闭连接。幂等，第一次调用的原因胜出。
func (c *Conn) closeWith(code websocket.StatusCode, msg string) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	c.closeCode, c.closeMsg = code, msg
	cancel := c.cancel
	c.mu.Unlock()
	c.doneOnce.Do(func() { close(c.done) })
	if cancel == nil {
		return
	}
	// 先让 writeLoop 把队列刷完，再叫醒 readLoop
	go func() {
		select {
		case <-c.flushed:
		case <-time.After(3 * time.Second):
		}
		cancel()
	}()
}

// sendError 发一条 error 控制消息；fatal 为 true 时随后关闭连接。
//
// 致命错误【必须先入队再关】，而且 Serve 要等写 goroutine 把队列刷完才
// 真正关闭 socket —— 否则客户端只会看到一个裸的 close。"给出可读的错误
// 消息而不是一个裸的握手失败"正是不在握手阶段做版本协商的理由（协议 §1）。
func (c *Conn) sendError(reqID string, sid *uint16, code, message string, fatal bool) {
	c.Event(&protocol.Error{ReqID: reqID, SID: sid, Code: code, Message: message})
	if fatal {
		c.closeWith(websocket.StatusPolicyViolation, code)
	}
}

func encodeJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

var errConnClosed = errors.New("wsconn: 连接已关闭")

func (c *Conn) String() string { return fmt.Sprintf("conn(%s)", c.clientID) }

var _ = context.Background
