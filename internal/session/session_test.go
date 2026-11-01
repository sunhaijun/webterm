package session_test

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/session"
)

// testShellArgs keeps bash from reading any dotfiles so assertions are
// deterministic. Production defaults to a login shell `-l -i` (see
// TestLoginShellByDefault).
var testShellArgs = []string{"--norc", "--noprofile", "-i"}

func cfg() session.Config {
	return session.Config{
		MaxSessions: 5, RingBytes: 64 << 10, Shell: "bash", ShellArgs: testShellArgs,
		CWDPollInterval: 100 * time.Millisecond,
	}
}

func create(t *testing.T, m *session.Manager) *session.Session {
	t.Helper()
	s, err := m.Create(session.Spec{CWD: t.TempDir(), Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// IT-session-1: sessions have independent PTYs, buffers, and seqs.
func TestITSession1_Independence(t *testing.T) {
	m := newManager(t, cfg())
	a, b := create(t, m), create(t, m)
	if a.SID() == b.SID() {
		t.Fatal("two sessions got the same sid")
	}

	ca, cb := newConn(t, m, "tab-a"), newConn(t, m, "tab-b")
	a.Subscribe(ca, 0, 0, 0)
	b.Subscribe(cb, 0, 0, 0)

	if err := a.Write("tab-a", 0, []byte("echo AAA-marker\r")); err != nil {
		t.Fatal(err)
	}
	if err := b.Write("tab-b", 0, []byte("echo BBB-marker\r")); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, ca, "AAA-marker")
	waitScreen(t, cb, "BBB-marker")

	if strings.Contains(ca.Screen(), "BBB-marker") {
		t.Error("session A output contains session B content")
	}
	if strings.Contains(cb.Screen(), "AAA-marker") {
		t.Error("session B output contains session A content")
	}
	// Seqs are independent: the two head_seqs are unrelated.
	if a.HeadSeq() == 0 || b.HeadSeq() == 0 {
		t.Fatal("head_seq did not advance")
	}
}

// IT-session-2: session limit.
func TestITSession2_Limit(t *testing.T) {
	c := cfg()
	c.MaxSessions = 2
	m := newManager(t, c)
	create(t, m)
	create(t, m)
	_, err := m.Create(session.Spec{CWD: t.TempDir(), Cols: 80, Rows: 24})
	if err != session.ErrSessionLimit {
		t.Fatalf("err = %v, want ErrSessionLimit", err)
	}
	// Closing one makes room for another.
	if _, err := m.Close(m.List()[0].SID()); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Create(session.Spec{CWD: t.TempDir(), Cols: 80, Rows: 24}); err != nil {
		t.Fatalf("still cannot create after closing one: %v", err)
	}
}

// IT-session-3: the working directory is read from
// /proc/<foreground process group>/cwd once a second, and session.updated{cwd,
// name} is sent only on change. The automatic name follows CWD until a manual
// rename (AC-4.4).
//
// It works with any shell: this bash loads no dotfiles and has no shell
// integration at all.
func TestITSession3_CWDPollingAndAutoNaming(t *testing.T) {
	m := newManager(t, cfg())
	dir := t.TempDir()
	sub := dir + "/myproject"
	other := dir + "/other"
	for _, d := range []string{sub, other} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	s, err := m.Create(session.Spec{CWD: sub, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	if got := s.Info().Name; got != "myproject" {
		t.Fatalf("default name = %q, want the directory basename", got)
	}
	if s.Info().NameIsManual {
		t.Fatal("default name should not be manual")
	}
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0, 0, 0)

	// cd in the shell: the agent reads it from /proc and the name follows.
	if err := c.Send(s, "cd "+other+"\r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "session.updated{cwd, name}", func() bool {
		for _, e := range c.Events() {
			if u, ok := e.(*protocol.SessionUpdated); ok && u.SID == s.SID() &&
				u.CWD != nil && *u.CWD == other && u.Name != nil && *u.Name == "other" {
				return true
			}
		}
		return false
	})
	if info := s.Info(); info.CWD != other || info.Name != "other" {
		t.Fatalf("info = %+v", info)
	}

	// No change, no message: polling once a second must not mean a message
	// once a second.
	count := func() int {
		n := 0
		for _, e := range c.Events() {
			if u, ok := e.(*protocol.SessionUpdated); ok && u.CWD != nil {
				n++
			}
		}
		return n
	}
	before := count()
	time.Sleep(500 * time.Millisecond) // 5 poll intervals
	if got := count(); got != before {
		t.Fatalf("sent %d more cwd updates without a directory change", got-before)
	}

	// The foreground program's directory: the user is wherever the running
	// command is.
	if err := c.Send(s, "(cd "+sub+" && exec sleep 30)\r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "foreground command directory is read", func() bool { return s.Info().CWD == sub })
	if err := c.Send(s, "\x03"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "directory follows the shell back at the prompt", func() bool { return s.Info().CWD == other })

	manual := "构建"
	s.Rename(&manual)
	info := s.Info()
	if info.Name != manual || !info.NameIsManual {
		t.Fatalf("after rename = %+v", info)
	}
	// A manual name does not follow CWD.
	if err := c.Send(s, "cd "+sub+"\r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "cwd catches up", func() bool { return s.Info().CWD == sub })
	if got := s.Info().Name; got != manual {
		t.Fatalf("manual name was changed by CWD: %q", got)
	}
	// nil restores automatic naming.
	s.Rename(nil)
	if info := s.Info(); info.Name != "myproject" || info.NameIsManual {
		t.Fatalf("after restoring automatic = %+v", info)
	}
}

// IT-session-6: a terminal title set by the foreground program becomes the
// automatic name (AC-4.4, ADR-0043).
//
// A title the shell sets at the prompt is ignored; one the foreground program
// sets is used; when the program exits the name returns to the directory. A
// newly started program doesn't inherit the previous title, and an identical
// title set again is still recognized (by write count, not content). A manual
// name wins.
func TestITSession6_TerminalTitleAutoNaming(t *testing.T) {
	m := newManager(t, cfg())
	dir := t.TempDir() + "/proj"
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	s, err := m.Create(session.Spec{CWD: dir, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0, 0, 0)
	waitFor(t, "shell ready", func() bool { return s.HeadSeq() > 0 })
	name := func() string { return s.Info().Name }
	stays := func(what, want string) {
		t.Helper()
		for range 5 { // 5 poll intervals
			time.Sleep(100 * time.Millisecond)
			if got := name(); got != want {
				t.Fatalf("%s: name = %q, want %q", what, got, want)
			}
		}
	}

	// Set by the shell itself (printf is a builtin, so the shell is in the
	// foreground): ignored.
	if err := c.Send(s, `printf '\033]0;SHELL TITLE\007'`+"\r"); err != nil {
		t.Fatal(err)
	}
	stays("title set by the shell", "proj")

	// Set by the foreground program: used, and session.updated{name} is sent.
	prog := `bash -c 'printf "\033]0;PROG TITLE\007"; exec sleep 30'` + "\r"
	if err := c.Send(s, prog); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "name becomes the program's title", func() bool { return name() == "PROG TITLE" })
	waitFor(t, "session.updated{name} sent", func() bool {
		for _, e := range c.Events() {
			if u, ok := e.(*protocol.SessionUpdated); ok && u.Name != nil && *u.Name == "PROG TITLE" {
				return true
			}
		}
		return false
	})
	if s.Info().NameIsManual {
		t.Fatal("a title is not a manual name")
	}

	// A manual name wins; restoring automatic brings back the title (the
	// program is still in the foreground).
	manual := "构建"
	s.Rename(&manual)
	stays("manual name", manual)
	s.Rename(nil)
	if got := name(); got != "PROG TITLE" {
		t.Fatalf("after restoring automatic = %q", got)
	}

	// Program exits, back at the prompt: back to the directory name.
	if err := c.Send(s, "\x03"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "back to the directory name", func() bool { return name() == "proj" })

	// A new program that sets no title doesn't inherit the previous one.
	if err := c.Send(s, "sleep 30\r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "sleep in the foreground", func() bool { return s.Info().CWD == dir && session.BusyForTest(s) })
	stays("new program without a title", "proj")
	if err := c.Send(s, "\x03"); err != nil {
		t.Fatal(err)
	}

	// A new program setting an identical title is recognized.
	if err := c.Send(s, prog); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "identical title set again is used", func() bool { return name() == "PROG TITLE" })
	if err := c.Send(s, "\x03"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "back to the directory name again", func() bool { return name() == "proj" })
}

// IT-session-4: when the shell exits, the status becomes exited with the exit
// code, and the buffer stays viewable (AC-4.5).
func TestITSession4_ExitedKeepsBuffer(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0, 0, 0)

	if err := c.Send(s, "echo before-exit\rexit 3\r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "session exit", func() bool { return s.Status() == protocol.StatusExited })

	info := s.Info()
	if info.ExitCode == nil || *info.ExitCode != 3 {
		t.Fatalf("exit code = %v, want 3", info.ExitCode)
	}
	// Buffer kept: switching away and back still shows output from before the
	// exit.
	if !strings.Contains(c.Screen(), "before-exit") {
		t.Fatal("output from before the exit was lost")
	}
	// Emulator kept: subscribing to an exited session still yields a snapshot
	// (a page reload can still scroll back to the last error).
	replay := newConn(t, m, "tab2")
	if st, _ := s.Subscribe(replay, 0, 0, 0); st != protocol.ResumeSnapshot {
		t.Fatalf("status = %q, want snapshot", st)
	}
	if !strings.Contains(render(replay, 80, 24), "before-exit") {
		t.Fatal("exited session snapshot lacks the pre-exit output; the last error cannot be reviewed")
	}
	// An exited session still supports incremental resume (the ring is kept).
	incr := newConn(t, m, "tab3")
	if st, _ := s.Subscribe(incr, 1, 0, 0); st != protocol.ResumeOK {
		t.Fatalf("status = %q, want ok", st)
	}
	// An exited session accepts no input.
	if err := c.Send(s, "echo nope\r"); err != session.ErrSessionExited {
		t.Fatalf("write to exited session: err = %v, want ErrSessionExited", err)
	}
}

// The exit message follows the last output. When the shell exits the kernel
// often still holds its last lines, so the agent waits for readLoop to hit EOF
// before announcing the exit. Otherwise those OUTPUT frames would follow
// session.updated{status:"exited"} and the frontend's "process exited" line
// would land above them. The message's head_seq equals the end of the last
// frame.
func TestExitedAfterLastOutput(t *testing.T) {
	for i := range 3 { // a race, so run a few rounds
		m := newManager(t, cfg())
		s := create(t, m)
		c := newConn(t, m, "tab")
		s.Subscribe(c, 0, 0, 0)
		if err := c.Send(s, `for i in $(seq 1 3000); do printf 'tail-%05d xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n' $i; done; exit 3`+"\r"); err != nil {
			t.Fatal(err)
		}
		var upd *protocol.SessionUpdated
		at := -1
		waitFor(t, "exited", func() bool {
			for j, e := range c.Timeline() {
				if u, ok := e.(*protocol.SessionUpdated); ok && u.Status != nil && *u.Status == protocol.StatusExited {
					upd, at = u, j
					return true
				}
			}
			return false
		})
		time.Sleep(200 * time.Millisecond) // give late frames a chance to show up
		tl := c.Timeline()
		var last *frameRec
		for j, e := range tl {
			f, ok := e.(frameRec)
			if !ok {
				continue
			}
			if j > at {
				t.Fatalf("round %d: frame %+v after exited; the exit was announced before output was drained", i, f)
			}
			last = &f
		}
		if upd.ExitCode == nil || *upd.ExitCode != 3 {
			t.Fatalf("exit code = %v", upd.ExitCode)
		}
		if upd.HeadSeq == nil || last == nil || *upd.HeadSeq != last.seq+uint64(last.n) {
			t.Fatalf("round %d: exited head_seq = %v, end of last frame = %d", i, upd.HeadSeq, last.seq+uint64(last.n))
		}
		if *upd.HeadSeq != s.HeadSeq() {
			t.Fatalf("head_seq = %d, session head = %d", *upd.HeadSeq, s.HeadSeq())
		}
		if !strings.Contains(c.Screen(), "tail-03000") {
			t.Fatal("last output line never arrived")
		}
	}
}

// A background process holding the PTY slave keeps EOF from arriving; the exit
// is announced anyway after at most 500 ms.
func TestExitedEvenIfBackgroundHoldsPTY(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0, 0, 0)
	// setsid: the SIGHUP at shell exit doesn't reach it, so the slave stays open.
	if err := c.Send(s, "setsid sleep 5 & exit 0\r"); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	waitFor(t, "session exit", func() bool { return s.Status() == protocol.StatusExited })
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("waited %v; must not wait for the background process to release the PTY", d)
	}
}

// IT-session-5: closing a session must kill the whole process group, or child
// processes keep running as orphans.
func TestITSession5_CloseKillsProcessGroup(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0, 0, 0)

	// Start a background child and record its pid.
	marker := t.TempDir() + "/child.pid"
	cmd := fmt.Sprintf("sleep 300 & echo $! > %s; echo spawned\r", marker)
	if err := c.Send(s, cmd); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "spawned")

	var pid int
	waitFor(t, "child pid written", func() bool {
		b, err := os.ReadFile(marker)
		if err != nil {
			return false
		}
		_, err = fmt.Sscanf(strings.TrimSpace(string(b)), "%d", &pid)
		return err == nil && pid > 0
	})

	if _, err := m.Close(s.SID()); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "background job reaped", func() bool { return !processAlive(pid) })
}

// A background job that ignores SIGHUP must be killed too, via the SIGKILL
// fallback.
//
// Interactive bash runs with job control, so a background job has its own
// process group that kill(-pgid) never reaches. The graceful path relies on
// bash forwarding SIGHUP; if the job ignores SIGHUP, sweeping the session is
// the only way left.
func TestCloseKillsHupImmuneJob(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0, 0, 0)

	marker := t.TempDir() + "/child.pid"
	script := fmt.Sprintf(
		`bash -c 'trap "" HUP; echo $$ > %s; sleep 300' & printf 'SPAWN-%%s\n' OK`+"\r",
		marker)
	if err := c.Send(s, script); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "SPAWN-OK")

	var pid int
	waitFor(t, "child pid written", func() bool {
		b, err := os.ReadFile(marker)
		if err != nil {
			return false
		}
		_, err = fmt.Sscanf(strings.TrimSpace(string(b)), "%d", &pid)
		return err == nil && pid > 0
	})
	if !processAlive(pid) {
		t.Fatal("precondition failed: child process is not running")
	}

	if _, err := m.Close(s.SID()); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "SIGHUP-immune job killed", func() bool { return !processAlive(pid) })
}

// Closing an exited session skips the signal sequence and is idempotent.
func TestCloseExitedSession(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	if err := s.Write("tab", 0, []byte("exit 0\r")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "exit", func() bool { return s.Status() == protocol.StatusExited })

	start := time.Now()
	if _, err := m.Close(s.SID()); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("closing an exited session took %v; it must not wait for the signal grace period", d)
	}
	if _, err := m.Close(s.SID()); err != session.ErrUnknownSession {
		t.Fatalf("second close: err = %v, want ErrUnknownSession", err)
	}
}

// A just-released sid is not reused, so a new session can't take sid N while a
// client is still processing the close of sid N.
func TestSIDNotImmediatelyReused(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	sid := s.SID()
	if _, err := m.Close(sid); err != nil {
		t.Fatal(err)
	}
	s2 := create(t, m)
	if s2.SID() == sid {
		t.Fatalf("sid %d was reused immediately", sid)
	}
}

// IT-resize-1: resize really reaches the PTY (TIOCSWINSZ); stty size in the
// session sees the size the frontend computed (AC-3.11).
func TestITResize1_AppliesToPTY(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0, 0, 0)

	if err := s.Resize(100, 30); err != nil {
		t.Fatal(err)
	}
	if err := c.Send(s, "stty size\r"); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "30 100")

	if err := s.Resize(0, 24); err == nil {
		t.Fatal("cols=0 should be rejected")
	}
	if err := s.Resize(1001, 24); err == nil {
		t.Fatal("cols>1000 should be rejected")
	}
}

// startWinchProgram starts a foreground program in the session that prints a
// "redraw" line with the size it sees on every SIGWINCH.
//
// It must be a non-interactive script. Interactive bash runs with job control,
// so each sleep in the loop would be the foreground in its own process group
// and SIGWINCH would hit only the sleep, never the bash holding the trap. A
// bash script has no job control, shares the foreground group with its
// children, and runs the trap as soon as a signal interrupts wait.
func startWinchProgram(t *testing.T, s *session.Session, c *fakeConn) {
	t.Helper()
	script := t.TempDir() + "/winch.sh"
	body := `trap 'printf "REDRAW-%s\n" "$(stty size)"' WINCH
printf 'WINCH-%s\n' READY
while :; do sleep 0.05 & wait $!; done
`
	if err := os.WriteFile(script, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := c.Send(s, "bash "+script+"\r"); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "WINCH-READY")
}

// IT-resize-2: on a column change the agent's reflow wins and every subscriber
// gets a new snapshot, ahead of the bytes the program redraws on SIGWINCH
// (AC-2.22 / ADR-0026 §4).
//
// In the other order the redraw would land before the snapshot and be
// overwritten by it, and the client would never see that screen.
func TestITResize2_ColsChangeResendsSnapshotBeforeRedraw(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	a, b := newConn(t, m, "tab-a"), newConn(t, m, "tab-b")
	s.Subscribe(a, 0, 0, 0)
	s.Subscribe(b, 0, 0, 0)
	startWinchProgram(t, s, a)

	t.Run("resize message", func(t *testing.T) {
		before := a.Snapshots()
		if err := s.Resize(100, 24); err != nil {
			t.Fatal(err)
		}
		for _, c := range []*fakeConn{a, b} {
			waitFor(t, "every subscriber gets a new snapshot", func() bool { return c.Snapshots() == before+1 })
			waitScreen(t, c, "REDRAW-24 100")
			if strings.Contains(string(c.LastSnapshot()), "REDRAW-24 100") {
				t.Fatal("redraw bytes landed before the snapshot; TIOCSWINSZ must follow enqueueing the snapshot")
			}
			if c.gaps != 0 || c.dups != 0 {
				t.Fatalf("seq accounting error: gaps=%d dups=%d", c.gaps, c.dups)
			}
		}
		if cols := s.Info().Cols; cols != 100 {
			t.Fatalf("session cols = %d", cols)
		}
	})

	t.Run("subscribe with new column count", func(t *testing.T) {
		before := a.Snapshots()
		c := newConn(t, m, "tab-c")
		// Even with out_seq inside the window, a column change means snapshot.
		if st, _ := s.Subscribe(c, s.HeadSeq(), 90, 24); st != protocol.ResumeSnapshot {
			t.Fatalf("status = %q, want snapshot", st)
		}
		if c.Snapshots() != 1 {
			t.Fatalf("new subscriber got %d snapshots, want 1", c.Snapshots())
		}
		waitFor(t, "existing subscriber gets the new snapshot too", func() bool { return a.Snapshots() == before+1 })
		waitScreen(t, c, "REDRAW-24 90")
		if strings.Contains(string(c.LastSnapshot()), "REDRAW-24 90") {
			t.Fatal("redraw bytes landed before the snapshot")
		}
	})
}

// Rows only: resize the emulator and TIOCSWINSZ, but send no snapshot. Phones
// change rows every time the on-screen keyboard opens; resending hundreds of
// KiB and resetting the browser's scrollback each time costs too much
// (ADR-0026 §4).
func TestResizeRowsOnlyNoSnapshot(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0, 0, 0)
	startWinchProgram(t, s, c)
	before := c.Snapshots()

	if err := s.Resize(80, 30); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "REDRAW-30 80") // the PTY did change
	if c.Snapshots() != before {
		t.Fatal("rows-only change resent a snapshot")
	}
	// subscribe with only new rows: incremental from out_seq, no snapshot
	// either.
	c2 := newConn(t, m, "tab-2")
	if st, _ := s.Subscribe(c2, s.HeadSeq(), 80, 20); st != protocol.ResumeOK {
		t.Fatalf("status = %q, want ok", st)
	}
	waitScreen(t, c2, "REDRAW-20 80")
	if c2.Snapshots() != 0 || c.Snapshots() != before {
		t.Fatal("rows-only change sent a snapshot")
	}
	// Same size: nothing happens.
	if err := s.Resize(80, 20); err != nil {
		t.Fatal(err)
	}
	if c.Snapshots() != before {
		t.Fatal("unchanged size sent a snapshot")
	}
}

// Idle means every running session's PTY foreground process group is the shell
// itself; a running command counts as busy (webterm reload --when-idle, the
// control socket's busy count).
func TestBusyFollowsForegroundProcessGroup(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	idle := create(t, m)
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0, 0, 0)
	waitFor(t, "shells ready", func() bool { return s.HeadSeq() > 0 && idle.HeadSeq() > 0 })
	waitFor(t, "idle at the prompt", func() bool { return m.Busy() == 0 })

	if err := c.Send(s, "sleep 30\r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "busy with sleep 30 in the foreground", func() bool { return m.Busy() == 1 })

	// Resend Ctrl-C. The session counts as busy once the foreground group
	// switches to bash's forked child, which may not have exec'ed sleep yet. A
	// SIGINT in that window goes to bash's own handler in the child and is
	// lost at exec, so sleep runs the full 30 seconds (seen on CI with -race
	// and parallelism; about 2.5% locally with 6 parallel runs). Extra ^Cs land
	// harmlessly at the prompt.
	var lastIntr time.Time
	waitFor(t, "idle back at the prompt", func() bool {
		if time.Since(lastIntr) > 300*time.Millisecond {
			if err := c.Send(s, "\x03"); err != nil {
				t.Fatal(err)
			}
			lastIntr = time.Now()
		}
		return m.Busy() == 0
	})

	// An exited session counts as idle.
	if err := c.Send(s, "exit\r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "exit", func() bool { return s.Status() == protocol.StatusExited })
	if m.Busy() != 0 {
		t.Fatal("an exited session should not count as busy")
	}
}

// The shell starts normally (ADR-0026 §6): an interactive login shell (-l -i)
// by default, just -i with --no-login-shell. webterm injects nothing.
func TestLoginShellByDefault(t *testing.T) {
	t.Setenv("HOME", t.TempDir()) // don't read the test runner's own dotfiles
	for _, tc := range []struct {
		noLogin bool
		want    string
	}{{false, "LOGIN[on]"}, {true, "LOGIN[off]"}} {
		c := cfg()
		c.ShellArgs = nil
		c.NoLoginShell = tc.noLogin
		m := newManager(t, c)
		s := create(t, m)
		conn := newConn(t, m, "tab")
		s.Subscribe(conn, 0, 0, 0)
		if err := conn.Send(s, `shopt -q login_shell && v=on || v=off; printf 'LOGIN[%s]\n' "$v"`+"\r"); err != nil {
			t.Fatal(err)
		}
		waitScreen(t, conn, tc.want)
	}
}
