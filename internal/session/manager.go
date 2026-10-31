package session

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"

	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/ringbuf"
	"github.com/sunhaijun/webterm/internal/vterm"
)

// ErrSessionLimit 表示会话数已达上限。
var ErrSessionLimit = errors.New("session: 会话数已达上限")

// ErrFrozen：正在热升级交接，此刻不接受新会话（ADR-0016）。
var ErrFrozen = errors.New("session: 正在热升级，稍后再试")

// DefaultRingBytes 是每会话环形缓冲的默认容量（ADR-0026 §3）。它只服务增量
// 续传：积压超过它时，快照（≤ 170 KiB）比重放更小更快。
const DefaultRingBytes = 256 << 10

// Config 是 Manager 的配置。
type Config struct {
	MaxSessions int    // 默认 20
	RingBytes   int    // 每会话环形缓冲，默认 DefaultRingBytes
	Shell       string // 默认 bash

	// ShellArgs 覆盖 shell 的启动参数。nil 时按 NoLoginShell 选默认值：
	// 登录交互 shell `-l -i`（按 shell 自己的规则加载 profile 链），或 `-i`。
	// 测试用它给出确定的 `--norc --noprofile -i`。
	ShellArgs []string
	// NoLoginShell：--no-login-shell，用非登录交互 shell（bash 只读 ~/.bashrc）。
	//
	// 【故意是反的】：零值 = 登录 shell，与默认行为一致。默认开的布尔项写成正向
	// 字段，任何忘了填 Config 的调用方都会静默失去默认行为。
	NoLoginShell bool

	// SessionEnv 是 --session-env 给的 KEY=VAL，注入每个会话的 PTY（AC-7.8）。
	// 同一个键出现多次时后面的胜出 —— 配置文件先灌、命令行后 Parse，
	// 于是"命令行压过配置文件"这条规则在这里自然成立。
	SessionEnv []string

	// NoAltScreenCompat 关掉内置的备用屏兼容清单（--no-altscreen-compat）。
	// 同样故意是反的：零值 = 清单生效。
	NoAltScreenCompat bool

	// CWDPollInterval 是读 /proc/<前台进程组>/cwd 的周期，默认 1 秒（ADR-0026 §6）。
	CWDPollInterval time.Duration
}

// altScreenCompat 是"把全屏 AI CLI 拉回主屏"的内置清单（AC-7.8，ADR-0024 §1）。
//
// 边界写死在这里：清单里**只放"把 TUI 拉回主屏"这一类开关**，任何改变程序行为
// 的（模型、权限、遥测）一概不放。这些还都是上游的私有变量、没有兼容承诺，
// 所以它必须能关（--no-altscreen-compat），也必须能验证
// （docs/80-ops/troubleshooting.md 的两问）。
var altScreenCompat = []string{
	"CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1",
}

// buildEnv 组装会话 PTY 的环境（AC-7.8）。优先级从高到低：
//
//	fixed        webterm 自己的口径（TERM / WEBTERM_SESSION），不可覆盖
//	sessionEnv   --session-env，用户显式指定
//	base         agent 继承来的环境，用户机器上本来就有的
//	compat       内置兼容清单，只在前三者都没有这个键时才生效
//
// 返回值里每个键只出现一次。exec 自己也会去重（保留最后一条），但"最后一条
// 胜出"是隐式规则，不该成为正确性的依据 —— 显式去重才能让单测断言得起来。
func buildEnv(base, compat, sessionEnv, fixed []string) []string {
	at := make(map[string]int, len(base)+len(compat)+len(sessionEnv)+len(fixed))
	out := make([]string, 0, len(base)+len(compat)+len(sessionEnv)+len(fixed))
	put := func(kv string, overwrite bool) {
		k := envKey(kv)
		if k == "" {
			return
		}
		if i, ok := at[k]; ok {
			if overwrite {
				out[i] = kv
			}
			return
		}
		at[k] = len(out)
		out = append(out, kv)
	}
	for _, kv := range base {
		put(kv, true)
	}
	for _, kv := range compat {
		put(kv, false) // 用户已经设过的不覆盖 —— 这是他的机器
	}
	for _, kv := range sessionEnv {
		put(kv, true)
	}
	for _, kv := range fixed {
		put(kv, true)
	}
	return out
}

// envKey 取 KEY=VAL 的键；没有 = 的条目没有键，调用方会丢掉它。
func envKey(kv string) string {
	for i := 0; i < len(kv); i++ {
		if kv[i] == '=' {
			return kv[:i]
		}
	}
	return ""
}

// compatEnv 返回本次要注入的兼容清单。
func (c *Config) compatEnv() []string {
	if c.NoAltScreenCompat {
		return nil
	}
	return altScreenCompat
}

// shellArgs 返回 shell 的启动参数（ADR-0026 §6：shell 照常启动，不注入任何东西）。
func (c *Config) shellArgs() []string {
	if c.ShellArgs != nil {
		return c.ShellArgs
	}
	if c.NoLoginShell {
		return []string{"-i"}
	}
	return []string{"-l", "-i"}
}

func (c *Config) withDefaults() {
	if c.MaxSessions <= 0 {
		c.MaxSessions = 20
	}
	if c.RingBytes <= 0 {
		c.RingBytes = DefaultRingBytes
	}
	if c.Shell == "" {
		c.Shell = "bash"
	}
	if c.CWDPollInterval <= 0 {
		c.CWDPollInterval = time.Second
	}
}

// Manager 负责 sid 分配、会话表、上限控制与生命周期编排。
type Manager struct {
	cfg Config

	// instanceID 是本次进程启动的随机 id。
	//
	// sid 是 uint16 且进程重启后从头分配 —— 没有实例标识的话，一个
	// resume{sid:1, out_seq:很大} 会被当成增量或快照接到一个毫不相干的新会话上，
	// 用户无从察觉。
	instanceID string

	mu        sync.RWMutex
	sessions  map[uint16]*Session
	nextSID   uint16
	observers map[Subscriber]struct{}
	// generation 是热升级的代数：每交接一次 +1（ADR-0016）。webterm reload 靠它判断新进程已接手。
	generation int
	frozen     bool // Freeze 期间拒绝 Create

	shutdownOnce sync.Once
}

// NewManager 创建会话管理器。
func NewManager(cfg Config) *Manager {
	cfg.withDefaults()
	var b [8]byte
	_, _ = rand.Read(b[:])
	return &Manager{
		cfg:        cfg,
		instanceID: hex.EncodeToString(b[:]),
		sessions:   make(map[uint16]*Session),
		observers:  make(map[Subscriber]struct{}),
		nextSID:    1, // 0 保留为无效值
	}
}

// InstanceID 返回本次进程启动的实例 id（放进 welcome）。
func (m *Manager) InstanceID() string { return m.instanceID }

// AddObserver / RemoveObserver 登记一条连接。
//
// 【订阅与观察是两件事】：订阅（Session.Subscribe）决定收不收 OUTPUT / SNAPSHOT
// 帧，观察决定收不收控制消息。未订阅的连接照样要收 session.updated —— 未读正是
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
	if !validSize(spec.Cols, spec.Rows) {
		return nil, ErrBadSize
	}
	cwd := spec.CWD
	if cwd == "" {
		cwd, _ = os.UserHomeDir()
	}
	if fi, err := os.Stat(cwd); err != nil || !fi.IsDir() {
		return nil, fmt.Errorf("session: cwd 不是有效目录: %s", spec.CWD)
	}

	m.mu.Lock()
	if m.frozen {
		m.mu.Unlock()
		return nil, ErrFrozen
	}
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
	cmd := exec.Command(m.cfg.Shell, m.cfg.shellArgs()...)
	cmd.Dir = cwd
	// 会话环境（AC-7.8）：继承的环境先清掉干扰 shell 初始化的两个键，
	// 再叠兼容清单 / --session-env / webterm 自己的口径。优先级见 buildEnv。
	cmd.Env = buildEnv(
		filterEnv(os.Environ(), "BASH_ENV", "ENV"),
		m.cfg.compatEnv(),
		m.cfg.SessionEnv,
		[]string{
			"TERM=xterm-256color", // xterm.js 的能力集与它最匹配，查询也由它回答
			fmt.Sprintf("WEBTERM_SESSION=%d", sid),
		},
	)

	raw, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: spec.Cols, Rows: spec.Rows})
	if err != nil {
		return nil, fmt.Errorf("session: 启动 PTY: %w", err)
	}
	// 换成可轮询的 master（ADR-0016）：creack/pty 给的是阻塞文件，SetReadDeadline
	// 对它不起作用，热升级时打断不了阻塞读。dup 一份、置 O_NONBLOCK、os.NewFile
	// 包起来就进了 Go 的 poller；原来的关掉（file description 由 dup 持有，shell 不会收 SIGHUP）。
	ptmx, fd, err := pollable(raw)
	if err != nil {
		_ = raw.Close()
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("session: 包装 PTY: %w", err)
	}

	s := &Session{
		mgr:       m,
		sid:       sid,
		ptmx:      ptmx,
		fd:        fd,
		proc:      cmd.Process,
		createdAt: time.Now(),
		cwd:       cwd,
		status:    protocol.StatusRunning,
		cols:      spec.Cols,
		rows:      spec.Rows,
		ring:      ringbuf.New(m.cfg.RingBytes),
		term:      vterm.New(int(spec.Cols), int(spec.Rows)),
		subs:      make(map[Subscriber]struct{}),
		inQueued:  make(map[string]uint64),
		inAck:     make(map[string]uint64),
		inputQ:    newInputQueue(),
		done:      make(chan struct{}),
		readDone:  make(chan struct{}),
		fz:        newFreezer(),
	}
	if spec.Name != nil && *spec.Name != "" {
		s.nameManual = true
		s.name = *spec.Name
	}
	s.startLoops()
	return s, nil
}

// pollable 把 creack/pty 给的阻塞 master 换成 Go poller 里的非阻塞文件。
// 返回新文件与它的 fd 号（fd 单独记着 —— 之后不能再对文件调 Fd()）。
func pollable(raw *os.File) (*os.File, int, error) {
	fd, err := unix.Dup(int(raw.Fd()))
	if err != nil {
		return nil, -1, err
	}
	if err := unix.SetNonblock(fd, true); err != nil {
		unix.Close(fd)
		return nil, -1, err
	}
	f := os.NewFile(uintptr(fd), "ptmx")
	if f == nil {
		unix.Close(fd)
		return nil, -1, errors.New("os.NewFile 失败")
	}
	_ = raw.Close()
	return f, fd, nil
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

// Infos 返回所有会话的元数据（welcome.sessions[]）。
func (m *Manager) Infos() []protocol.SessionInfo {
	list := m.List()
	out := make([]protocol.SessionInfo, 0, len(list))
	for _, s := range list {
		out = append(out, s.Info())
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

// Resume 处理 hello 里的续传请求：对每一项按协议 §5.1 判定 ok / snapshot / gone，
// 并【立刻】把 sub 订阅上去（补齐的帧随之入队）。返回 welcome.resumed[]。
//
// 判定与入队必须是同一个动作（见 Session.Subscribe），所以 welcome 要排在这些帧
// 前面得靠连接层：调用 Resume 之前先把写队列"挂起"，welcome 入队之后再放行。
//
// 这是整个项目风险最高的一段逻辑，所以它不依赖网络也不依赖浏览器 ——
// IT-resume-* 直接调它。
func (m *Manager) Resume(sub Subscriber, instanceID string, reqs []protocol.ResumeReq) []protocol.ResumeResult {
	out := make([]protocol.ResumeResult, 0, len(reqs))
	clientID := sub.ClientID()
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
		res.InAck = s.InAck(clientID)
		res.Status, res.FromSeq = s.Subscribe(sub, r.OutSeq, 0, 0)
		out = append(out, res)
	}
	return out
}

// Busy 返回有命令在跑的会话数：PTY 的前台进程组不是 shell 自己（见 Session.busy）。
// --when-idle 靠它等"所有会话都停在提示符"。
func (m *Manager) Busy() int {
	n := 0
	for _, s := range m.List() {
		if s.busy() {
			n++
		}
	}
	return n
}

// Shutdown 关闭所有会话。幂等 —— SIGTERM 处理和 defer 都会调它。
func (m *Manager) Shutdown() {
	m.shutdownOnce.Do(m.shutdown)
}

func (m *Manager) shutdown() {
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
