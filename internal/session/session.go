package session

import (
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
	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/ringbuf"
	"github.com/sunhaijun/webterm/internal/vterm"
)

const (
	// ptyReadBuf 是 PTY 读缓冲大小。
	ptyReadBuf = 32 << 10
	// killGrace 是 SIGHUP 到 SIGKILL 之间的宽限。
	killGrace = 2 * time.Second
	// drainGrace：shell 退出之后等 readLoop 读到 EOF 的上限。后台进程还占着 PTY
	// 从端时 EOF 不会来，到点照样宣布退出。
	drainGrace = 500 * time.Millisecond
	// maxDim 是 cols / rows 的上限。
	maxDim = 1000
)

var (
	ErrInputGap       = errors.New("session: 输入序列号出现空洞")
	ErrSessionExited  = errors.New("session: 会话已退出")
	ErrUnknownSession = errors.New("session: 会话不存在")
	ErrBadSize        = errors.New("session: cols/rows 必须在 1..1000")
)

// Session 是一个 PTY + 它上面跑的 shell + 输出的环形缓冲 + 终端模拟器。
//
// 会话不跨 agent【重启】存活（ADR-0003），但跨【热升级】存活（ADR-0016）：
// 原地 exec 时 ptmx fd 与 shell 进程原样交给新进程，状态走 export / restore。
// 新增字段时先问一句"要不要进交接"（handoff.Session 是那张清单）。
type Session struct {
	mgr *Manager
	sid uint16
	// ptmx 是【可轮询】的 master：dup 出来、置 O_NONBLOCK、os.NewFile 包起来。
	// 只有可轮询的文件 SetReadDeadline 才管用，热升级冻结靠它打断阻塞读。
	// 【不要对它调 Fd()】—— 那会把它切回阻塞模式（见 winsize.go）。fd 单独记着。
	ptmx      *os.File
	fd        int
	proc      *os.Process // shell；交接过来的会话用 os.FindProcess 接回
	createdAt time.Time

	mu         sync.RWMutex // 保护以下所有字段
	name       string
	nameManual bool
	cwd        string
	status     string
	exitCode   *int
	cols, rows uint16
	// ring 与 term 【在同一把锁下、对同一段字节】更新：任何时刻模拟器吃到的
	// 字节数都等于 ring.HeadSeq()，快照的 seq 直接取它（ADR-0026 §1）。
	ring *ringbuf.Buffer
	term *vterm.Terminal
	subs map[Subscriber]struct{}
	// inAck/inQueued 按 client_id 记账，【跨重连存活】（协议 §5.4）。
	// inQueued 是已接受入队的字节数（用于校验 seq 连续性），
	// inAck 是已真正写进 PTY 的字节数（用于 ack 与重连后的重发起点）。
	inQueued map[string]uint64
	inAck    map[string]uint64

	inputQ    *inputQueue
	done      chan struct{}
	readDone  chan struct{} // readLoop 退出（读到 EOF / EIO）时关闭
	closeOnce sync.Once

	// 热升级冻结（ADR-0016）：见 freeze.go
	fz         freezer
	readAlive  atomic.Bool
	writeAlive atomic.Bool
}

// SID 返回会话 id。
func (s *Session) SID() uint16 { return s.sid }

// Info 返回会话的元数据（welcome.sessions[] / session.created）。
func (s *Session) Info() protocol.SessionInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return protocol.SessionInfo{
		SID:          s.sid,
		Name:         s.displayNameLocked(),
		NameIsManual: s.nameManual,
		CWD:          s.cwd,
		Status:       s.status,
		ExitCode:     s.exitCode,
		Cols:         s.cols,
		Rows:         s.rows,
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

// HeadSeq 返回该会话累计的 PTY 输出字节数。
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

// TermSnapshot 返回此刻的快照与它对应的 seq（= head_seq）。测试与排障用 ——
// 协议路径上快照只经 Subscribe / Resize 发出。
func (s *Session) TermSnapshot() (seq uint64, data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ring.HeadSeq(), s.term.Snapshot()
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

func validSize(cols, rows uint16) bool {
	return cols > 0 && rows > 0 && cols <= maxDim && rows <= maxDim
}

// Resize 调整终端尺寸（协议 §4.1 resize）。
//
//	列数变了：锁内 模拟器.Resize → 生成快照（seq = head_seq）→ 推给【每个】订阅者；
//	          锁外 TIOCSWINSZ。两边各自重排的结果不一致，以 agent 的为准（ADR-0026 §4）
//	只改行数：模拟器.Resize + TIOCSWINSZ，不发快照 —— 手机每弹一次软键盘就改
//	          一次行数，每次重发上百 KiB、清掉浏览器的回看位置，代价太大
func (s *Session) Resize(cols, rows uint16) error {
	if !validSize(cols, rows) {
		return ErrBadSize
	}
	s.mu.Lock()
	changed := s.applySizeLocked(cols, rows, nil)
	running := s.status == protocol.StatusRunning
	s.mu.Unlock()
	if changed && running {
		// 【锁外、入队之后】：程序因 SIGWINCH 重画的字节一定排在快照之后
		return setWinsize(s.ptmx, cols, rows)
	}
	return nil
}

// applySizeLocked 把尺寸应用到模拟器（须持写锁），返回尺寸是否变了。
//
// 列数变了就生成一份快照推给每个订阅者，以及 extra（还没进集合的新订阅者）。
// TIOCSWINSZ 由调用方在锁外做。
func (s *Session) applySizeLocked(cols, rows uint16, extra Subscriber) bool {
	if cols == s.cols && rows == s.rows {
		return false
	}
	colsChanged := cols != s.cols
	s.cols, s.rows = cols, rows
	s.term.Resize(int(cols), int(rows))
	if colsChanged {
		seq, snap := s.ring.HeadSeq(), s.term.Snapshot()
		for sub := range s.subs {
			sub.Snapshot(s.sid, seq, snap)
		}
		if extra != nil {
			if _, already := s.subs[extra]; !already {
				extra.Snapshot(s.sid, seq, snap)
			}
		}
	}
	return true
}

// ---------- 订阅 ----------

// Subscribe 把 sub 加入订阅者集合，并按协议 §5.1 补齐它缺的输出：
//
//	cols/rows 带来的列数与会话当前不同 → 模拟器.Resize → 快照（发给每个订阅者）
//	outSeq > 0 且 base_seq ≤ outSeq ≤ head_seq → 增量：推 [outSeq, head_seq) 的原始字节
//	其余（outSeq == 0、落出窗口、领先于 head） → 快照
//
// 返回走了哪条路（protocol.ResumeOK / ResumeSnapshot）与 from_seq（增量时是
// outSeq，快照时是快照的 seq）。cols/rows 为 0 或越界表示沿用会话当前尺寸 ——
// hello.resume 不带尺寸。
//
// 【判定、推送、加入订阅者集合在同一把锁下完成】—— 分开做的话，中间到达的
// 一批输出要么被发两遍（重复），要么两边都漏（空洞），而协议 §3 规定客户端
// 遇到空洞直接关连接。推送按契约是非阻塞的，所以这里不会卡住 PTY 读取。
//
// 尺寸变化的 TIOCSWINSZ 在锁外、入队之后：程序因 SIGWINCH 重画的字节因此
// 一定排在快照或增量之后。反过来的话，那批重画字节会进入快照之前的位置，
// 客户端拿不到那一屏（协议 §4.1）。
func (s *Session) Subscribe(sub Subscriber, outSeq uint64, cols, rows uint16) (status string, fromSeq uint64) {
	s.mu.Lock()
	resized, colsChanged := false, false
	if validSize(cols, rows) {
		colsChanged = cols != s.cols
		// 列数变了：快照已经推给了每个订阅者，包括 sub
		resized = s.applySizeLocked(cols, rows, sub)
	}
	if colsChanged {
		status, fromSeq = protocol.ResumeSnapshot, s.ring.HeadSeq()
	} else {
		var data []byte
		ok := false
		if outSeq > 0 {
			data, ok = s.ring.Slice(outSeq)
		}
		if ok {
			status, fromSeq = protocol.ResumeOK, outSeq
			if len(data) > 0 {
				sub.Push(s.sid, outSeq, data)
			}
		} else {
			status, fromSeq = protocol.ResumeSnapshot, s.ring.HeadSeq()
			sub.Snapshot(s.sid, fromSeq, s.term.Snapshot())
		}
	}
	s.subs[sub] = struct{}{}
	running := s.status == protocol.StatusRunning
	s.mu.Unlock()

	if resized && running {
		_ = setWinsize(s.ptmx, cols, rows)
	}
	return status, fromSeq
}

// Unsubscribe 把 sub 从订阅者集合里摘掉。会话在 agent 侧照常运行、照常喂模拟器。
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

// ---------- goroutine ----------

// consume 处理一次 PTY 读到的字节：进环形缓冲、喂模拟器、推给订阅者。
//
// 【agent 不改写输出流】：seq 就是 PTY 输出的累计字节数（ADR-0026 §2）。
//
// 推送也在锁内。Push 按契约非阻塞，放在锁内的代价只是几次入队；换来的是同一
// 会话的所有帧（实时输出、订阅补齐、改列数的快照）按锁的次序进入每条连接的
// 写队列。放到锁外的话，一段已经算进快照的输出可能排在那份快照【之后】才到
// 客户端，违反协议 §3 的 seq 连续性。
func (s *Session) consume(chunk []byte) {
	if len(chunk) == 0 {
		return
	}
	// 必须拷贝：chunk 是 readLoop 复用的缓冲，订阅者的写队列会持有它
	data := make([]byte, len(chunk))
	copy(data, chunk)

	s.mu.Lock()
	seq := s.ring.Append(data)
	s.term.Write(data)
	for sub := range s.subs {
		sub.Push(s.sid, seq, data)
	}
	s.mu.Unlock()

	// 未订阅的连接靠 head_seq 推导未读（连接层做 1s 节流，已订阅的直接丢掉）
	head := seq + uint64(len(data))
	s.emit(&protocol.SessionUpdated{SID: s.sid, HeadSeq: &head})
}

// startLoops 起四个 goroutine。alive 标记要在 go 之前置好：freeze 靠它数要等几个循环。
func (s *Session) startLoops() {
	s.readAlive.Store(true)
	s.writeAlive.Store(true)
	go s.readLoop()
	go s.writeLoop()
	go s.waitLoop()
	go s.cwdLoop(s.mgr.cfg.CWDPollInterval)
}

func (s *Session) readLoop() {
	defer func() {
		s.fz.exiting()
		s.readAlive.Store(false)
		close(s.readDone)
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
				// ring、模拟器与 out_seq 一致 —— 等解冻再回去读
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
//
// 【先等 readLoop 把 PTY 里剩下的输出读完】，再宣布退出：shell 退出时内核里往往
// 还躺着最后几行输出，readLoop 还没读到。先发 exited 的话，这几行 OUTPUT 会排在
// 它后面，前端的「进程结束」提示行就插到了输出前面。读到 EOF（EIO）说明从端都
// 关了、输出读完了；后台进程还占着从端时 EOF 不会来，最多等 drainGrace。
//
// 这条 session.updated 带上此刻的 head_seq：客户端据此知道「已退出」之前的输出
// 一共有多少，与最后一帧 OUTPUT 的末尾对得上。
func (s *Session) waitLoop() {
	// 用 *os.Process 而不是 exec.Cmd.Wait：交接过来的会话只有 pid（os.FindProcess），
	// 同 PID exec 之后它们仍是子进程，Wait 照常拿退出码。
	st, err := s.proc.Wait()
	code := -1
	if err == nil && st != nil {
		code = st.ExitCode() // 被信号杀掉时是 -1
	}

	select {
	case <-s.readDone:
	case <-time.After(drainGrace):
	}

	s.mu.Lock()
	s.status = protocol.StatusExited
	s.exitCode = &code
	head := s.ring.HeadSeq()
	s.mu.Unlock()

	s.inputQ.close() // 停止接受输入
	close(s.done)

	s.emit(&protocol.SessionUpdated{
		SID:      s.sid,
		Status:   strPtr(protocol.StatusExited),
		ExitCode: &code,
		HeadSeq:  &head,
	})
	// ring 与模拟器保留，不释放：构建失败了要能回看报错（AC-4.5），切回、刷新
	// 都还能拿到快照。
}

// emit 把一条控制消息发给【所有连接】，不只是订阅者。
//
// 未订阅的连接也要收 session.updated —— 侧栏里的会话名、未读标记都靠它。
// 订阅只决定收不收 OUTPUT / SNAPSHOT 帧。
func (s *Session) emit(msg any) {
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
		s.mu.Lock()
		s.subs = map[Subscriber]struct{}{}
		s.mu.Unlock()
	})
}

// export 拍会话的交接快照（ADR-0016 / ADR-0026 §8）。【必须在 freeze 之后调用】：
// readLoop 停了，ring 与模拟器不会再变。
//
// ptmx 交出去的是一个【dup】：新 fd 号、已清 CLOEXEC。会话自己那份保持原样 ——
// 交接中止时不用改回来；同进程内恢复（测试）也不会撞上 epoll 里已登记的同一个 fd。
func (s *Session) export() (handoff.Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	base, data := s.ring.Export()
	vt, err := s.term.Export()
	if err != nil {
		return handoff.Session{}, fmt.Errorf("session %d: 导出模拟器状态: %w", s.sid, err)
	}
	h := handoff.Session{
		SID: s.sid, PtmxFD: -1, CreatedAt: s.createdAt,
		Name: s.name, NameManual: s.nameManual, CWD: s.cwd, Status: s.status, ExitCode: s.exitCode,
		Cols: s.cols, Rows: s.rows,
		RingBase: base, RingData: data,
		VTerm:    vt,
		InQueued: cloneCounts(s.inQueued), InAck: cloneCounts(s.inAck),
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

func strPtr(s string) *string { return &s }
func boolPtr(b bool) *bool    { return &b }
