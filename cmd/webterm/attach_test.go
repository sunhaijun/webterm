package main

// Integration tests for webterm attach (ADR-0050): the real client, run as a
// child process on a PTY of a chosen size, as ssh -t would give it, against a
// real agent (sessions, attach socket) in this process.

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/creack/pty"
	"github.com/sunhaijun/webterm/internal/agent"
	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/session"
	"github.com/sunhaijun/webterm/internal/store"
	"github.com/sunhaijun/webterm/internal/vterm"
)

// TestMain lets the test binary stand in for webterm: a child started with
// WEBTERM_TEST_MAIN=1 runs main with its arguments.
func TestMain(m *testing.M) {
	if os.Getenv("WEBTERM_TEST_MAIN") == "1" {
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

type attachAgent struct {
	t       *testing.T
	dataDir string
	m       *session.Manager
	a       *agent.Agent
}

func newAttachAgent(t *testing.T) *attachAgent {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "run"), 0o700); err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	m := session.NewManager(session.Config{
		MaxSessions: 5, RingBytes: 64 << 10, Shell: "bash",
		ShellArgs:       []string{"--norc", "--noprofile", "-i"},
		CWDPollInterval: 100 * time.Millisecond,
	})
	t.Cleanup(m.Shutdown)
	a := agent.New(agent.Config{Dev: true, MaxConns: 16, Version: "test"}, st, m)
	att, err := a.ServeAttach(attachSocketPath(dir))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		a.Hub().CloseAll()
		att.Close()
	})
	return &attachAgent{t: t, dataDir: dir, m: m, a: a}
}

// create starts a session named name (empty keeps automatic naming).
func (g *attachAgent) create(name string) *session.Session {
	g.t.Helper()
	s, err := g.m.Create(session.Spec{CWD: g.t.TempDir(), Cols: 80, Rows: 24})
	if err != nil {
		g.t.Fatal(err)
	}
	if name != "" {
		s.Rename(&name)
	}
	waitUntil(g.t, "shell ready", func() bool { return s.HeadSeq() > 0 })
	return s
}

// screenOf renders a session's emulator, as a client of its size would show it.
func screenOf(s *session.Session) string {
	info := s.Info()
	_, snap := s.TermSnapshot()
	v := vterm.New(int(info.Cols), int(info.Rows))
	v.Write(snap)
	return v.String()
}

// attachEnv is the child's environment: never the developer's own webterm
// session or config.
func attachEnv(t *testing.T, self string) []string {
	var env []string
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "WEBTERM_SESSION=") || strings.HasPrefix(kv, "XDG_CONFIG_HOME=") {
			continue
		}
		env = append(env, kv)
	}
	return append(env, "WEBTERM_TEST_MAIN=1", "WEBTERM_SESSION="+self, "XDG_CONFIG_HOME="+t.TempDir())
}

// attachProc is webterm attach running on a PTY.
type attachProc struct {
	t    *testing.T
	cmd  *exec.Cmd
	pty  *os.File
	done chan struct{}

	mu      sync.Mutex
	out     bytes.Buffer
	resizes []resizeAt // where in the output the terminal changed size
	exitErr error
}

type resizeAt struct {
	off        int
	cols, rows int
}

func (g *attachAgent) attach(cols, rows int, self string, args ...string) *attachProc {
	g.t.Helper()
	exe, err := os.Executable()
	if err != nil {
		g.t.Fatal(err)
	}
	cmd := exec.Command(exe, append([]string{"attach", "--data-dir", g.dataDir}, args...)...)
	cmd.Env = attachEnv(g.t, self)
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		g.t.Fatal(err)
	}
	p := &attachProc{t: g.t, cmd: cmd, pty: f, done: make(chan struct{}), resizes: []resizeAt{{0, cols, rows}}}
	go func() {
		buf := make([]byte, 32<<10)
		for {
			n, err := f.Read(buf)
			p.mu.Lock()
			p.out.Write(buf[:n])
			p.mu.Unlock()
			if err != nil {
				break
			}
		}
		werr := cmd.Wait()
		p.mu.Lock()
		p.exitErr = werr
		p.mu.Unlock()
		close(p.done)
	}()
	g.t.Cleanup(func() {
		_ = cmd.Process.Kill()
		f.Close()
		<-p.done
	})
	return p
}

func (p *attachProc) output() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.out.String()
}

func (p *attachProc) waitOutput(sub string) {
	p.t.Helper()
	waitUntil(p.t, fmt.Sprintf("attach output contains %q", sub), func() bool { return strings.Contains(p.output(), sub) })
}

func (p *attachProc) typeIn(s string) {
	p.t.Helper()
	if _, err := p.pty.Write([]byte(s)); err != nil {
		p.t.Fatal(err)
	}
}

// setSize changes the PTY's size; the kernel sends the child SIGWINCH.
func (p *attachProc) setSize(cols, rows int) {
	p.t.Helper()
	p.mu.Lock()
	p.resizes = append(p.resizes, resizeAt{p.out.Len(), cols, rows})
	p.mu.Unlock()
	if err := pty.Setsize(p.pty, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)}); err != nil {
		p.t.Fatal(err)
	}
}

// screen renders what the local terminal shows: everything the client wrote,
// fed to a fresh emulator that changes size where the PTY did.
func (p *attachProc) screen() string {
	p.mu.Lock()
	out := append([]byte(nil), p.out.Bytes()...)
	rs := append([]resizeAt(nil), p.resizes...)
	p.mu.Unlock()
	v := vterm.New(rs[0].cols, rs[0].rows)
	pos := 0
	for _, r := range rs[1:] {
		end := min(r.off, len(out))
		v.Write(out[pos:end])
		pos = end
		v.Resize(r.cols, r.rows)
	}
	v.Write(out[pos:])
	return v.String()
}

// exit waits for the child to end and returns its exit status.
func (p *attachProc) exit() int {
	p.t.Helper()
	select {
	case <-p.done:
	case <-time.After(15 * time.Second):
		p.t.Fatalf("attach didn't exit; output:\n%q", p.output())
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	var ee *exec.ExitError
	if errors.As(p.exitErr, &ee) {
		return ee.ExitCode()
	}
	if p.exitErr != nil {
		p.t.Fatal(p.exitErr)
	}
	return 0
}

func (p *attachProc) running() bool {
	select {
	case <-p.done:
		return false
	default:
		return true
	}
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for: %s", what)
}

// waitScreens waits until the attached terminal shows the session's screen.
func waitScreens(t *testing.T, p *attachProc, s *session.Session) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	var got, want string
	for time.Now().Before(deadline) {
		got, want = p.screen(), screenOf(s)
		if got == want {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("attached screen differs from the session's\nattach:\n%s\nsession:\n%s", got, want)
}

func sessionSize(s *session.Session) [2]uint16 {
	i := s.Info()
	return [2]uint16{i.Cols, i.Rows}
}

// runPlain runs webterm attach without a terminal.
func (g *attachAgent) runPlain(self string, args ...string) (stdout, stderr string, code int) {
	g.t.Helper()
	exe, err := os.Executable()
	if err != nil {
		g.t.Fatal(err)
	}
	cmd := exec.Command(exe, append([]string{"attach", "--data-dir", g.dataDir}, args...)...)
	cmd.Env = attachEnv(g.t, self)
	var o, e bytes.Buffer
	cmd.Stdout, cmd.Stderr = &o, &e
	err = cmd.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		code = ee.ExitCode()
	} else if err != nil {
		g.t.Fatal(err)
	}
	return o.String(), e.String(), code
}

// IT-attach-2: listing and picking (AC-1.23, ADR-0050 §4).
func TestITAttach2_Pick(t *testing.T) {
	g := newAttachAgent(t)
	alpha := g.create("alpha")
	beta := g.create("beta-build")
	g.create("gamma")

	// --list needs no terminal, in display order.
	out, _, code := g.runPlain("", "--list")
	if code != 0 {
		t.Fatalf("--list exit %d", code)
	}
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) != 3 || !strings.HasPrefix(lines[0], "  1  alpha  ") || !strings.HasPrefix(lines[1], "  2  beta-build  ") || !strings.HasPrefix(lines[2], "  3  gamma  ") {
		t.Fatalf("--list:\n%s", out)
	}

	// Anything else needs a terminal.
	_, errOut, code := g.runPlain("")
	if code != 1 || !strings.Contains(errOut, "ssh -t") {
		t.Fatalf("no terminal: exit %d, stderr %q", code, errOut)
	}

	// No match: an error and the list.
	_, errOut, code = g.runPlain("", "--list=false", "nope")
	if code != 1 || !strings.Contains(errOut, `no session matches "nope"`) || !strings.Contains(errOut, "beta-build") {
		t.Fatalf("no match: exit %d, stderr %q", code, errOut)
	}

	// Several sessions, no argument: the prompt takes a number.
	p := g.attach(100, 30, "")
	p.waitOutput("Session [1-3, n = new]: ")
	p.typeIn("9\r") // not listed: asked again
	waitUntil(t, "prompt repeated", func() bool { return strings.Count(p.output(), "Session [1-3, n = new]: ") == 2 })
	p.typeIn("2\r")
	waitScreens(t, p, beta)
	p.typeIn("echo picked-$((1+1))\r")
	waitUntil(t, "input reached beta", func() bool { return strings.Contains(screenOf(beta), "picked-2") })
	if strings.Contains(screenOf(alpha), "picked") {
		t.Fatal("input reached the wrong session")
	}

	// A name argument: a case-insensitive substring.
	q := g.attach(100, 30, "", "BUILD")
	waitScreens(t, q, beta)

	// --new creates a session that every client sees.
	before := len(g.m.List())
	r := g.attach(90, 20, "", "--new")
	waitUntil(t, "a fourth session", func() bool { return len(g.m.List()) == before+1 })
	created := g.m.List()[before]
	waitScreens(t, r, created)
	if got := sessionSize(created); got != [2]uint16{90, 20} {
		t.Fatalf("new session size %v, want the terminal's 90x20", got)
	}
}

// IT-attach-3: the attached terminal shows the session's screen, after
// output and after a column change (AC-1.23).
func TestITAttach3_Screen(t *testing.T) {
	g := newAttachAgent(t)
	s := g.create("screen")
	if err := s.Write("other", 0, []byte(`for i in $(seq 1 60); do printf '\e[3%dmline %02d\e[0m %s\n' $((i%8)) $i "日本語テキスト"; done`+"\r")); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "output done", func() bool { return strings.Contains(screenOf(s), "line 60") })

	p := g.attach(100, 30, "", "screen")
	waitScreens(t, p, s)
	if !strings.HasPrefix(p.output(), titlePushForTest) {
		t.Fatalf("output doesn't start by saving the title: %q", p.output()[:min(20, len(p.output()))])
	}

	// More output, then a full-screen program on the alternate screen.
	p.typeIn(`printf '\e[?1049h\e[2J\e[5;10Hfull screen\e[10;1Hbottom'; sleep 30` + "\r")
	waitUntil(t, "alternate screen", func() bool { return strings.Contains(screenOf(s), "full screen") })
	waitScreens(t, p, s)

	// Narrower terminal: the column change redraws from a snapshot.
	p.setSize(70, 24)
	waitUntil(t, "session follows the terminal", func() bool { return sessionSize(s) == [2]uint16{70, 24} })
	waitScreens(t, p, s)
	p.typeIn("\x03")
}

const titlePushForTest = "\x1b[22;0t"

// IT-attach-4: input reaches the session; the size follows the user, not
// the terminal's reports (AC-4.14).
func TestITAttach4_InputAndSize(t *testing.T) {
	g := newAttachAgent(t)
	s := g.create("size")

	p := g.attach(100, 30, "", "size")
	waitUntil(t, "attach claims its size", func() bool { return sessionSize(s) == [2]uint16{100, 30} })
	p.typeIn("stty size\r")
	waitUntil(t, "stty size in the session", func() bool { return strings.Contains(screenOf(s), "30 100") })

	// Another client takes the size.
	if err := s.Resize(120, 40); err != nil {
		t.Fatal(err)
	}
	// A terminal report on stdin doesn't take it back...
	p.typeIn("\x1b[5;1R")
	time.Sleep(500 * time.Millisecond)
	if got := sessionSize(s); got != [2]uint16{120, 40} {
		t.Fatalf("a CPR report claimed the size: %v", got)
	}
	// ...a keystroke does.
	p.typeIn("\x15") // Ctrl+U, also clears the report bash took as input
	waitUntil(t, "a keystroke claims the size", func() bool { return sessionSize(s) == [2]uint16{100, 30} })

	// SIGWINCH from the terminal claims the new size.
	p.setSize(90, 20)
	waitUntil(t, "SIGWINCH claims", func() bool { return sessionSize(s) == [2]uint16{90, 20} })
	p.typeIn("stty size\r")
	waitUntil(t, "stty size after SIGWINCH", func() bool { return strings.Contains(screenOf(s), "20 90") })
}

// IT-attach-5: a dropped connection reconnects; input typed meanwhile
// arrives exactly once.
func TestITAttach5_Reconnect(t *testing.T) {
	g := newAttachAgent(t)
	s := g.create("re")
	p := g.attach(100, 30, "", "re")
	waitScreens(t, p, s)

	for i := range 3 {
		g.a.Hub().CloseAll()
		p.typeIn(fmt.Sprintf("echo again-$((%d+100))\r", i))
	}
	waitUntil(t, "all three ran", func() bool { return strings.Contains(screenOf(s), "again-102") })
	waitScreens(t, p, s)
	scr := screenOf(s)
	for i := range 3 {
		want := fmt.Sprintf("again-%d", 100+i)
		if n := countLines(scr, want); n != 1 {
			t.Fatalf("%s ran %d times\n%s", want, n, scr)
		}
	}
	if !p.running() {
		t.Fatal("attach exited instead of reconnecting")
	}
}

func countLines(screen, line string) int {
	n := 0
	for _, l := range strings.Split(screen, "\n") {
		if strings.TrimRight(l, " ") == line {
			n++
		}
	}
	return n
}

// IT-attach-6: the session's shell exits; Enter closes it, another key
// leaves it. Closing the terminal detaches and the session keeps running.
func TestITAttach6_ExitAndDetach(t *testing.T) {
	g := newAttachAgent(t)

	a := g.create("a")
	p := g.attach(80, 24, "", "a")
	waitScreens(t, p, a)
	p.typeIn("exit 3\r")
	p.waitOutput("[Exited (code 3) · Enter to close]")
	p.typeIn("\r")
	if code := p.exit(); code != 0 {
		t.Fatalf("exit status %d", code)
	}
	waitUntil(t, "Enter closed the session", func() bool {
		_, ok := g.m.Get(a.SID())
		return !ok
	})
	if out := p.output(); !strings.HasSuffix(out, exitResetForTest+"\x1b[23;0t") {
		t.Fatalf("output doesn't end with the exit reset and title restore: %q", out[max(0, len(out)-120):])
	}

	b := g.create("b")
	q := g.attach(80, 24, "", "b")
	waitScreens(t, q, b)
	q.typeIn("exit 0\r")
	q.waitOutput("[Exited (code 0) · Enter to close]")
	q.typeIn("x")
	if code := q.exit(); code != 0 {
		t.Fatalf("exit status %d", code)
	}
	if b.Status() != protocol.StatusExited {
		t.Fatal("another key must leave the session")
	}
	if _, ok := g.m.Get(b.SID()); !ok {
		t.Fatal("the exited session was removed")
	}

	// ssh going away: sshd hangs up the terminal and the client gets
	// SIGHUP. It ends; the session keeps running. (Closing the PTY here
	// wouldn't hang it up: a Read in flight keeps the fd open.)
	c := g.create("c")
	r := g.attach(80, 24, "", "c")
	waitScreens(t, r, c)
	if err := r.cmd.Process.Signal(syscall.SIGHUP); err != nil {
		t.Fatal(err)
	}
	if code := r.exit(); code != 0 {
		t.Fatalf("exit status after hangup %d", code)
	}
	if c.Status() != protocol.StatusRunning {
		t.Fatal("the session ended with the terminal")
	}
}

// exitResetForTest mirrors the client's exit sequence; the test pins it.
var exitResetForTest = "\x1b[?1049l" +
	"\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l" +
	"\x1b[?1004l\x1b[?2004l\x1b[?2026l\x1b[?1l\x1b>\x1b[<99u\x1b[>4m\x1b[r\x1b[?6l\x1b[?7h\x1b[?25h\x1b[0 q\x1b[0m\x1b(B\x0f" +
	"\x1b[999;1H\r\n"

// IT-attach-7: attaching to the session the command runs in is refused.
func TestITAttach7_Self(t *testing.T) {
	g := newAttachAgent(t)
	self := g.create("here")
	g.create("there")
	sid := fmt.Sprint(self.SID())

	p := g.attach(80, 24, sid, "1")
	if code := p.exit(); code != 1 || !strings.Contains(p.output(), "that is the session this command runs in") {
		t.Fatalf("by number: exit %d, output %q", code, p.output())
	}
	q := g.attach(80, 24, sid, "here")
	if code := q.exit(); code != 1 {
		t.Fatalf("by name: exit %d", code)
	}
	r := g.attach(80, 24, sid)
	r.waitOutput("(this session)")
	r.waitOutput("Session [2, n = new]: ")
	r.typeIn("1\r") // refused, asked again
	waitUntil(t, "asked again", func() bool { return strings.Count(r.output(), "Session [2, n = new]: ") == 2 })
	r.typeIn("q\r")
	if code := r.exit(); code != 0 {
		t.Fatalf("q: exit %d", code)
	}
}

// An agent from before attach answers on the control socket but has no
// attach socket: say to upgrade it, not that it isn't running.
func TestAttachOldAgent(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "run"), 0o700); err != nil {
		t.Fatal(err)
	}
	ctl, err := agent.ServeControl(controlSocketPath(dir), agent.ControlDeps{
		Status: func() agent.ControlStatus { return agent.ControlStatus{Version: "0.4.0"} },
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ctl.Close()
	g := &attachAgent{t: t, dataDir: dir}
	_, errOut, code := g.runPlain("", "--list")
	if code != 1 || !strings.Contains(errOut, "webterm update") {
		t.Fatalf("exit %d, stderr %q", code, errOut)
	}
}

// attnWatch observes a manager and records the attention values announced
// for one session.
type attnWatch struct {
	sid uint16
	mu  sync.Mutex
	got []bool
}

func (w *attnWatch) ClientID() string                { return "watch" }
func (w *attnWatch) Push(uint16, uint64, []byte)     {}
func (w *attnWatch) Snapshot(uint16, uint64, []byte) {}
func (w *attnWatch) Event(msg any) {
	if u, ok := msg.(*protocol.SessionUpdated); ok && u.SID == w.sid && u.Attention != nil {
		w.mu.Lock()
		w.got = append(w.got, *u.Attention)
		w.mu.Unlock()
	}
}

func (w *attnWatch) values() []bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]bool(nil), w.got...)
}

// IT-attach-8 (ADR-0052 §2): being attached is looking. A session waiting for
// you before the attach is cleared when you attach; a bell while attached is
// cleared as soon as it's announced.
func TestITAttach8_AttachedIsSeen(t *testing.T) {
	g := newAttachAgent(t)
	s := g.create("attn")
	w := &attnWatch{sid: s.SID()}
	g.m.AddObserver(w)
	t.Cleanup(func() { g.m.RemoveObserver(w) })

	if err := s.Write("other", 0, []byte(`printf '\a'`+"\r")); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "waiting before the attach", func() bool { return s.Info().Attention })

	p := g.attach(100, 30, "", "attn")
	waitUntil(t, "attaching clears it", func() bool { return !s.Info().Attention })

	p.typeIn(`printf '\a'; echo rang-2` + "\r")
	waitUntil(t, "set and cleared while attached", func() bool {
		v := w.values()
		return len(v) >= 4 && v[2] && !v[3]
	})
	if s.Info().Attention {
		t.Fatal("attention left set on the attached session")
	}
}
