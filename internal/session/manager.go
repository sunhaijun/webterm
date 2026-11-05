package session

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"sync"
	"time"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"

	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/ringbuf"
	"github.com/sunhaijun/webterm/internal/vterm"
)

// ErrSessionLimit means the session limit has been reached.
var ErrSessionLimit = errors.New("session: session limit reached")

// ErrFrozen means a hot-upgrade handoff is in progress and new sessions are
// refused for now (ADR-0016).
var ErrFrozen = errors.New("session: hot upgrade in progress, try again shortly")

// DefaultRingBytes is the default per-session ring buffer size (ADR-0026 §3).
// It only serves incremental resume: once the backlog exceeds it, a snapshot
// (<= 170 KiB) is smaller and faster than a replay.
const DefaultRingBytes = 256 << 10

// Config configures a Manager.
type Config struct {
	MaxSessions int    // default 20
	RingBytes   int    // per-session ring buffer, default DefaultRingBytes
	Shell       string // default bash

	// ShellArgs overrides the shell arguments. When nil, NoLoginShell picks
	// the default: an interactive login shell `-l -i` (loading the profile
	// chain by the shell's own rules), or `-i`. Tests use it to pin
	// `--norc --noprofile -i`.
	ShellArgs []string
	// NoLoginShell (--no-login-shell) starts a non-login interactive shell
	// (bash reads only ~/.bashrc).
	//
	// It is negated on purpose so the zero value means a login shell, the
	// default. A positive field for an on-by-default option would silently
	// drop the default for any caller that forgot to set it.
	NoLoginShell bool

	// SessionEnv holds KEY=VAL pairs from --session-env, injected into every
	// session's PTY (AC-7.8). For repeated keys the last one wins. The config
	// file is loaded before the command line is parsed, so the command line
	// overrides the config file without extra logic.
	SessionEnv []string

	// NoAltScreenCompat disables the built-in alternate screen compat list
	// (--no-altscreen-compat). Also negated on purpose: the zero value keeps
	// the list on.
	NoAltScreenCompat bool

	// CWDPollInterval is how often /proc/<foreground process group>/cwd is
	// read; default 1s (ADR-0026 §6).
	CWDPollInterval time.Duration
}

// altScreenCompat is the built-in list that brings full-screen AI CLIs back to
// the main screen (AC-7.8, ADR-0024 §1).
//
// Scope is fixed: only switches that move a TUI back to the main screen.
// Nothing that changes program behavior (model, permissions, telemetry). These
// are private upstream variables with no compatibility promise, so the list
// must be possible to disable (--no-altscreen-compat) and to verify (the two
// questions in docs/80-ops/troubleshooting.md).
var altScreenCompat = []string{
	"CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1",
}

// buildEnv assembles the environment for a session PTY (AC-7.8). Precedence,
// highest first:
//
//	fixed        webterm's own (TERM / WEBTERM_SESSION), cannot be overridden
//	sessionEnv   --session-env, set explicitly by the user
//	base         environment inherited by the agent, already on the user's machine
//	compat       built-in compat list, applied only if none of the above sets the key
//
// Each key appears once in the result. exec also deduplicates (last wins), but
// that is an implicit rule and shouldn't carry correctness; explicit dedup is
// something unit tests can assert on.
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
		put(kv, false) // don't override what the user set; it's their machine
	}
	for _, kv := range sessionEnv {
		put(kv, true)
	}
	for _, kv := range fixed {
		put(kv, true)
	}
	return out
}

// envKey returns the key of KEY=VAL. An entry without = has no key and the
// caller drops it.
func envKey(kv string) string {
	for i := 0; i < len(kv); i++ {
		if kv[i] == '=' {
			return kv[:i]
		}
	}
	return ""
}

// compatEnv returns the compat entries to inject.
func (c *Config) compatEnv() []string {
	if c.NoAltScreenCompat {
		return nil
	}
	return altScreenCompat
}

// shellArgs returns the shell arguments. The shell starts normally with nothing
// injected (ADR-0026 §6).
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

// Manager owns sid allocation, the session table, limits, and lifecycle.
type Manager struct {
	cfg Config

	// instanceID is a random id for this process start.
	//
	// sids are uint16 and restart from 1 after a restart. Without an instance
	// id, resume{sid:1, out_seq:large} would silently attach, as a delta or
	// snapshot, to an unrelated new session.
	instanceID string

	mu       sync.RWMutex
	sessions map[uint16]*Session
	// order is the display order (ADR-0040): new sessions go last, closed
	// ones are removed, Move rearranges. It holds only started sessions, not
	// Create's nil placeholders.
	order []uint16
	// orderMu makes Move and its broadcast one step; see Move. It is separate
	// from mu so List and Get keep working during the broadcast.
	orderMu sync.Mutex

	nextSID   uint16
	observers map[Subscriber]struct{}
	// generation counts hot upgrades, +1 per handoff (ADR-0016). webterm
	// reload uses it to tell that the new process has taken over.
	generation int
	frozen     bool // Create is refused while frozen
	// handoffMu keeps changes out of a hot-upgrade snapshot's way: Freeze
	// takes it for writing and holds it until Thaw (or exec); Close, Rename
	// and Move hold it for reading. A change made after Export would be lost
	// with the old process, so they wait instead. If the upgrade goes ahead,
	// the request goes down with its connection and the client sees the real
	// state in the next welcome.
	handoffMu sync.RWMutex

	// inputOwner is each client_id's newest connection (set on hello). A page
	// holds one socket at a time, so an older connection with the same
	// client_id is one the page has abandoned; when it finally ends it must
	// not discard input the newer connection queued (see Detach). ownerMu
	// guards it and makes Resume's and Detach's drops atomic with the
	// ownership check, so they can't interleave.
	ownerMu    sync.Mutex
	inputOwner map[string]Subscriber

	shutdownOnce sync.Once
}

// NewManager returns a session manager.
func NewManager(cfg Config) *Manager {
	cfg.withDefaults()
	var b [8]byte
	_, _ = rand.Read(b[:])
	return &Manager{
		cfg:        cfg,
		instanceID: hex.EncodeToString(b[:]),
		sessions:   make(map[uint16]*Session),
		observers:  make(map[Subscriber]struct{}),
		inputOwner: make(map[string]Subscriber),
		nextSID:    1, // 0 is reserved as invalid
	}
}

// InstanceID returns this process's instance id (sent in welcome).
func (m *Manager) InstanceID() string { return m.instanceID }

// AddObserver registers a connection.
//
// Subscribing and observing are separate. Subscribing (Session.Subscribe)
// controls OUTPUT / SNAPSHOT frames; observing controls control messages.
// Unsubscribed connections still need session.updated, since unread state is
// derived from its head_seq; sending it only to subscribers would make unread
// impossible to compute.
func (m *Manager) AddObserver(sub Subscriber) {
	m.mu.Lock()
	m.observers[sub] = struct{}{}
	m.mu.Unlock()
}

// RemoveObserver unregisters a connection.
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

// fanout sends a control message to every connection.
func (m *Manager) fanout(msg any) {
	for _, o := range m.observerList() {
		o.Event(msg)
	}
}

// fanoutTo sends only to one client's connections (acks are per client).
func (m *Manager) fanoutTo(clientID string, msg any) {
	for _, o := range m.observerList() {
		if o.ClientID() == clientID {
			o.Event(msg)
		}
	}
}

// Limits returns the limits reported in welcome.
func (m *Manager) Limits() protocol.Limits {
	return protocol.Limits{
		MaxSessions:   m.cfg.MaxSessions,
		RingBytes:     m.cfg.RingBytes,
		MaxFrameBytes: protocol.MaxPayload,
	}
}

// Spec holds the parameters for a new session.
type Spec struct {
	Name *string
	CWD  string
	Cols uint16
	Rows uint16
}

// Create starts a new session.
func (m *Manager) Create(spec Spec) (*Session, error) {
	if !validSize(spec.Cols, spec.Rows) {
		return nil, ErrBadSize
	}
	cwd := spec.CWD
	if cwd == "" {
		cwd, _ = os.UserHomeDir()
	}
	if fi, err := os.Stat(cwd); err != nil || !fi.IsDir() {
		return nil, fmt.Errorf("session: cwd is not a directory: %s", spec.CWD)
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
	m.sessions[sid] = nil // placeholder so concurrent Creates don't collide
	m.mu.Unlock()

	s, err := m.start(sid, spec, cwd)
	if err != nil {
		m.mu.Lock()
		delete(m.sessions, sid)
		m.mu.Unlock()
		return nil, err
	}
	m.mu.Lock()
	if m.frozen {
		// A hot upgrade started while the shell was starting. Freeze and Export
		// never saw this session, so nobody would take it over.
		delete(m.sessions, sid)
		m.mu.Unlock()
		s.close()
		return nil, ErrFrozen
	}
	m.sessions[sid] = s
	m.order = append(m.order, sid) // new sessions go last
	m.mu.Unlock()
	return s, nil
}

// allocSIDLocked allocates a sid: increment, skip values in use, and wrap to 1.
// Freshly released sids are not reused right away, so a new session can't
// take sid 3 while a client is still processing the close of the old sid 3.
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
	return 0, errors.New("session: sid space exhausted")
}

func (m *Manager) start(sid uint16, spec Spec, cwd string) (*Session, error) {
	cmd := exec.Command(m.cfg.Shell, m.cfg.shellArgs()...)
	cmd.Dir = cwd
	// Session environment (AC-7.8): drop the two inherited keys that interfere
	// with shell startup, then layer the compat list, --session-env, and
	// webterm's own keys. See buildEnv for precedence.
	cmd.Env = buildEnv(
		filterEnv(os.Environ(), "BASH_ENV", "ENV"),
		m.cfg.compatEnv(),
		m.cfg.SessionEnv,
		[]string{
			"TERM=xterm-256color", // closest match to xterm.js, which also answers queries
			fmt.Sprintf("WEBTERM_SESSION=%d", sid),
		},
	)

	// When the agent runs at -900, the shell must be at 0 before any user code
	// runs (ADR-0034 §3).
	var raw *os.File
	err := withChildOOMAdj(func() (err error) {
		raw, err = pty.StartWithSize(cmd, &pty.Winsize{Cols: spec.Cols, Rows: spec.Rows})
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("session: start PTY: %w", err)
	}
	// Switch to a pollable master (ADR-0016). creack/pty returns a blocking
	// file that ignores SetReadDeadline, so a hot upgrade couldn't interrupt a
	// blocked read. Dup it, set O_NONBLOCK, and wrap it with os.NewFile to put
	// it in Go's poller. Closing the original is safe: the dup keeps the file
	// description open, so the shell gets no SIGHUP.
	ptmx, fd, err := pollable(raw)
	if err != nil {
		_ = raw.Close()
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("session: wrap PTY: %w", err)
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

// pollable replaces creack/pty's blocking master with a non-blocking file in
// Go's poller. It returns the new file and its fd number, which callers keep
// separately because Fd() must never be called on the file afterward.
//
// The dup must be CLOEXEC. A plain dup would be inherited by every later shell
// and its descendants, and a closed session's pty would never be released.
func pollable(raw *os.File) (*os.File, int, error) {
	fd, err := unix.FcntlInt(raw.Fd(), unix.F_DUPFD_CLOEXEC, 0)
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
		return nil, -1, errors.New("os.NewFile failed")
	}
	_ = raw.Close()
	return f, fd, nil
}

// Get returns the session with the given sid.
func (m *Manager) Get(sid uint16) (*Session, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.sessions[sid]
	return s, ok && s != nil
}

// List returns all sessions in display order (ADR-0040).
func (m *Manager) List() []*Session {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]*Session, 0, len(m.order))
	for _, sid := range m.order {
		if s := m.sessions[sid]; s != nil {
			out = append(out, s)
		}
	}
	return out
}

// Order returns the display order as a list of sids.
func (m *Manager) Order() []uint16 {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return slices.Clone(m.order)
}

// Move moves session sid in front of before (protocol §4.1 session.move,
// ADR-0040). A nil or missing before (say, just closed elsewhere) moves it to
// the end; before == sid is a no-op. An unknown sid returns ErrUnknownSession
// without calling publish.
//
// On success, even if nothing moved, publish receives the full new order to
// broadcast as session.order. Reordering and broadcasting happen under one
// lock: if two devices drag at once and their broadcasts interleave, a
// connection could receive the later order before the earlier one and end up
// on an order the agent no longer has. publish must not block or call Move
// (the connection's Event only enqueues and closes the connection when full).
func (m *Manager) Move(sid uint16, before *uint16, publish func(order []uint16)) error {
	m.handoffMu.RLock()
	defer m.handoffMu.RUnlock()
	m.orderMu.Lock()
	defer m.orderMu.Unlock()

	m.mu.Lock()
	if s, ok := m.sessions[sid]; !ok || s == nil {
		m.mu.Unlock()
		return ErrUnknownSession
	}
	if before == nil || *before != sid {
		m.order = moveBefore(m.order, sid, before)
	}
	order := slices.Clone(m.order)
	m.mu.Unlock()

	if publish != nil {
		publish(order)
	}
	return nil
}

// moveBefore returns order with sid moved in front of before, or to the end if
// before is nil or not in the list.
func moveBefore(order []uint16, sid uint16, before *uint16) []uint16 {
	out := make([]uint16, 0, len(order)+1)
	for _, v := range order {
		if v != sid {
			out = append(out, v)
		}
	}
	at := len(out)
	if before != nil {
		if i := slices.Index(out, *before); i >= 0 {
			at = i
		}
	}
	return slices.Insert(out, at, sid)
}

// removeOrderLocked removes sid from the display order. The caller holds m.mu.
func (m *Manager) removeOrderLocked(sid uint16) {
	if i := slices.Index(m.order, sid); i >= 0 {
		m.order = slices.Delete(m.order, i, i+1)
	}
}

// Infos returns metadata for all sessions (welcome.sessions[]) in display
// order.
func (m *Manager) Infos() []protocol.SessionInfo {
	list := m.List()
	out := make([]protocol.SessionInfo, 0, len(list))
	for _, s := range list {
		out = append(out, s.Info())
	}
	return out
}

// Close ends and removes a session.
//
// A running session gets SIGHUP, then SIGKILL after 2 seconds; an exited one is
// released immediately.
func (m *Manager) Close(sid uint16) (*int, error) {
	m.handoffMu.RLock()
	defer m.handoffMu.RUnlock()
	m.mu.Lock()
	s, ok := m.sessions[sid]
	if !ok || s == nil {
		m.mu.Unlock()
		return nil, ErrUnknownSession
	}
	delete(m.sessions, sid)
	m.removeOrderLocked(sid)
	m.mu.Unlock()

	s.close()
	s.mu.RLock()
	code := s.exitCode
	s.mu.RUnlock()
	return code, nil
}

// Resume handles the resume requests in hello. For each it decides ok,
// snapshot, or gone per protocol §5.1 and subscribes sub immediately, which
// enqueues the catch-up frames. It returns welcome.resumed[].
//
// Deciding and enqueueing must be one step (see Session.Subscribe), so getting
// welcome ahead of those frames is the connection layer's job: it holds its
// write queue before calling Resume and releases it after enqueueing welcome.
//
// This is the riskiest logic in the project, so it depends on neither the
// network nor a browser; IT-resume-* call it directly.
func (m *Manager) Resume(sub Subscriber, instanceID string, reqs []protocol.ResumeReq) []protocol.ResumeResult {
	out := make([]protocol.ResumeResult, 0, len(reqs))
	clientID := sub.ClientID()
	// sub is now this client's connection. Drop the client's
	// queued-but-unwritten input in every session, as if its previous
	// connection had ended now: the client resends it, from in_ack for the
	// sessions below and as is for the others (protocol §5.4). Dropping it
	// before reporting in_ack matters too: otherwise in_ack is too low and the
	// resend duplicates bytes still waiting to be written.
	m.ownerMu.Lock()
	m.inputOwner[clientID] = sub
	for _, s := range m.List() {
		s.DetachClient(clientID)
	}
	m.ownerMu.Unlock()
	// A different instance_id means the agent restarted and every sid is void.
	restarted := instanceID != "" && instanceID != m.instanceID
	for _, r := range reqs {
		res := protocol.ResumeResult{SID: r.SID}
		s, ok := m.Get(r.SID)
		if restarted || !ok {
			res.Status = protocol.ResumeGone
			out = append(out, res)
			continue
		}
		res.InAck = s.InAck(clientID)
		res.Status, res.FromSeq = s.Subscribe(sub, r.OutSeq, 0, 0)
		out = append(out, res)
	}
	return out
}

// Detach is called when a connection ends: it leaves every session's
// subscriber set and, if it is still its client's newest connection, discards
// the client's queued-but-unwritten input (protocol §5.4).
//
// An abandoned connection can end long after its page reconnected (the
// browser gave up on it without a close reaching us, so it lingers until the
// idle timeout). By then the input queue holds what the new connection sent;
// discarding it would leave the client's next bytes looking like a gap.
func (m *Manager) Detach(sub Subscriber) {
	for _, s := range m.List() {
		s.Unsubscribe(sub)
	}
	clientID := sub.ClientID()
	m.ownerMu.Lock()
	defer m.ownerMu.Unlock()
	if clientID == "" || m.inputOwner[clientID] != sub {
		return
	}
	delete(m.inputOwner, clientID)
	for _, s := range m.List() {
		s.DetachClient(clientID)
	}
}

// Rename renames a session (protocol §4.1 session.rename); see handoffMu for
// why it goes through the manager.
func (m *Manager) Rename(sid uint16, name *string) error {
	m.handoffMu.RLock()
	defer m.handoffMu.RUnlock()
	s, ok := m.Get(sid)
	if !ok {
		return ErrUnknownSession
	}
	s.Rename(name)
	return nil
}

// Busy returns how many sessions are running a command, meaning the PTY's
// foreground process group is not the shell itself (see Session.busy).
// --when-idle uses it to wait until every session is at a prompt.
func (m *Manager) Busy() int {
	n := 0
	for _, s := range m.List() {
		if s.busy() {
			n++
		}
	}
	return n
}

// Shutdown closes all sessions. It is idempotent; both the SIGTERM handler and
// a defer call it.
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
	m.order = nil
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
