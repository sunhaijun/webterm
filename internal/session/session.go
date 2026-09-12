package session

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/sunhaijun/webterm/internal/handoff"
	"github.com/sunhaijun/webterm/internal/oscparse"
	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/ringbuf"
	"github.com/sunhaijun/webterm/internal/store"
)

const (
	// ptyReadBuf 是 PTY 读缓冲大小。
	ptyReadBuf = 32 << 10
	// integrationHelloTimeout 是集成握手的等待时间（AC-7.6）。
	integrationHelloTimeout = 10 * time.Second
	// integrationIdleTimeout：距上一个 OSC 133 标记超过这么久就判定集成失效。
	// 刻意宽松 —— 误判的代价必须低，它只影响降级提示与自动切换。
	integrationIdleTimeout = 5 * time.Minute
	// killGrace 是 SIGHUP 到 SIGKILL 之间的宽限。
	killGrace = 2 * time.Second

	// probeGrace：一次 Enter 之后等这么久还没有任何 133 标记，就算一次
	// "未标记往返"。有钩子的 shell 里 133;C 在几十毫秒内就到，2 秒非常宽松。
	probeGrace = 2 * time.Second
	// probeMisses：连续几次未标记往返才下结论 —— 单次可能是巧合。
	probeMisses = 2
)

var (
	ErrInputGap       = errors.New("session: 输入序列号出现空洞")
	ErrSessionExited  = errors.New("session: 会话已退出")
	ErrUnknownSession = errors.New("session: 会话不存在")
)

// Session 是一个 PTY + 它上面跑的 shell + 它的输出环形缓冲。
//
// 会话不跨 agent【重启】存活（ADR-0003），但跨【热升级】存活（ADR-0016）：
// 原地 exec 时 ptmx fd 与 shell 进程原样交给新进程，状态走 export / restore。
// 新增字段时先问一句"要不要进快照"（handoff.Session 是那张清单）。
type Session struct {
	mgr *Manager
	sid uint16
	// ptmx 是【可轮询】的 master：dup 出来、置 O_NONBLOCK、os.NewFile 包起来。
	// 只有可轮询的文件 SetReadDeadline 才管用，热升级冻结靠它打断阻塞读。
	// 【不要对它调 Fd()】—— 那会把它切回阻塞模式（见 winsize.go）。fd 单独记着。
	ptmx      *os.File
	fd        int
	proc      *os.Process // shell；交接过来的会话用 os.FindProcess 接回
	rcPath    string      // 临时 rcfile，销毁时删除
	createdAt time.Time
	store     *store.Store
	// mgrHistory 报告此刻是否记录命令历史。取成函数是因为用户可以在会话
	// 运行期间从 UI 上关掉它（做敏感工作时一键静默）。
	mgrHistory func() bool

	mu          sync.RWMutex // 保护以下所有字段
	name        string
	nameManual  bool
	cwd         string
	status      string
	exitCode    *int
	cols, rows  uint16
	integration string
	promptState string    // 最近一次 prompt 状态，重连时回给客户端
	lastMark    time.Time // 上一个 OSC 133 标记的时间
	lastInput   time.Time // 上一次收到用户输入的时间，判定集成是否真的失效要用
	helloSeen   bool      // 收到过 1701;hello —— 脚本已开始加载（不等于钩子已装好）

	// ---- 按命令的活性探测（协议 §4.7）----
	//
	// 一次 Enter 之后有没有等到【任何】133 标记。有钩子的 shell 里，非空
	// 命令几十毫秒内发 133;C，空 Enter 重画 prompt 发 133;A/B ——
	// 所以【有输出却零标记】才说明这次输入去了一个没有钩子的 shell。
	// "多久没标记"不是存活信号（见 checkIntegrationIdle 的注释）。
	probeArmed    bool
	probeGen      int           // 每次装探针 +1；到期定时器只认自己那一代
	probeAt       time.Time     // 那次 Enter 的时间
	probeOutput   bool          // 那次 Enter 之后有过输出
	probeState    string        // Enter 时的 promptState —— 决定结论归谁
	unmarkedRuns  int           // 连续未标记往返计数
	unmarkedInput bool          // 对外报告：输入正去往一个没有集成的子程序
	sink          func(msg any) // 测试观察钩子，生产为 nil
	ring          *ringbuf.Buffer
	subs          map[Subscriber]struct{}
	// inAck/inQueued 按 client_id 记账，【跨重连存活】（协议 §5.3）。
	// inQueued 是已接受入队的字节数（用于校验 seq 连续性），
	// inAck 是已真正写进 PTY 的字节数（用于 ack 与重连后的重发起点）。
	inQueued map[string]uint64
	inAck    map[string]uint64

	// 以下只在 readLoop 里访问，不需要锁
	osc      *oscparse.Parser
	pendCmd  string
	curCmdID *int64
	curCmdAt time.Time

	inputQ    *inputQueue
	done      chan struct{}
	closeOnce sync.Once

	// 热升级冻结（ADR-0016）：见 freeze.go
	fz         freezer
	readAlive  atomic.Bool
	writeAlive atomic.Bool
}

// SID 返回会话 id。
func (s *Session) SID() uint16 { return s.sid }

// Snapshot 返回会话的完整快照（welcome.sessions[] / session.created）。
func (s *Session) Snapshot() protocol.SessionInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.snapshotLocked()
}

func (s *Session) snapshotLocked() protocol.SessionInfo {
	return protocol.SessionInfo{
		SID:           s.sid,
		Name:          s.displayNameLocked(),
		NameIsManual:  s.nameManual,
		CWD:           s.cwd,
		Status:        s.status,
		ExitCode:      s.exitCode,
		Cols:          s.cols,
		Rows:          s.rows,
		Integration:   s.integration,
		UnmarkedInput: s.unmarkedInput,
		PromptState:   optStr(s.promptState),
		BaseSeq:       s.ring.BaseSeq(),
		HeadSeq:       s.ring.HeadSeq(),
		CreatedAt:     s.createdAt.UnixMilli(),
	}
}

// displayNameLocked 实现自动命名（AC-4.4）。
// 不做重名去重 —— 两个都在 webterm 目录下的会话本来就该同名。
func (s *Session) displayNameLocked() string {
	if s.nameManual {
		return s.name
	}
	if s.cwd == "" {
		return "shell"
	}
	if home, err := os.UserHomeDir(); err == nil && s.cwd == home {
		return "~"
	}
	if b := filepath.Base(s.cwd); b != "" && b != "/" && b != "." {
		return b
	}
	return "/"
}

// Status 返回会话状态。
func (s *Session) Status() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.status
}

// HeadSeq 返回该会话累计产出的字节数（剥离 OSC 之后）。
func (s *Session) HeadSeq() uint64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.ring.HeadSeq()
}

// InAck 返回某个 client 在本会话上已写入 PTY 的累计字节数。
func (s *Session) InAck(clientID string) uint64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.inAck[clientID]
}

// Rename 设置手动名。传 nil 恢复跟随 CWD 自动改名。
func (s *Session) Rename(name *string) {
	s.mu.Lock()
	if name == nil || *name == "" {
		s.nameManual = false
		s.name = ""
	} else {
		s.nameManual = true
		s.name = *name
	}
	msg := &protocol.SessionUpdated{
		SID:          s.sid,
		Name:         strPtr(s.displayNameLocked()),
		NameIsManual: boolPtr(s.nameManual),
	}
	s.mu.Unlock()
	s.emit(msg)
}

// Resize 调整 PTY 窗口大小。
func (s *Session) Resize(cols, rows uint16) error {
	if cols == 0 || rows == 0 || cols > 1000 || rows > 1000 {
		return errors.New("session: cols/rows 必须在 1..1000")
	}
	s.mu.Lock()
	s.cols, s.rows = cols, rows
	s.mu.Unlock()
	if s.Status() != protocol.StatusRunning {
		return nil // 已退出：只记尺寸，PTY 可能已经没了
	}
	return setWinsize(s.ptmx, cols, rows)
}

// ---------- 订阅 ----------

// Subscribe 把 sub 加入订阅者集合，并补齐它从 fromSeq 起缺的输出。
//
// 【取切片与加入集合必须在同一把锁下完成】—— 分开做的话，中间到达的一批
// 输出要么被回放和推送各发一遍（重复），要么两边都漏（空洞），而协议 §3
// 规定客户端遇到空洞直接关连接。
//
// 补齐的那一次 Push 也在锁内完成，保证它排在后续实时 Push 之前。
// Push 按契约是非阻塞的，所以这里不会卡住 PTY 读取。
func (s *Session) Subscribe(sub Subscriber, fromSeq uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, attrPrefix, _ := s.ring.Replay(fromSeq)
	s.subs[sub] = struct{}{}
	if len(data) == 0 {
		return
	}
	seq := fromSeq
	if attrPrefix {
		// reset 回放：起点是缓冲现存内容的开头，不是客户端要的位置
		seq = s.ring.BaseSeq()
	}
	sub.Push(s.sid, seq, data, attrPrefix)
}

// Unsubscribe 把 sub 从订阅者集合里摘掉。会话在 agent 侧照常运行和缓冲。
func (s *Session) Unsubscribe(sub Subscriber) {
	s.mu.Lock()
	delete(s.subs, sub)
	s.mu.Unlock()
}

// DetachClient 在连接断开时调用：丢弃该 client 已入队但尚未写入 PTY 的输入。
//
// 这些字节从未被 ack，客户端仍持在 pending 里，重连后会按 in_ack 重发。
// 不丢的话它们会被写进 PTY 一次、重发时再写一次。
func (s *Session) DetachClient(clientID string) {
	dropped := s.inputQ.dropClient(clientID)
	if dropped == 0 {
		return
	}
	s.mu.Lock()
	s.inQueued[clientID] = s.inAck[clientID]
	s.mu.Unlock()
}

func (s *Session) subsLocked() []Subscriber {
	out := make([]Subscriber, 0, len(s.subs))
	for sub := range s.subs {
		out = append(out, sub)
	}
	return out
}

// ---------- 输入 ----------

// Write 接受一个 INPUT 帧的负载。
//
// seq 校验（协议 §3，in_ack 属于 (client_id, sid)）：
//
//	seq == 已接受字节数 → 正常
//	seq <  已接受字节数 → 重发的已处理数据，丢弃前面重复的部分（重连时的正常情况）
//	seq >  已接受字节数 → 空洞 → ErrInputGap，调用方关连接
func (s *Session) Write(clientID string, seq uint64, data []byte) error {
	s.mu.Lock()
	if s.status == protocol.StatusExited {
		s.mu.Unlock()
		return ErrSessionExited
	}
	queued := s.inQueued[clientID]
	switch {
	case seq > queued:
		s.mu.Unlock()
		return ErrInputGap
	case seq < queued:
		skip := queued - seq
		if skip >= uint64(len(data)) {
			s.mu.Unlock() // 整段都是已处理过的重发
			return nil
		}
		data = data[skip:]
	}
	s.inQueued[clientID] = queued + uint64(len(data))
	now := time.Now()
	s.lastInput = now
	s.armProbeLocked(data, now)
	s.mu.Unlock()

	cp := make([]byte, len(data))
	copy(cp, data)
	if err := s.inputQ.push(clientID, cp); err != nil {
		// 入队失败：回滚记账，让重连后的重发能对上
		s.mu.Lock()
		s.inQueued[clientID] = queued
		s.mu.Unlock()
		return err
	}
	return nil
}

// ---------- 三个 goroutine ----------

// readLoop：PTY.Read() → OSC 剥离 → 环形缓冲 → 广播给订阅者。
//
// 关键顺序（ADR-0006）：Feed 剥离 → Append 计数。out_seq 永远等于剥离后
// 字节的累计数 —— 先计数再剥离的话，续传时按 out_seq 切片就会错位。
// consume 处理一次 PTY 读到的字节：剥离 OSC、进环形缓冲、推给订阅者、
// 再按【精确位置】处理事件。单独抽出来是为了不起 PTY 也能测盖戳逻辑。
func (s *Session) consume(chunk []byte) {
	clean, events := s.osc.Feed(chunk)
	// 事件在本块干净输出里的偏移，与 events 一一对应（见 oscparse.Offsets）
	offs := s.osc.Offsets()

	var data []byte
	var seq uint64
	var subs []Subscriber
	s.mu.Lock()
	// Append 返回本块【首字节】的 seq（空块是 no-op，返回当前 head）。
	// 事件的精确位置 = seq + 偏移 —— 不能用 append 之后的 head，
	// 否则同一块里的 133;C 与 133;D 会拿到同一个值，块区间为空。
	seq = s.ring.Append(clean)
	if len(clean) > 0 {
		if s.probeArmed {
			s.probeOutput = true
		}
		// 必须拷贝：clean 可能指向 Feed 复用的缓冲或 buf 本身，
		// 而订阅者的写队列会持有它到下一次 Read 之后。
		data = make([]byte, len(clean))
		copy(data, clean)
	}
	subs = s.subsLocked()
	s.mu.Unlock()

	// 【先发事件，再推帧】（协议 §4 command.start/end 的顺序承诺）。
	// 事件与帧走同一条按序写队列（wsconn.Conn.enqueue），所以这里的先后就是
	// 客户端收到的先后。client 靠它在写入 xterm 时把帧在 out_seq 处切开、
	// 登记行锚点 ——「在终端里看」才能定位到块（ADR-0011 ④）。反过来的话，
	// 帧先到，锚点就只能是事后估的。
	for i, ev := range events {
		s.handleOSCEvent(ev, seq+uint64(offs[i]))
	}
	for _, sub := range subs {
		if data != nil {
			sub.Push(s.sid, seq, data, false)
		}
	}
	if data != nil {
		// 未订阅的连接靠 head_seq 推导未读（连接层做 1s 节流）
		head := seq + uint64(len(data))
		s.emit(&protocol.SessionUpdated{SID: s.sid, HeadSeq: &head})
	}
}

func (s *Session) readLoop() {
	defer func() {
		s.fz.exiting()
		s.readAlive.Store(false)
	}()
	buf := make([]byte, ptyReadBuf)
	for {
		n, err := s.ptmx.Read(buf)
		if n > 0 {
			s.consume(buf[:n])
		}
		if err != nil {
			if errors.Is(err, os.ErrDeadlineExceeded) {
				// 热升级冻结：deadline 只有 freeze 会设。停在这里 —— consume 已做完，
				// ring 与 out_seq 一致 —— 等解冻再回去读
				s.fz.park()
				continue
			}
			return // EIO = shell 退出
		}
	}
}

// writeLoop：从输入队列取数据 → PTY.Write() → 更新 in_ack。
func (s *Session) writeLoop() {
	defer func() {
		s.fz.exiting()
		s.writeAlive.Store(false)
	}()
	for {
		// 冻结点在 pop 之前：队里的东西原样进快照，inAck 与已写字节一致
		s.fz.park()
		it, ok := s.inputQ.pop()
		if !ok {
			select {
			case <-s.inputQ.notify:
				continue
			case <-s.fz.wake:
				continue // 去 park
			case <-s.done:
				return
			}
		}
		n, err := s.ptmx.Write(it.data)
		if n > 0 {
			s.mu.Lock()
			s.inAck[it.clientID] += uint64(n)
			ack := s.inAck[it.clientID]
			s.mu.Unlock()
			// ack 只发给同一个 client —— 记账是 per-client 的
			s.emitTo(it.clientID, &protocol.Ack{SID: s.sid, InAck: ack})
		}
		if err != nil {
			if errors.Is(err, os.ErrDeadlineExceeded) {
				// 冻结时写被打断（前台程序不读 stdin、PTY 输入缓冲满）：
				// 没写完的部分放回队首，随快照走，别丢也别重
				if n < len(it.data) {
					s.inputQ.pushFront(inputItem{clientID: it.clientID, data: it.data[n:]})
				}
				continue
			}
			return
		}
	}
}

// waitLoop：等 shell 退出，设置 exited 状态与退出码。
func (s *Session) waitLoop() {
	// 用 *os.Process 而不是 exec.Cmd.Wait：交接过来的会话只有 pid（os.FindProcess），
	// 同 PID exec 之后它们仍是子进程，Wait 照常拿退出码。
	st, err := s.proc.Wait()
	code := -1
	if err == nil && st != nil {
		code = st.ExitCode() // 被信号杀掉时是 -1，与原来 exec.ExitError 的语义一致
	}

	s.mu.Lock()
	s.status = protocol.StatusExited
	s.exitCode = &code
	s.mu.Unlock()

	s.inputQ.close() // 停止接受输入
	close(s.done)

	s.emit(&protocol.SessionUpdated{
		SID:      s.sid,
		Status:   strPtr(protocol.StatusExited),
		ExitCode: &code,
	})
	// ring 保留，不释放：构建失败了要能回看报错（AC-4.5）。
	if s.rcPath != "" {
		os.Remove(s.rcPath)
	}
}

// ---------- OSC 事件处理 ----------

// at 是该标记在输出流里的精确 out_seq（块首 seq + 事件偏移）。
func (s *Session) handleOSCEvent(ev oscparse.Event, at uint64) {
	switch e := ev.(type) {
	case oscparse.PromptEvent:
		s.markIntegrationAlive()
		s.mu.Lock()
		s.promptState = e.State
		s.mu.Unlock()
		if e.State == protocol.PromptRunning {
			s.beginCommand(at)
		}
		s.emit(&protocol.Prompt{SID: s.sid, State: e.State})

	case oscparse.CommandEndEvent:
		s.endCommand(e.ExitCode, at)

	case oscparse.CommandTextEvent:
		// 连续两个 1701;cmd 中间没有 133;C → 后者覆盖前者
		s.pendCmd = e.Text

	case oscparse.CWDEvent:
		s.setCWD(e.Path)

	case oscparse.IntegrationHelloEvent:
		// 【hello 不再直接置 active】。它现在发在 rcfile 最前面、用户 dotfile
		// 之前，意思只是"脚本开始加载"——这样一个慢的 .bash_profile 不会让
		// 握手超时误判。钩子真的装好了，由之后第一个 133 标记来证明。
		s.mu.Lock()
		s.helloSeen = true
		s.mu.Unlock()
	}
}

// markIntegrationAlive 记下"刚见到一个 133 标记"。
// 从 inactive 收到标记要立即转回 active。
func (s *Session) markIntegrationAlive() {
	s.mu.Lock()
	s.lastMark = time.Now()
	changed := s.integration != protocol.IntegrationActive
	s.integration = protocol.IntegrationActive
	unmarkedChanged := s.probeMarkSeenLocked()
	s.mu.Unlock()
	if unmarkedChanged {
		s.emitUnmarked()
	}
	if changed {
		s.emit(&protocol.SessionUpdated{
			SID: s.sid, Integration: strPtr(protocol.IntegrationActive),
		})
	}
}

func (s *Session) setIntegration(v string) {
	s.mu.Lock()
	if s.integration == v {
		s.mu.Unlock()
		return
	}
	s.integration = v
	if v == protocol.IntegrationActive {
		s.lastMark = time.Now()
	}
	s.mu.Unlock()
	s.emit(&protocol.SessionUpdated{SID: s.sid, Integration: strPtr(v)})
}

func (s *Session) setCWD(path string) {
	s.mu.Lock()
	if s.cwd == path {
		s.mu.Unlock()
		return // 仅在路径实际变化时发送
	}
	oldName := s.displayNameLocked()
	s.cwd = path
	newName := s.displayNameLocked()
	upd := &protocol.SessionUpdated{SID: s.sid, CWD: strPtr(path)}
	if newName != oldName {
		upd.Name = strPtr(newName)
	}
	s.mu.Unlock()
	s.emit(&protocol.CWD{SID: s.sid, Path: path})
	s.emit(upd)
}

// beginCommand 在 133;C 时结算命令开始。
//
// 没有前置的 1701;cmd（空回车，或以空格开头被跳过）时不记录命令，
// 但 prompt 状态照常上报。
func (s *Session) beginCommand(at uint64) {
	if s.pendCmd == "" {
		return
	}
	text := s.pendCmd
	s.pendCmd = ""

	s.mu.RLock()
	cwd, name := s.cwd, s.displayNameLocked()
	s.mu.RUnlock()

	now := time.Now()
	s.curCmdAt = now
	var cmdID int64
	if s.historyOn() && s.store != nil {
		id, err := s.store.BeginCommand(text, name, cwd, now)
		if err != nil {
			return
		}
		cmdID = id
		s.curCmdID = &id
	}
	s.emit(&protocol.CommandStart{
		SID: s.sid, CmdID: cmdID, Text: text, CWD: cwd,
		At: now.UnixMilli(), OutSeq: at,
	})
}

// endCommand 在 133;D 时补齐退出码与耗时。
// 没有进行中的命令（133;D 没有前置的 133;C）时只发 prompt 状态，不结算。
func (s *Session) endCommand(exitCode *int, at uint64) {
	if s.curCmdID == nil {
		return
	}
	id := *s.curCmdID
	s.curCmdID = nil
	dur := time.Since(s.curCmdAt)

	if s.historyOn() && s.store != nil {
		if err := s.store.FinishCommand(id, exitCode, dur); err != nil {
			return
		}
	}
	s.emit(&protocol.CommandEnd{
		SID: s.sid, CmdID: id, ExitCode: exitCode,
		DurationMS: dur.Milliseconds(), OutSeq: at,
	})
}

// emit 把一条控制消息发给【所有连接】，不只是订阅者。
//
// 未订阅的连接也要收 session.updated / cwd / command.* —— 侧栏里的会话名、
// 未读标记都靠它们。订阅只决定收不收 OUTPUT 字节。
func (s *Session) emit(msg any) {
	if s.sink != nil {
		s.sink(msg) // 仅测试用：不经过 manager 也能观察到发出的消息
	}
	if s.mgr != nil {
		s.mgr.fanout(msg)
	}
}

// emitTo 只发给某个 client 的连接。
func (s *Session) emitTo(clientID string, msg any) {
	if s.mgr != nil {
		s.mgr.fanoutTo(clientID, msg)
	}
}

// onHelloTimeout 在握手期结束时由 manager 调用。
//
// 只有【连 hello 都没收到】才判 inactive —— 那说明 rcfile 根本没被加载
// （比如 bash 太老、被别的东西接管）。收到了 hello 但还没有标记，多半是
// 用户 dotfile 慢，等它就是。
func (s *Session) onHelloTimeout() {
	s.mu.Lock()
	stale := s.integration == protocol.IntegrationPending && !s.helloSeen
	s.mu.Unlock()
	if stale {
		s.setIntegration(protocol.IntegrationInactive)
	}
}

// armProbeLocked 在输入里含 Enter 时装一个探针（须持锁）。
//
// 已有探针在等就不重复装 —— 一次结论要连续几次 Enter 各自到期才成立，
// 快速连按不能被合并成一次。到期靠定时器，不靠下一次输入或巡检，
// 否则结论会拖到用户下次敲键才出来。
func (s *Session) armProbeLocked(data []byte, now time.Time) {
	if !bytes.ContainsAny(data, "\r\n") || s.probeArmed {
		return
	}
	s.probeArmed = true
	s.probeGen++
	s.probeAt = now
	s.probeOutput = false
	s.probeState = s.promptState
	gen := s.probeGen
	time.AfterFunc(probeGrace, func() { s.resolveProbe(gen) })
}

// resolveProbe 在探针到期时结算：有输出却没有任何标记 → 记一次未标记往返。
func (s *Session) resolveProbe(gen int) {
	s.mu.Lock()
	if !s.probeArmed || s.probeGen != gen {
		s.mu.Unlock()
		return // 标记到了（已清零）或已经是下一代探针
	}
	s.probeArmed = false
	if !s.probeOutput {
		s.mu.Unlock()
		return // 没输出就不算：命令可能只是安静（sleep）
	}
	s.unmarkedRuns++
	setInactive, unmarkedChanged := false, false
	if s.unmarkedRuns >= probeMisses {
		if s.probeState == protocol.PromptRunning {
			// 在跑的命令里 Enter 有回应却无标记 —— 输入去了一个没有钩子的
			// 子程序（ssh / su / 容器 / REPL）。外层 shell 本身没坏，
			// 所以【不动 integration】，只报告这个事实。
			if !s.unmarkedInput {
				s.unmarkedInput = true
				unmarkedChanged = true
			}
		} else if s.integration == protocol.IntegrationActive {
			// 停在 prompt 前 Enter，有输出却零标记：这个 shell 自己的钩子没了
			// （trap - DEBUG / PROMPT_COMMAND= / exec bash 之类）。
			setInactive = true
		}
	}
	s.mu.Unlock()
	if setInactive {
		s.setIntegration(protocol.IntegrationInactive)
	}
	if unmarkedChanged {
		s.emitUnmarked()
	}
}

// probeMarkSeenLocked：任何 133 标记到达 → 探针与计数清零（须持锁）。
// 返回 unmarkedInput 是否因此变化。
func (s *Session) probeMarkSeenLocked() bool {
	s.probeArmed = false
	s.unmarkedRuns = 0
	if s.unmarkedInput {
		s.unmarkedInput = false
		return true
	}
	return false
}

func (s *Session) emitUnmarked() {
	s.mu.Lock()
	v := s.unmarkedInput
	s.mu.Unlock()
	s.emit(&protocol.SessionUpdated{SID: s.sid, UnmarkedInput: &v})
}

// checkIntegrationIdle 由 manager 的巡检 goroutine 周期性调用。
func (s *Session) checkIntegrationIdle(now time.Time) {
	s.mu.Lock()
	// 【"多久没标记"不是存活信号】。OSC 133 只在 prompt 前后发，
	// 所以没有标记只说明"什么都没发生"，不说明集成坏了。
	// 原来只看时间差，于是两种完全正常的情况会被误判成失效：
	//
	//   1. 前台跑着长命令 —— top / tail -f / 一次长构建期间一个标记都没有。
	//      真踩到了：用户在 top 里待了几分钟，UI 就弹出"shell 集成未生效"。
	//   2. 停在 prompt 前发呆 —— 没有新 prompt 被画出来，自然没有新标记。
	//
	// 真正说明集成坏了的是【用户敲了东西、命令跑过了，却一个标记都没来】
	// （比如 exec bash / su 之后 PROMPT_COMMAND 被换掉）。所以两个前提：
	// 不在跑命令，且上次标记之后有过输入。
	running := s.promptState == protocol.PromptRunning
	typedSinceMark := s.lastInput.After(s.lastMark)
	stale := s.integration == protocol.IntegrationActive &&
		!s.lastMark.IsZero() && !running && typedSinceMark &&
		now.Sub(s.lastMark) > integrationIdleTimeout
	s.mu.Unlock()
	if stale {
		s.setIntegration(protocol.IntegrationInactive)
	}
}

// ---------- 关闭 ----------

// close 结束会话：SIGHUP → 2 秒 → SIGKILL。
//
// 优雅路径是给 shell 的进程组发 SIGHUP，让 bash 自己把 SIGHUP 转发给它的
// 所有作业 —— 交互式 shell 开着 job control，每个作业都在自己的进程组里，
// 光靠 kill(-pgid) 打不到它们。
//
// 兜底路径（宽限期内没退干净）必须按【会话】清扫：那时 bash 已经没机会
// 转发了，不扫的话作业会变成孤儿继续跑。见 killSession。
func (s *Session) close() {
	s.closeOnce.Do(func() {
		if s.Status() == protocol.StatusRunning && s.proc != nil {
			pid := s.proc.Pid
			_ = syscall.Kill(-pid, syscall.SIGHUP)
			select {
			case <-s.done:
			case <-time.After(killGrace):
				killSession(pid, syscall.SIGKILL)
				_ = syscall.Kill(-pid, syscall.SIGKILL)
				select {
				case <-s.done:
				case <-time.After(killGrace):
				}
			}
			// shell 退出后再扫一遍：它转发 SIGHUP 之后有作业没死（比如
			// 忽略 SIGHUP 的程序）时，这是最后一道。
			killSession(pid, syscall.SIGKILL)
		}
		if s.ptmx != nil {
			s.ptmx.Close()
		}
		s.inputQ.close()
		if s.rcPath != "" {
			os.Remove(s.rcPath)
		}
		s.mu.Lock()
		s.subs = map[Subscriber]struct{}{}
		s.mu.Unlock()
	})
}

// export 拍会话快照（ADR-0016）。【必须在 freeze 之后调用】：readLoop 停了
// osc / pendCmd / curCmd* 这些"只在 readLoop 里访问"的字段才能安全地读。
//
// ptmx 交出去的是一个【dup】：新 fd 号、已清 CLOEXEC。会话自己那份保持原样 ——
// 交接中止时不用改回来；同进程内恢复（测试）也不会撞上 epoll 里已登记的同一个 fd。
func (s *Session) export() (handoff.Session, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	base, data := s.ring.Export()
	h := handoff.Session{
		SID: s.sid, PtmxFD: -1, RCPath: s.rcPath, CreatedAt: s.createdAt,
		Name: s.name, NameManual: s.nameManual, CWD: s.cwd, Status: s.status, ExitCode: s.exitCode,
		Cols: s.cols, Rows: s.rows, Integration: s.integration, PromptState: s.promptState,
		HelloSeen: s.helloSeen, LastMark: s.lastMark, LastInput: s.lastInput,
		RingBase: base, RingData: data,
		InQueued: cloneCounts(s.inQueued), InAck: cloneCounts(s.inAck),
		OSC: s.osc.Export(), PendCmd: s.pendCmd, CurCmdID: s.curCmdID, CurCmdAt: s.curCmdAt,
		UnmarkedRuns: s.unmarkedRuns, UnmarkedInput: s.unmarkedInput,
		Pending: s.inputQ.snapshot(),
	}
	if s.status == protocol.StatusRunning {
		nfd, err := unix.Dup(s.fd)
		if err != nil {
			return h, fmt.Errorf("session %d: dup ptmx: %w", s.sid, err)
		}
		if err := handoff.Inherit(nfd); err != nil {
			unix.Close(nfd)
			return h, err
		}
		h.PtmxFD = nfd
		if s.proc != nil {
			h.ShellPID = s.proc.Pid
		}
	}
	return h, nil
}

func cloneCounts(m map[string]uint64) map[string]uint64 {
	out := make(map[string]uint64, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// optStr 把空字符串转成 nil，让 JSON 里出现的是 null 而不是 ""。
func optStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// historyOn 报告此刻是否记录命令历史。
func (s *Session) historyOn() bool { return s.mgrHistory != nil && s.mgrHistory() }

func strPtr(s string) *string { return &s }
func boolPtr(b bool) *bool    { return &b }
