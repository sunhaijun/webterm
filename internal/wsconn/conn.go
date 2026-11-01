// Package wsconn 是 WebSocket 连接层：把 session 的输出与事件搬到线上，
// 把线上的帧翻译成 session 的调用。
//
// 契约见 docs/30-protocol/websocket-protocol.md。它实现 session.Subscriber，
// 而 session 完全不知道 WebSocket 的存在。
package wsconn

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/session"
)

const (
	// writeQueueBytes 是每连接写队列上限（协议 §5.6）。
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

	mu       sync.Mutex
	subs     map[uint16]bool      // 已订阅的会话
	lastAck  map[uint16]time.Time // ack 节流
	pendAck  map[uint16]uint64
	lastHead map[uint16]time.Time // head_seq 节流
	pendHead map[uint16]uint64

	// 写队列：一个切片 + 一个唤醒信号。不用 channel —— 要能把一批帧原子地排进去
	// （一份快照的各帧），也要能让 welcome 插到 hello 处理期间入队的帧前面。
	q      []outFrame
	queued int // 写队列（含 held）已占字节数
	// holding：welcome 发出之前入队的一切都先挂在 held 里。
	//
	// hello.resume 的判定与补齐帧的入队必须是同一个动作（协议 §5.1，在会话锁内），
	// 而 welcome.resumed[] 又要报出那个判定 —— 所以帧先于 welcome 生成。挂起写队列、
	// welcome 生成之后插在最前面一起放行，客户端看到的就是 welcome 在先。
	// 连接一建立就挂起：observer 在 hello 之前就登记了，期间的广播也不能跑到 welcome 前面。
	holding   bool
	held      []outFrame
	wake      chan struct{} // cap 1
	closed    bool
	closeCode websocket.StatusCode
	closeMsg  string

	done chan struct{} // closeWith 置 closed 的那一次关闭它
	// flushed 在 writeLoop 退出（写队列刷完或写失败）时关闭。
	flushed chan struct{}
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
		holding:  true,
		wake:     make(chan struct{}, 1),
		done:     make(chan struct{}),
		flushed:  make(chan struct{}),
	}
}

// ClientID 实现 session.Subscriber。
func (c *Conn) ClientID() string { return c.clientID }

// Push 实现 session.Subscriber：把一段输出编成 OUTPUT 帧排进写队列。
//
// 【必须非阻塞】。队列满就关闭连接，客户端会自动重连走续传。
func (c *Conn) Push(sid uint16, seq uint64, data []byte) {
	frames := make([]outFrame, 0, 1)
	// 大段输出要切成不超过 MaxPayload 的帧
	for off := 0; off < len(data); {
		end := min(off+protocol.MaxPayload, len(data))
		f := protocol.Frame{Type: protocol.TypeOutput, SID: sid, Seq: seq + uint64(off), Payload: data[off:end]}
		frames = append(frames, outFrame{binary: true, data: protocol.EncodeFrame(f)})
		off = end
	}
	c.enqueue(frames...)
}

// Snapshot 实现 session.Subscriber：把一份快照编成 SNAPSHOT 帧排进写队列。
//
// 超过单帧上限就拆：同一个 seq，除最后一帧外都带 MORE（协议 §3）。各帧一次性
// 原子入队 —— 协议保证一份快照的各帧之间不夹杂同一 sid 的其它帧。
func (c *Conn) Snapshot(sid uint16, seq uint64, data []byte) {
	fs := protocol.SnapshotFrames(sid, seq, data)
	frames := make([]outFrame, 0, len(fs))
	for _, f := range fs {
		frames = append(frames, outFrame{binary: true, data: protocol.EncodeFrame(f)})
	}
	c.enqueue(frames...)
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
		if m.HeadSeq != nil && onlyHeadSeq(m) {
			// 只带 head_seq 的那种（未读用）：已订阅的会话不需要它 —— OUTPUT 帧
			// 本身就带着进度，未读也永远是 false；未订阅的做 1s 节流
			c.mu.Lock()
			subscribed := c.subs[m.SID]
			c.mu.Unlock()
			if subscribed || !c.allowHeadSeq(m.SID, *m.HeadSeq) {
				return
			}
		} else if m.HeadSeq != nil {
			// 带着别的字段（会话退出时的 status + head_seq）：必须原样发出去，
			// 不节流。顺手作废被节流挂起的旧值 —— 否则补发会在它后面送来一个更小的 head_seq
			c.mu.Lock()
			c.lastHead[m.SID] = time.Now()
			delete(c.pendHead, m.SID)
			c.mu.Unlock()
		}
	}
	c.send(msg)
}

// send 把控制消息编码后入队，不过节流。
func (c *Conn) send(msg any) {
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
		c.pendAck[sid] = inAck // 记下最新值，由 writeLoop 的 ticker 补发
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

// enqueue 把一批帧原子地排进写队列。队列满 → 关闭连接（绝不阻塞）。
func (c *Conn) enqueue(frames ...outFrame) {
	if len(frames) == 0 {
		return
	}
	n := 0
	for _, f := range frames {
		n += len(f.data)
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	if c.queued+n > c.deps.writeQueueBytes() {
		c.mu.Unlock()
		c.log.Warn("conn queue full，断开慢客户端", "client_id", c.clientID)
		c.closeWith(websocket.StatusTryAgainLater, "写队列已满")
		return
	}
	c.queued += n
	holding := c.holding
	if holding {
		c.held = append(c.held, frames...)
	} else {
		c.q = append(c.q, frames...)
	}
	c.mu.Unlock()
	if !holding {
		c.signal()
	}
}

// releaseWith 结束挂起：first 排在最前面，随后是挂起期间入队的全部帧。
// 不在挂起状态时等价于普通入队。
func (c *Conn) releaseWith(first []byte) {
	f := outFrame{data: first}
	c.mu.Lock()
	if !c.holding {
		c.mu.Unlock()
		c.enqueue(f)
		return
	}
	c.holding = false
	held := c.held
	c.held = nil
	if c.closed {
		c.queued = 0
		c.mu.Unlock()
		return
	}
	c.queued += len(first) // welcome 可能超过一个慢客户端剩下的额度，但它必须发
	c.q = append(c.q, f)
	c.q = append(c.q, held...)
	c.mu.Unlock()
	c.signal()
}

func (c *Conn) signal() {
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

// pop 取出写队列的队首。
func (c *Conn) pop() (outFrame, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.q) == 0 {
		return outFrame{}, false
	}
	f := c.q[0]
	c.q[0] = outFrame{}
	c.q = c.q[1:]
	c.queued -= len(f.data)
	return f, true
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
	close(c.done) // 只有把 closed 置真的这一次走到这里
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
//
// welcome 之前的错误（expected_hello、protocol_unsupported）没有 welcome 可等，
// 直接结束挂起、排在最前面。
func (c *Conn) sendError(reqID string, sid *uint16, code, message string, fatal bool) {
	b, err := protocol.Encode(&protocol.Error{ReqID: reqID, SID: sid, Code: code, Message: message})
	if err == nil {
		c.mu.Lock()
		holding := c.holding
		c.mu.Unlock()
		if holding {
			c.releaseWith(b)
		} else {
			c.enqueue(outFrame{data: b})
		}
	}
	if fatal {
		c.closeWith(websocket.StatusPolicyViolation, code)
	}
}

func (c *Conn) String() string { return fmt.Sprintf("conn(%s)", c.clientID) }

// onlyHeadSeq 报告这条 session.updated 是不是只带了 head_seq（+ sid）。
func onlyHeadSeq(m *protocol.SessionUpdated) bool {
	return m.Name == nil && m.NameIsManual == nil && m.CWD == nil && m.Status == nil &&
		m.ExitCode == nil && m.Cols == nil && m.Rows == nil
}
