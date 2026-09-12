package session

import (
	"errors"
	"fmt"
	"os"
	"time"

	"golang.org/x/sys/unix"

	"github.com/sunhaijun/webterm/internal/handoff"
	"github.com/sunhaijun/webterm/internal/oscparse"
	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/ringbuf"
)

// 热升级交接（ADR-0016）：Freeze → Export → （exec）→ Restore；出错走 Thaw。
// 流程见 docs/50-backend/session-manager.md §热升级交接。

// Generation 返回热升级代数（新进程从快照里读到的值；首次启动为 0）。
func (m *Manager) Generation() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.generation
}

// Busy 返回正在跑前台命令的会话数（promptState == running）。
// --when-idle 靠它等"所有会话都停在提示符"。集成失效的会话看不出忙不忙，按空闲算。
func (m *Manager) Busy() int {
	n := 0
	for _, s := range m.List() {
		s.mu.RLock()
		if s.status == protocol.StatusRunning && s.promptState == protocol.PromptRunning {
			n++
		}
		s.mu.RUnlock()
	}
	return n
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
// 全部成功才生效；任何一个会话接不回来就整体失败 —— 那时新进程应当把错误
// 报出去退出，让 systemd 拉起一个干净的进程（会话丢失，但状态是明确的）。
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
	for _, hs := range snap.Sessions {
		s, err := m.restoreSession(hs)
		if err != nil {
			return fmt.Errorf("session: 接回会话 %d: %w", hs.SID, err)
		}
		restored[hs.SID] = s
	}
	m.instanceID = snap.InstanceID
	m.nextSID = snap.NextSID
	if m.nextSID == 0 {
		m.nextSID = 1
	}
	m.generation = snap.Generation
	m.sessions = restored
	for _, s := range restored {
		if s.Status() == protocol.StatusRunning {
			s.startLoops()
			if m.cfg.RCFileFor != nil {
				s.mu.RLock()
				pending := s.integration == protocol.IntegrationPending && !s.helloSeen
				s.mu.RUnlock()
				if pending {
					time.AfterFunc(integrationHelloTimeout, s.onHelloTimeout)
				}
			}
		}
	}
	return nil
}

func (m *Manager) restoreSession(hs handoff.Session) (*Session, error) {
	s := &Session{
		mgr:           m,
		sid:           hs.SID,
		fd:            -1,
		rcPath:        hs.RCPath,
		createdAt:     hs.CreatedAt,
		store:         m.store,
		mgrHistory:    m.HistoryEnabled,
		name:          hs.Name,
		nameManual:    hs.NameManual,
		cwd:           hs.CWD,
		status:        hs.Status,
		exitCode:      hs.ExitCode,
		cols:          hs.Cols,
		rows:          hs.Rows,
		integration:   hs.Integration,
		promptState:   hs.PromptState,
		helloSeen:     hs.HelloSeen,
		lastMark:      hs.LastMark,
		lastInput:     hs.LastInput,
		unmarkedRuns:  hs.UnmarkedRuns,
		unmarkedInput: hs.UnmarkedInput,
		ring:          ringbuf.Restore(m.cfg.RingBytes, hs.RingBase, hs.RingData),
		subs:          make(map[Subscriber]struct{}),
		inQueued:      cloneCounts(hs.InQueued),
		inAck:         cloneCounts(hs.InAck),
		osc:           oscparse.Restore(hs.OSC),
		pendCmd:       hs.PendCmd,
		curCmdID:      hs.CurCmdID,
		curCmdAt:      hs.CurCmdAt,
		inputQ:        newInputQueue(),
		done:          make(chan struct{}),
		fz:            newFreezer(),
	}
	if hs.Status != protocol.StatusRunning {
		// 已退出：ring 保留供回看（AC-4.5），没有 fd 也没有进程
		s.inputQ.close()
		close(s.done)
		return s, nil
	}
	// O_NONBLOCK 是 open file description 上的标志，随 exec 过来了；再置一次是防御，
	// 保证 os.NewFile 把它当可轮询文件（否则 SetReadDeadline 失效，下次热升级就冻不住）
	if err := unix.SetNonblock(hs.PtmxFD, true); err != nil {
		return nil, fmt.Errorf("ptmx fd %d: %w", hs.PtmxFD, err)
	}
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
