package session

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"

	"github.com/creack/pty"
	"github.com/sunhaijun/webterm/internal/oscparse"
	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/ringbuf"
	"github.com/sunhaijun/webterm/internal/store"
)

// ErrSessionLimit 表示会话数已达上限。
var ErrSessionLimit = errors.New("session: 会话数已达上限")

// Config 是 Manager 的配置。
type Config struct {
	MaxSessions int    // 默认 20
	RingBytes   int    // 每会话环形缓冲，默认 1 MiB
	Shell       string // 默认 bash
	ShellArgs   []string
	// History 是否【允许】记录命令历史。false = agent 以 --no-history 启动，
	// 这是启动态覆盖，UI 上的开关会被锁死置灰。
	History bool

	// RCFileFor 生成会话的临时 rcfile，返回路径。nil 表示不注入 shell 集成
	// （--no-shell-integration）。m5 由 internal/shellinit 提供实现。
	RCFileFor func(sid uint16) (string, error)
}

func (c *Config) withDefaults() {
	if c.MaxSessions <= 0 {
		c.MaxSessions = 20
	}
	if c.RingBytes <= 0 {
		c.RingBytes = 1 << 20
	}
	if c.Shell == "" {
		c.Shell = "bash"
	}
}

// Manager 负责 sid 分配、会话表、上限控制与生命周期编排。
type Manager struct {
	cfg   Config
	store *store.Store

	// instanceID 是本次进程启动的随机 id。
	//
	// sid 是 uint16 且进程重启后从头分配 —— 没有实例标识的话，一个
	// resume{sid:1, out_seq:很大} 会落进"客户端领先"分支，屏幕上留着旧会话
	// 的内容，之后接的却是一个毫不相干的新会话的输出，用户无从察觉。
	instanceID string

	mu        sync.RWMutex
	sessions  map[uint16]*Session
	nextSID   uint16
	observers map[Subscriber]struct{}

	janitorStop chan struct{}
	janitorDone chan struct{}

	// historyOn 是 UI 开关的当前值，只在 cfg.History 为 true 时有意义。
	// 用户在做敏感工作时可以一键静默，而不是事后清理。
	historyOn atomic.Bool
}

// NewManager 创建会话管理器。
func NewManager(cfg Config, st *store.Store) *Manager {
	cfg.withDefaults()
	var b [8]byte
	_, _ = rand.Read(b[:])
	m := &Manager{
		cfg:         cfg,
		store:       st,
		instanceID:  hex.EncodeToString(b[:]),
		sessions:    make(map[uint16]*Session),
		observers:   make(map[Subscriber]struct{}),
		nextSID:     1, // 0 保留为无效值
		janitorStop: make(chan struct{}),
		janitorDone: make(chan struct{}),
	}
	m.historyOn.Store(cfg.History)
	go m.janitor()
	return m
}

// HistoryConfigured 报告 agent 是否允许记录历史（--no-history 会让它为 false）。
func (m *Manager) HistoryConfigured() bool { return m.cfg.History }

// SetHistoryEnabled 切换 UI 侧的历史开关。cfg.History 为 false 时无效。
func (m *Manager) SetHistoryEnabled(on bool) {
	m.historyOn.Store(m.cfg.History && on)
}

// HistoryEnabled 报告当前是否真的在记录历史。
func (m *Manager) HistoryEnabled() bool { return m.historyOn.Load() }

// InstanceID 返回本次进程启动的实例 id（放进 welcome）。
func (m *Manager) InstanceID() string { return m.instanceID }

// AddObserver / RemoveObserver 登记一条连接。
//
// 【订阅与观察是两件事】：订阅（Session.Subscribe）决定收不收 OUTPUT 字节，
// 观察决定收不收控制消息。未订阅的连接照样要收 session.updated —— 未读正是
// 靠它带的 head_seq 推导出来的，只发给订阅者的话永远算不出未读。
func (m *Manager) AddObserver(sub Subscriber) {
	m.mu.Lock()
	m.observers[sub] = struct{}{}
	m.mu.Unlock()
}

func (m *Manager) RemoveObserver(sub Subscriber) {
	m.mu.Lock()
	delete(m.observers, sub)
	m.mu.Unlock()
}

func (m *Manager) observerList() []Subscriber {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Subscriber, 0, len(m.observers))
	for o := range m.observers {
		out = append(out, o)
	}
	return out
}

// fanout 把一条控制消息发给所有连接。
func (m *Manager) fanout(msg any) {
	for _, o := range m.observerList() {
		o.Event(msg)
	}
}

// fanoutTo 只发给某个 client 的连接（ack 是 per-client 的）。
func (m *Manager) fanoutTo(clientID string, msg any) {
	for _, o := range m.observerList() {
		if o.ClientID() == clientID {
			o.Event(msg)
		}
	}
}

// Limits 返回给 welcome 用的上限信息。
func (m *Manager) Limits() protocol.Limits {
	return protocol.Limits{
		MaxSessions:   m.cfg.MaxSessions,
		RingBytes:     m.cfg.RingBytes,
		MaxFrameBytes: protocol.MaxPayload,
	}
}

// Spec 是新建会话的参数。
type Spec struct {
	Name *string
	CWD  string
	Cols uint16
	Rows uint16
}

// Create 新建一个会话。
func (m *Manager) Create(spec Spec) (*Session, error) {
	if spec.Cols == 0 || spec.Rows == 0 || spec.Cols > 1000 || spec.Rows > 1000 {
		return nil, errors.New("session: cols/rows 必须在 1..1000")
	}
	cwd := spec.CWD
	if cwd == "" {
		cwd, _ = os.UserHomeDir()
	}
	if fi, err := os.Stat(cwd); err != nil || !fi.IsDir() {
		return nil, fmt.Errorf("session: cwd 不是有效目录: %s", spec.CWD)
	}

	m.mu.Lock()
	if len(m.sessions) >= m.cfg.MaxSessions {
		m.mu.Unlock()
		return nil, ErrSessionLimit
	}
	sid, err := m.allocSIDLocked()
	if err != nil {
		m.mu.Unlock()
		return nil, err
	}
	m.sessions[sid] = nil // 占位，防止并发 Create 撞号
	m.mu.Unlock()

	s, err := m.start(sid, spec, cwd)
	if err != nil {
		m.mu.Lock()
		delete(m.sessions, sid)
		m.mu.Unlock()
		return nil, err
	}
	m.mu.Lock()
	m.sessions[sid] = s
	m.mu.Unlock()
	return s, nil
}

// allocSIDLocked 分配一个 sid：递增，跳过仍在使用的值，回绕后从 1 重新找空位。
// 不复用刚释放的 sid，避免"客户端还没处理完 sid=3 的关闭，新会话又叫 sid=3"。
func (m *Manager) allocSIDLocked() (uint16, error) {
	for range 65535 {
		sid := m.nextSID
		m.nextSID++
		if m.nextSID == 0 {
			m.nextSID = 1
		}
		if _, taken := m.sessions[sid]; !taken && sid != 0 {
			return sid, nil
		}
	}
	return 0, errors.New("session: sid 空间耗尽")
}

func (m *Manager) start(sid uint16, spec Spec, cwd string) (*Session, error) {
	var rcPath string
	args := m.cfg.ShellArgs
	if m.cfg.RCFileFor != nil {
		p, err := m.cfg.RCFileFor(sid)
		if err != nil {
			return nil, fmt.Errorf("session: 生成 rcfile: %w", err)
		}
		rcPath = p
		args = []string{"-i", "--rcfile", rcPath}
	} else if args == nil {
		// 没有 shell 集成时不读用户 dotfile，行为才是确定的
		args = []string{"--norc", "--noprofile", "-i"}
	}

	cmd := exec.Command(m.cfg.Shell, args...)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(),
		"TERM=xterm-256color", // xterm.js 的能力集与它最匹配
		fmt.Sprintf("WEBTERM_SESSION=%d", sid),
	)
	// 清理可能干扰 shell 初始化的变量
	cmd.Env = filterEnv(cmd.Env, "BASH_ENV", "ENV")

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: spec.Cols, Rows: spec.Rows})
	if err != nil {
		if rcPath != "" {
			os.Remove(rcPath)
		}
		return nil, fmt.Errorf("session: 启动 PTY: %w", err)
	}

	s := &Session{
		mgr:         m,
		sid:         sid,
		ptmx:        ptmx,
		cmd:         cmd,
		rcPath:      rcPath,
		createdAt:   time.Now(),
		store:       m.store,
		mgrHistory:  m.HistoryEnabled,
		cwd:         cwd,
		status:      protocol.StatusRunning,
		cols:        spec.Cols,
		rows:        spec.Rows,
		integration: protocol.IntegrationPending,
		ring:        ringbuf.New(m.cfg.RingBytes),
		subs:        make(map[Subscriber]struct{}),
		inQueued:    make(map[string]uint64),
		inAck:       make(map[string]uint64),
		osc:         oscparse.New(),
		inputQ:      newInputQueue(),
		done:        make(chan struct{}),
	}
	if spec.Name != nil && *spec.Name != "" {
		s.nameManual = true
		s.name = *spec.Name
	}
	if m.cfg.RCFileFor == nil {
		// 明确没有集成，不必等 10 秒握手
		s.integration = protocol.IntegrationInactive
	}

	go s.readLoop()
	go s.writeLoop()
	go s.waitLoop()

	if m.cfg.RCFileFor != nil {
		// 集成握手超时（AC-7.6）
		time.AfterFunc(integrationHelloTimeout, func() {
			s.mu.Lock()
			pending := s.integration == protocol.IntegrationPending
			s.mu.Unlock()
			if pending {
				s.setIntegration(protocol.IntegrationInactive)
			}
		})
	}
	return s, nil
}

// Get 按 sid 取会话。
func (m *Manager) Get(sid uint16) (*Session, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.sessions[sid]
	return s, ok && s != nil
}

// List 返回所有会话，按 sid 升序。
func (m *Manager) List() []*Session {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		if s != nil {
			out = append(out, s)
		}
	}
	sortSessions(out)
	return out
}

// Snapshot 返回所有会话的快照（welcome.sessions[]）。
func (m *Manager) Snapshot() []protocol.SessionInfo {
	list := m.List()
	out := make([]protocol.SessionInfo, 0, len(list))
	for _, s := range list {
		out = append(out, s.Snapshot())
	}
	return out
}

// Close 关闭并销毁一个会话。
//
// running：SIGHUP → 2 秒 → SIGKILL；exited：直接释放。
func (m *Manager) Close(sid uint16) (*int, error) {
	m.mu.Lock()
	s, ok := m.sessions[sid]
	if !ok || s == nil {
		m.mu.Unlock()
		return nil, ErrUnknownSession
	}
	delete(m.sessions, sid)
	m.mu.Unlock()

	s.close()
	s.mu.RLock()
	code := s.exitCode
	s.mu.RUnlock()
	return code, nil
}

// Resume 处理 hello 里的续传请求，返回 welcome.resumed[]。
//
// 这是整个项目风险最高的一段逻辑，所以它不依赖网络也不依赖浏览器 ——
// IT-resume-* 直接调它。
func (m *Manager) Resume(clientID, instanceID string, reqs []protocol.ResumeReq) []protocol.ResumeResult {
	out := make([]protocol.ResumeResult, 0, len(reqs))
	// instance_id 不符 = agent 重启过，手里的 sid 全部作废
	restarted := instanceID != "" && instanceID != m.instanceID
	for _, r := range reqs {
		res := protocol.ResumeResult{SID: r.SID}
		s, ok := m.Get(r.SID)
		if restarted || !ok {
			res.Status = protocol.ResumeGone
			out = append(out, res)
			continue
		}

		// 丢掉该 client 已入队但还没写进 PTY 的输入，再报 in_ack。
		// 否则报出去的 in_ack 偏小，客户端会重发那些正待写入的字节 → 重复。
		s.DetachClient(clientID)

		s.mu.RLock()
		base, head := s.ring.BaseSeq(), s.ring.HeadSeq()
		res.InAck = s.inAck[clientID]
		s.mu.RUnlock()

		switch {
		case r.OutSeq < base:
			res.Status, res.FromSeq = protocol.ResumeReset, base
		case r.OutSeq > head:
			// 客户端领先，不应发生；不回放
			res.Status, res.FromSeq = protocol.ResumeOK, head
		default:
			res.Status, res.FromSeq = protocol.ResumeOK, r.OutSeq
		}
		out = append(out, res)
	}
	return out
}

// Shutdown 关闭所有会话并停止巡检。
func (m *Manager) Shutdown() {
	close(m.janitorStop)
	<-m.janitorDone
	m.mu.Lock()
	sessions := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		if s != nil {
			sessions = append(sessions, s)
		}
	}
	m.sessions = make(map[uint16]*Session)
	m.mu.Unlock()

	var wg sync.WaitGroup
	for _, s := range sessions {
		wg.Add(1)
		go func() { defer wg.Done(); s.close() }()
	}
	wg.Wait()
}

// janitor 周期性检查集成是否已经失效。
func (m *Manager) janitor() {
	defer close(m.janitorDone)
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-m.janitorStop:
			return
		case now := <-t.C:
			for _, s := range m.List() {
				s.checkIntegrationIdle(now)
			}
		}
	}
}

func filterEnv(env []string, drop ...string) []string {
	out := env[:0]
	for _, kv := range env {
		keep := true
		for _, d := range drop {
			if len(kv) > len(d) && kv[:len(d)+1] == d+"=" {
				keep = false
				break
			}
		}
		if keep {
			out = append(out, kv)
		}
	}
	return out
}

func sortSessions(s []*Session) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j].sid < s[j-1].sid; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}
