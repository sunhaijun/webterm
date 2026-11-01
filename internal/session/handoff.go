package session

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"time"

	"golang.org/x/sys/unix"

	"github.com/sunhaijun/webterm/internal/handoff"
	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/ringbuf"
	"github.com/sunhaijun/webterm/internal/vterm"
)

// 热升级交接（ADR-0016）：Freeze → Export → （exec）→ Restore；出错走 Thaw。
// 流程见 docs/50-backend/session-manager.md §热升级交接。

// Generation 返回热升级代数（新进程从快照里读到的值；首次启动为 0）。
func (m *Manager) Generation() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.generation
}

// Freeze 停住所有会话的读写循环并拒绝新会话。任何一个会话在 timeout 内没停好，
// 全部解冻并返回错误 —— 交接要么整体成立，要么什么都不动。
func (m *Manager) Freeze(timeout time.Duration) error {
	m.mu.Lock()
	m.frozen = true
	m.mu.Unlock()
	for _, s := range m.List() {
		if err := s.freeze(timeout); err != nil {
			m.Thaw()
			return err
		}
	}
	return nil
}

// Thaw 放行所有会话并恢复接受新会话。幂等。
func (m *Manager) Thaw() {
	for _, s := range m.List() {
		s.thaw()
	}
	m.mu.Lock()
	m.frozen = false
	m.mu.Unlock()
}

// Export 拍整份快照。【必须在 Freeze 成功之后】调用。代数 +1 是给新进程的。
// 出错时已 dup 出来的 fd 都关掉，什么都不留。
//
// sessions[] 按显示顺序排（ADR-0040）：顺序不单独占字段，schema 不变。
func (m *Manager) Export(fromVersion string) (*handoff.Snapshot, error) {
	m.mu.RLock()
	snap := &handoff.Snapshot{
		Schema:      handoff.Schema,
		Generation:  m.generation + 1,
		FromVersion: fromVersion,
		InstanceID:  m.instanceID,
		NextSID:     m.nextSID,
	}
	m.mu.RUnlock()
	for _, s := range m.List() {
		hs, err := s.export()
		if err != nil {
			snap.CloseFDs()
			return nil, err
		}
		snap.Sessions = append(snap.Sessions, hs)
	}
	return snap, nil
}

// Restore 在新进程里用快照重建会话表。只能在 Manager 还没创建过任何会话时调用。
//
// 显示顺序就是 sessions[] 的顺序（ADR-0040）。老快照是按 sid 排的，恢复出来
// 就是按 sid 的顺序 —— 正是老版本给出的顺序。
//
// 全部成功才生效；任何一个会话接不回来就整体失败 —— 那时新进程应当把错误
// 报出去退出，让 systemd 拉起一个干净的进程（会话丢失，但状态是明确的）。
// 模拟器状态例外：导不回来就从环形缓冲尽力还原（见 restoreTerm），不为一屏画面
// 牺牲会话。
func (m *Manager) Restore(snap *handoff.Snapshot) error {
	if err := handoff.Validate(snap); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.sessions) != 0 {
		return errors.New("session: Restore 必须在没有会话时调用")
	}
	restored := make(map[uint16]*Session, len(snap.Sessions))
	order := make([]uint16, 0, len(snap.Sessions))
	for _, hs := range snap.Sessions {
		s, err := m.restoreSession(hs)
		if err != nil {
			return fmt.Errorf("session: 接回会话 %d: %w", hs.SID, err)
		}
		restored[hs.SID] = s
		order = append(order, hs.SID)
	}
	m.instanceID = snap.InstanceID
	m.nextSID = snap.NextSID
	if m.nextSID == 0 {
		m.nextSID = 1
	}
	m.generation = snap.Generation
	m.sessions = restored
	m.order = order
	for _, s := range restored {
		if s.Status() == protocol.StatusRunning {
			s.startLoops()
		}
	}
	return nil
}

func (m *Manager) restoreSession(hs handoff.Session) (*Session, error) {
	ring := ringbuf.Restore(m.cfg.RingBytes, hs.RingBase, hs.RingData)
	s := &Session{
		mgr:        m,
		sid:        hs.SID,
		fd:         -1,
		createdAt:  hs.CreatedAt,
		name:       hs.Name,
		nameManual: hs.NameManual,
		cwd:        hs.CWD,
		status:     hs.Status,
		exitCode:   hs.ExitCode,
		cols:       hs.Cols,
		rows:       hs.Rows,
		ring:       ring,
		term:       restoreTerm(hs),
		subs:       make(map[Subscriber]struct{}),
		inQueued:   cloneCounts(hs.InQueued),
		inAck:      cloneCounts(hs.InAck),
		inputQ:     newInputQueue(),
		done:       make(chan struct{}),
		readDone:   make(chan struct{}),
		fz:         newFreezer(),
	}
	if hs.Status != protocol.StatusRunning {
		// 已退出：ring 与模拟器保留供回看（AC-4.5），没有 fd 也没有进程
		s.inputQ.close()
		close(s.done)
		return s, nil
	}
	// O_NONBLOCK 是 open file description 上的标志，随 exec 过来了；再置一次是防御，
	// 保证 os.NewFile 把它当可轮询文件（否则 SetReadDeadline 失效，下次热升级就冻不住）
	if err := unix.SetNonblock(hs.PtmxFD, true); err != nil {
		return nil, fmt.Errorf("ptmx fd %d: %w", hs.PtmxFD, err)
	}
	unix.CloseOnExec(hs.PtmxFD) // 交接时清掉的 CLOEXEC 置回来（见 pollable）
	f := os.NewFile(uintptr(hs.PtmxFD), "ptmx")
	if f == nil {
		return nil, fmt.Errorf("ptmx fd %d 无效", hs.PtmxFD)
	}
	s.ptmx, s.fd = f, hs.PtmxFD
	proc, err := os.FindProcess(hs.ShellPID)
	if err != nil {
		return nil, fmt.Errorf("shell pid %d: %w", hs.ShellPID, err)
	}
	s.proc = proc
	s.inputQ.restore(hs.Pending)
	return s, nil
}

// restoreTerm 把模拟器接回来（ADR-0026 §8）。
//
// 正常路径：导入交接来的完整状态，导入后的快照与导出前逐字节相等。
//
// 从旧版本升级上来（交接数据里没有模拟器状态），或状态导不回来：新建一个
// 模拟器，把交接来的环形缓冲内容喂进去，尽力还原。缓冲窗口如果正好从备用屏
// 程序的中间开始，那个会话的画面会错一次，下一次程序重画（或用户按一下键）
// 就恢复 —— 不为此中止升级：会话活下来比这一次画面更重要。
func restoreTerm(hs handoff.Session) *vterm.Terminal {
	if len(hs.VTerm) > 0 {
		t, err := vterm.Import(hs.VTerm)
		if err == nil {
			if c, r := t.Size(); c != int(hs.Cols) || r != int(hs.Rows) {
				t.Resize(int(hs.Cols), int(hs.Rows))
			}
			return t
		}
		slog.Warn("交接来的模拟器状态导不回来，改用环形缓冲尽力还原", "sid", hs.SID, "err", err)
	}
	t := vterm.New(int(hs.Cols), int(hs.Rows))
	t.Write(hs.RingData)
	return t
}
