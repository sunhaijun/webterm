package session

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"

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
)

var (
	ErrInputGap       = errors.New("session: 输入序列号出现空洞")
	ErrSessionExited  = errors.New("session: 会话已退出")
	ErrUnknownSession = errors.New("session: 会话不存在")
)

// Session 是一个 PTY + 它上面跑的 shell + 它的输出环形缓冲。
//
// 注意：会话不跨 agent 重启存活（ADR-0003）。
type Session struct {
	sid       uint16
	ptmx      *os.File
	cmd       *exec.Cmd
	rcPath    string // 临时 rcfile，销毁时删除
	createdAt time.Time
	store     *store.Store
	history   bool // 是否记录命令历史

	mu          sync.RWMutex // 保护以下所有字段
	name        string
	nameManual  bool
	cwd         string
	status      string
	exitCode    *int
	cols, rows  uint16
	integration string
	lastMark    time.Time // 上一个 OSC 133 标记的时间
	ring        *ringbuf.Buffer
	subs        map[Subscriber]struct{}
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
		SID:          s.sid,
		Name:         s.displayNameLocked(),
		NameIsManual: s.nameManual,
		CWD:          s.cwd,
		Status:       s.status,
		ExitCode:     s.exitCode,
		Cols:         s.cols,
		Rows:         s.rows,
		Integration:  s.integration,
		BaseSeq:      s.ring.BaseSeq(),
		HeadSeq:      s.ring.HeadSeq(),
		CreatedAt:    s.createdAt.UnixMilli(),
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
	subs := s.subsLocked()
	s.mu.Unlock()
	broadcast(subs, msg)
}

// Resize 调整 PTY 窗口大小。
func (s *Session) Resize(cols, rows uint16) error {
	if cols == 0 || rows == 0 || cols > 1000 || rows > 1000 {
		return errors.New("session: cols/rows 必须在 1..1000")
	}
	s.mu.Lock()
	s.cols, s.rows = cols, rows
	s.mu.Unlock()
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

func broadcast(subs []Subscriber, msg any) {
	for _, sub := range subs {
		sub.Event(msg)
	}
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
func (s *Session) readLoop() {
	buf := make([]byte, ptyReadBuf)
	for {
		n, err := s.ptmx.Read(buf)
		if n > 0 {
			clean, events := s.osc.Feed(buf[:n])

			var data []byte
			var seq uint64
			var subs []Subscriber
			s.mu.Lock()
			if len(clean) > 0 {
				seq = s.ring.Append(clean)
				// 必须拷贝：clean 可能指向 Feed 复用的缓冲或 buf 本身，
				// 而订阅者的写队列会持有它到下一次 Read 之后。
				data = make([]byte, len(clean))
				copy(data, clean)
			}
			subs = s.subsLocked()
			s.mu.Unlock()

			for _, sub := range subs {
				if data != nil {
					sub.Push(s.sid, seq, data, false)
				}
			}
			for _, ev := range events {
				s.handleOSCEvent(ev)
			}
		}
		if err != nil {
			return // EIO = shell 退出
		}
	}
}

// writeLoop：从输入队列取数据 → PTY.Write() → 更新 in_ack。
func (s *Session) writeLoop() {
	for {
		it, ok := s.inputQ.pop()
		if !ok {
			select {
			case <-s.inputQ.notify:
				continue
			case <-s.done:
				return
			}
		}
		n, err := s.ptmx.Write(it.data)
		if n > 0 {
			s.mu.Lock()
			s.inAck[it.clientID] += uint64(n)
			ack := s.inAck[it.clientID]
			subs := s.subsLocked()
			s.mu.Unlock()
			// ack 只发给同一个 client —— 记账是 per-client 的
			for _, sub := range subs {
				if sub.ClientID() == it.clientID {
					sub.Event(&protocol.Ack{SID: s.sid, InAck: ack})
				}
			}
		}
		if err != nil {
			return
		}
	}
}

// waitLoop：等 shell 退出，设置 exited 状态与退出码。
func (s *Session) waitLoop() {
	err := s.cmd.Wait()
	code := 0
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		code = ee.ExitCode()
	} else if err != nil {
		code = -1
	}

	s.mu.Lock()
	s.status = protocol.StatusExited
	s.exitCode = &code
	subs := s.subsLocked()
	s.mu.Unlock()

	s.inputQ.close() // 停止接受输入
	close(s.done)

	broadcast(subs, &protocol.SessionUpdated{
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

func (s *Session) handleOSCEvent(ev oscparse.Event) {
	switch e := ev.(type) {
	case oscparse.PromptEvent:
		s.markIntegrationAlive()
		if e.State == protocol.PromptRunning {
			s.beginCommand()
		}
		s.broadcastEvent(&protocol.Prompt{SID: s.sid, State: e.State})

	case oscparse.CommandEndEvent:
		s.endCommand(e.ExitCode)

	case oscparse.CommandTextEvent:
		// 连续两个 1701;cmd 中间没有 133;C → 后者覆盖前者
		s.pendCmd = e.Text

	case oscparse.CWDEvent:
		s.setCWD(e.Path)

	case oscparse.IntegrationHelloEvent:
		s.setIntegration(protocol.IntegrationActive)
	}
}

// markIntegrationAlive 记下"刚见到一个 133 标记"。
// 从 inactive 收到标记要立即转回 active。
func (s *Session) markIntegrationAlive() {
	s.mu.Lock()
	s.lastMark = time.Now()
	changed := s.integration != protocol.IntegrationActive
	s.integration = protocol.IntegrationActive
	subs := s.subsLocked()
	s.mu.Unlock()
	if changed {
		broadcast(subs, &protocol.SessionUpdated{
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
	subs := s.subsLocked()
	s.mu.Unlock()
	broadcast(subs, &protocol.SessionUpdated{SID: s.sid, Integration: strPtr(v)})
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
	subs := s.subsLocked()
	s.mu.Unlock()
	broadcast(subs, &protocol.CWD{SID: s.sid, Path: path})
	broadcast(subs, upd)
}

// beginCommand 在 133;C 时结算命令开始。
//
// 没有前置的 1701;cmd（空回车，或以空格开头被跳过）时不记录命令，
// 但 prompt 状态照常上报。
func (s *Session) beginCommand() {
	if s.pendCmd == "" {
		return
	}
	text := s.pendCmd
	s.pendCmd = ""

	s.mu.RLock()
	cwd, name, outSeq := s.cwd, s.displayNameLocked(), s.ring.HeadSeq()
	s.mu.RUnlock()

	now := time.Now()
	s.curCmdAt = now
	var cmdID int64
	if s.history && s.store != nil {
		id, err := s.store.BeginCommand(text, name, cwd, now)
		if err != nil {
			return
		}
		cmdID = id
		s.curCmdID = &id
	}
	s.broadcastEvent(&protocol.CommandStart{
		SID: s.sid, CmdID: cmdID, Text: text, CWD: cwd,
		At: now.UnixMilli(), OutSeq: outSeq,
	})
}

// endCommand 在 133;D 时补齐退出码与耗时。
// 没有进行中的命令（133;D 没有前置的 133;C）时只发 prompt 状态，不结算。
func (s *Session) endCommand(exitCode *int) {
	if s.curCmdID == nil {
		return
	}
	id := *s.curCmdID
	s.curCmdID = nil
	dur := time.Since(s.curCmdAt)

	if s.history && s.store != nil {
		if err := s.store.FinishCommand(id, exitCode, dur); err != nil {
			return
		}
	}
	s.mu.RLock()
	outSeq := s.ring.HeadSeq()
	s.mu.RUnlock()
	s.broadcastEvent(&protocol.CommandEnd{
		SID: s.sid, CmdID: id, ExitCode: exitCode,
		DurationMS: dur.Milliseconds(), OutSeq: outSeq,
	})
}

func (s *Session) broadcastEvent(msg any) {
	s.mu.RLock()
	subs := s.subsLocked()
	s.mu.RUnlock()
	broadcast(subs, msg)
}

// checkIntegrationIdle 由 manager 的巡检 goroutine 周期性调用。
func (s *Session) checkIntegrationIdle(now time.Time) {
	s.mu.Lock()
	stale := s.integration == protocol.IntegrationActive &&
		!s.lastMark.IsZero() && now.Sub(s.lastMark) > integrationIdleTimeout
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
		if s.Status() == protocol.StatusRunning && s.cmd.Process != nil {
			pid := s.cmd.Process.Pid
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
		s.ptmx.Close()
		s.inputQ.close()
		if s.rcPath != "" {
			os.Remove(s.rcPath)
		}
		s.mu.Lock()
		s.subs = map[Subscriber]struct{}{}
		s.mu.Unlock()
	})
}

func strPtr(s string) *string { return &s }
func boolPtr(b bool) *bool    { return &b }
