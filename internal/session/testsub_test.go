package session_test

import (
	"bytes"
	"sync"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/session"
	"github.com/sunhaijun/webterm/internal/vterm"
)

// fakeConn 是一个测试用订阅者，模拟连接层 + 客户端：它按协议规则做 seq 记账，
// 把收到的帧拼成"客户端终端吃到的字节"。
//
// 它【严格校验】seq 连续性 —— 任何重复、空洞都会当场失败，而不是留到 E2E 才暴露。
// 收到快照就像真客户端那样：清屏（这里是清空字节）→ 写快照 → out_seq = seq。
type fakeConn struct {
	t        *testing.T
	clientID string

	// inSeqNext 是客户端侧的输入记账：下一个要分配的 in_seq。
	// 重连后必须按 welcome.resumed[].in_ack 裁剪它，见 TrimTo。
	inSeqNext uint64

	mu        sync.Mutex
	screen    bytes.Buffer // 客户端终端吃到的字节（自最近一次快照起）
	expected  uint64       // 下一帧应有的 seq
	haveSeq   bool
	events    []any
	frames    []frameRec // 按到达顺序的帧记录
	timeline  []any      // 帧（frameRec）与控制消息混在一起、按到达顺序 —— 同一条连接上的先后
	gaps      int
	dups      int
	snapshots int
	lastSnap  []byte
	detached  bool // 连接已断开：迟到的帧应当石沉大海
}

// frameRec 记一帧：快照还是输出、seq、长度。顺序断言用（IT-resize-2）。
type frameRec struct {
	snapshot bool
	seq      uint64
	n        int
}

// Detach 模拟连接断开。断开后到达的帧被丢弃 —— 真实的连接层此时
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

// newConn 建一个测试连接，并把它登记为 manager 的 observer。
//
// 订阅与观察是两件事：Subscribe 只决定收不收 OUTPUT / SNAPSHOT 帧，控制消息走
// observer 列表 —— 未订阅的连接也要收 session.updated（未读靠它推导）。
func newConn(t *testing.T, m *session.Manager, clientID string) *fakeConn {
	c := &fakeConn{t: t, clientID: clientID}
	m.AddObserver(c)
	t.Cleanup(func() { m.RemoveObserver(c) })
	return c
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

func (c *fakeConn) Push(sid uint16, seq uint64, data []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.detached {
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
	c.frames = append(c.frames, frameRec{seq: seq, n: len(data)})
	c.timeline = append(c.timeline, frameRec{seq: seq, n: len(data)})
	c.screen.Write(data)
	c.expected = seq + uint64(len(data))
	c.haveSeq = true
}

// SubscribeAt 模拟客户端带着自己手里的 out_seq 订阅。像真客户端一样，它的 out_seq
// 从报上去的那个值算起 —— 增量路径下没有要补的字节时，下一帧就该从这里接。
func (c *fakeConn) SubscribeAt(s *session.Session, outSeq uint64) (string, uint64) {
	c.mu.Lock()
	c.expected, c.haveSeq = outSeq, true
	c.mu.Unlock()
	return s.Subscribe(c, outSeq, 0, 0)
}

func (c *fakeConn) Snapshot(sid uint16, seq uint64, data []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.detached {
		return
	}
	if len(data) == 0 {
		c.t.Errorf("空快照（payload 为 0 的帧非法）")
	}
	// 客户端：terminal.reset() → 写快照 → out_seq = seq。快照字节不计入 seq。
	c.snapshots++
	c.lastSnap = append([]byte(nil), data...)
	c.frames = append(c.frames, frameRec{snapshot: true, seq: seq, n: len(data)})
	c.timeline = append(c.timeline, frameRec{snapshot: true, seq: seq, n: len(data)})
	c.screen.Reset()
	c.screen.Write(data)
	c.expected = seq
	c.haveSeq = true
}

func (c *fakeConn) Event(msg any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.events = append(c.events, msg)
	c.timeline = append(c.timeline, msg)
}

// Timeline 返回帧与控制消息按到达顺序混排的记录。
func (c *fakeConn) Timeline() []any {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]any(nil), c.timeline...)
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

// Snapshots 返回收到过几份快照。
func (c *fakeConn) Snapshots() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.snapshots
}

// LastSnapshot 返回最近一份快照的字节。
func (c *fakeConn) LastSnapshot() []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lastSnap
}

// Frames 返回按到达顺序的帧记录。
func (c *fakeConn) Frames() []frameRec {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]frameRec(nil), c.frames...)
}

// Events 返回收到过的控制消息。
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

// waitQuiet 等会话的输出停止推进。
//
// 做字节级比较时不能只等某个标记出现就收工 —— 标记之后还有内容（比如
// 下一个 prompt），两轮跑到哪一刻收手是随机的，比出来的差异是采样点不同
// 而不是续传出错。等静默能给两轮一个确定的截止点。
func waitQuiet(t *testing.T, s *session.Session, quiet time.Duration) {
	t.Helper()
	last := s.HeadSeq()
	stableSince := time.Now()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
		if h := s.HeadSeq(); h != last {
			last, stableSince = h, time.Now()
			continue
		}
		if time.Since(stableSince) >= quiet {
			return
		}
	}
	t.Fatal("超时等待：输出静默")
}

// waitScreen 等屏幕内容包含 sub。
func waitScreen(t *testing.T, c *fakeConn, sub string) {
	t.Helper()
	waitFor(t, "屏幕出现 "+sub, func() bool { return bytes.Contains([]byte(c.Screen()), []byte(sub)) })
}

func newManager(t *testing.T, cfg session.Config) *session.Manager {
	t.Helper()
	m := session.NewManager(cfg)
	t.Cleanup(m.Shutdown)
	return m
}

// render 把客户端吃到的字节交给一个模拟器，返回它的当前屏文字 —— 断言"屏幕上
// 有什么"时用它，而不是在快照字节里找子串（快照是渲染指令，文字之间可能夹着
// 样式序列）。
func render(c *fakeConn, cols, rows int) string {
	t := vterm.New(cols, rows)
	t.Write([]byte(c.Screen()))
	return t.String()
}
