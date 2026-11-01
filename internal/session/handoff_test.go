package session_test

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/handoff"
	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/session"
	"github.com/sunhaijun/webterm/internal/vterm"
)

// IT-handoff-1: byte-level continuity across a handoff (ADR-0016, AC-2.14).
//
// Same yardstick as TestByteLevelContinuity: in the middle of some output, do
// Freeze, Export, and Restore into a new Manager; the same "client"
// resubscribes, and the final screen must be byte-identical to a run with no
// handoff. Plus ADR-0026 §8: the session's snapshot is byte-identical before
// and after the handoff. It runs in-process without a real exec, since fds and
// pids remain valid in the same process; what it tests is that state transfer
// neither drops nor duplicates anything. E2E-26 covers the real exec.
//
// The old Manager must not be shut down; that would kill the shells. After the
// handoff it is an empty shell.
func TestHandoffByteLevelContinuity(t *testing.T) {
	run := func(t *testing.T, handoffs int) string {
		c := cfg()
		c.RingBytes = 1 << 20
		m := session.NewManager(c)
		s := create(t, m)
		conn := newConn(t, m, "tab")
		waitFor(t, "shell ready", func() bool { return s.HeadSeq() > 0 })
		waitQuiet(t, s, 200*time.Millisecond)
		conn.SubscribeAt(s, s.HeadSeq()) // incremental, same starting point as the baseline
		if err := conn.Send(s, emitScript(400)); err != nil {
			t.Fatal(err)
		}
		for range handoffs {
			time.Sleep(3 * time.Millisecond)
			// Disconnect and hand off; the connection layer closes every
			// WebSocket at this point.
			conn.Detach()
			at := conn.OutSeq()
			s.Unsubscribe(conn)
			if err := m.Freeze(2 * time.Second); err != nil {
				t.Fatal(err)
			}
			beforeSeq, before := s.TermSnapshot()
			snap, err := m.Export("test")
			if err != nil {
				t.Fatal(err)
			}
			m.RemoveObserver(conn)

			m2 := session.NewManager(c)
			if err := m2.Restore(snap); err != nil {
				t.Fatal(err)
			}
			s2, ok := m2.Get(s.SID())
			if !ok {
				t.Fatal("session missing after handoff")
			}
			if m2.InstanceID() != m.InstanceID() || m2.Generation() != m.Generation()+1 {
				t.Fatalf("wrong instance_id / generation: %s->%s gen %d->%d", m.InstanceID(), m2.InstanceID(), m.Generation(), m2.Generation())
			}
			// Snapshots before and after the handoff are byte-identical. The new
			// process's loops are already running and may have consumed new
			// output, so compare against the handoff data itself, which is
			// exactly what the new session's emulator was imported from.
			if afterSeq, after := importedSnapshot(t, snap, s.SID()); afterSeq != beforeSeq || !bytes.Equal(after, before) {
				t.Fatalf("snapshot changed across handoff: seq %d->%d, %d->%d bytes", beforeSeq, afterSeq, len(before), len(after))
			}
			m, s = m2, s2
			m.AddObserver(conn)
			conn.Attach()
			if st, _ := s.Subscribe(conn, at, 0, 0); st != protocol.ResumeOK {
				t.Fatalf("resume after handoff = %s, want ok", st)
			}
		}
		t.Cleanup(m.Shutdown)
		waitScreen(t, conn, "EMIT-DONE")
		waitQuiet(t, s, 300*time.Millisecond)
		if conn.Snapshots() != 0 || conn.gaps != 0 || conn.dups != 0 {
			t.Fatalf("seq accounting error: snapshots=%d gaps=%d dups=%d", conn.Snapshots(), conn.gaps, conn.dups)
		}
		// The shell is still alive and runs commands after the handoff.
		if handoffs > 0 {
			if err := conn.Send(s, "echo ALIVE-$((40+2))\r"); err != nil {
				t.Fatal(err)
			}
			waitScreen(t, conn, "ALIVE-42")
			// Cut this tail before comparing; the baseline doesn't have it.
			screen := conn.Screen()
			return screen[:strings.Index(screen, "EMIT-DONE")+len("EMIT-DONE")]
		}
		screen := conn.Screen()
		return screen[:strings.Index(screen, "EMIT-DONE")+len("EMIT-DONE")]
	}

	baseline := run(t, 0)
	if len(baseline) < 4096 {
		t.Fatalf("baseline output is only %d bytes", len(baseline))
	}
	for _, n := range []int{1, 3} {
		t.Run(itoa(n)+"_handoffs", func(t *testing.T) {
			got := run(t, n)
			if got == baseline {
				return
			}
			i := 0
			for i < len(got) && i < len(baseline) && got[i] == baseline[i] {
				i++
			}
			t.Fatalf("byte-level continuity across handoff broken: diverges at byte %d\nbaseline %q\ngot      %q", i, sample(baseline, i), sample(got, i))
		})
	}
}

// importedSnapshot rebuilds an emulator from the handoff data's emulator state
// and returns its snapshot and seq.
func importedSnapshot(t *testing.T, snap *handoff.Snapshot, sid uint16) (uint64, []byte) {
	t.Helper()
	for _, hs := range snap.Sessions {
		if hs.SID != sid {
			continue
		}
		term, err := vterm.Import(hs.VTerm)
		if err != nil {
			t.Fatalf("cannot import emulator state from handoff data: %v", err)
		}
		return hs.RingBase + uint64(len(hs.RingData)), term.Snapshot()
	}
	t.Fatalf("session %d not in handoff data", sid)
	return 0, nil
}

// Input arriving during the freeze is neither lost nor duplicated: it waits in
// the queue, travels with the snapshot, and the new process writes and acks it.
func TestHandoffCarriesPendingInput(t *testing.T) {
	m := session.NewManager(cfg())
	s := create(t, m)
	conn := newConn(t, m, "tab")
	s.Subscribe(conn, 0, 0, 0)
	waitFor(t, "shell ready", func() bool { return s.HeadSeq() > 0 })
	waitQuiet(t, s, 200*time.Millisecond)

	if err := m.Freeze(2 * time.Second); err != nil {
		t.Fatal(err)
	}
	// Input submitted while frozen is queued but not written to the PTY.
	if err := conn.Send(s, "echo PEND-$((20+3))\r"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if s.InAck("tab") != 0 {
		t.Fatalf("nothing should reach the PTY while frozen, inAck=%d", s.InAck("tab"))
	}
	snap, err := m.Export("test")
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Sessions) != 1 || len(snap.Sessions[0].Pending) != 1 {
		t.Fatalf("pending input missing from snapshot: %+v", snap.Sessions)
	}
	at := conn.OutSeq()
	conn.Detach()
	s.Unsubscribe(conn)
	m.RemoveObserver(conn)

	m2 := session.NewManager(cfg())
	t.Cleanup(m2.Shutdown)
	if err := m2.Restore(snap); err != nil {
		t.Fatal(err)
	}
	s2, _ := m2.Get(s.SID())
	m2.AddObserver(conn)
	conn.Attach()
	s2.Subscribe(conn, at, 0, 0)
	waitScreen(t, conn, "PEND-23")
	waitFor(t, "ack catches up", func() bool { return s2.InAck("tab") == uint64(len("echo PEND-$((20+3))\r")) })
	if conn.gaps != 0 || conn.dups != 0 {
		t.Fatalf("seq accounting error: gaps=%d dups=%d", conn.gaps, conn.dups)
	}
	// The echo shows the unexpanded PEND-$((20+3)), so the expanded PEND-23
	// can only come from running the command, exactly once. More means the
	// input was written to the PTY twice.
	if n := strings.Count(conn.Screen(), "PEND-23"); n != 1 {
		t.Fatalf("PEND-23 appears %d times; input was written twice", n)
	}
}

// Pre-flight failure path: Thaw after Freeze; the session keeps working and no
// output is lost.
func TestFreezeThawResumes(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	conn := newConn(t, m, "tab")
	s.Subscribe(conn, 0, 0, 0)
	waitFor(t, "shell ready", func() bool { return s.HeadSeq() > 0 })

	if err := conn.Send(s, emitScript(200)); err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond)
	if err := m.Freeze(2 * time.Second); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Create(session.Spec{CWD: t.TempDir(), Cols: 80, Rows: 24}); err != session.ErrFrozen {
		t.Fatalf("Create while frozen should return ErrFrozen, got %v", err)
	}
	head := s.HeadSeq()
	time.Sleep(150 * time.Millisecond)
	if s.HeadSeq() != head {
		t.Fatal("ring should not grow while frozen")
	}
	m.Thaw()
	waitScreen(t, conn, "EMIT-DONE")
	if conn.gaps != 0 || conn.dups != 0 || conn.Snapshots() != 1 {
		t.Fatalf("accounting error after thaw: gaps=%d dups=%d snapshots=%d", conn.gaps, conn.dups, conn.Snapshots())
	}
	if !strings.Contains(conn.Screen(), "line 200") {
		t.Fatal("output incomplete after thaw")
	}
}

// Exited sessions are handed over too: ring and emulator are kept for
// scrollback (AC-4.5), with no fd or process.
func TestHandoffKeepsExitedSession(t *testing.T) {
	m := session.NewManager(cfg())
	s := create(t, m)
	conn := newConn(t, m, "tab")
	s.Subscribe(conn, 0, 0, 0)
	waitFor(t, "shell ready", func() bool { return s.HeadSeq() > 0 })
	if err := conn.Send(s, "echo BYE-$((1+1)); exit 7\r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "session exit", func() bool { return s.Status() == protocol.StatusExited })
	waitScreen(t, conn, "BYE-2")

	if err := m.Freeze(time.Second); err != nil {
		t.Fatal(err)
	}
	snap, err := m.Export("test")
	if err != nil {
		t.Fatal(err)
	}
	hs := snap.Sessions[0]
	if hs.Status != protocol.StatusExited || hs.PtmxFD != -1 || hs.ShellPID != 0 || hs.ExitCode == nil || *hs.ExitCode != 7 {
		t.Fatalf("wrong snapshot for exited session: %+v", hs)
	}
	m2 := session.NewManager(cfg())
	t.Cleanup(m2.Shutdown)
	if err := m2.Restore(snap); err != nil {
		t.Fatal(err)
	}
	s2, _ := m2.Get(s.SID())
	info := s2.Info()
	if info.Status != protocol.StatusExited || info.HeadSeq != s.HeadSeq() {
		t.Fatalf("wrong state after restore: %+v", info)
	}
	c2 := newConn(t, m2, "tab2")
	s2.Subscribe(c2, 0, 0, 0)
	if !strings.Contains(render(c2, 80, 24), "BYE-2") {
		t.Fatal("snapshot after restore lacks the pre-exit output")
	}
	if _, err := m2.Close(s2.SID()); err != nil {
		t.Fatal(err)
	}
}

// Validate rejects incomplete snapshots, so Restore never starts with half the
// state.
func TestRestoreRejectsBadSnapshot(t *testing.T) {
	m := newManager(t, cfg())
	if err := m.Restore(&handoff.Snapshot{Schema: handoff.Schema + 1, InstanceID: "x"}); err == nil {
		t.Fatal("a too-new schema must be rejected")
	}
}

// IT-handoff-2: emulator state travels with the handoff (ADR-0026 §8).
//
// It can't be reconstructed: ESC[?1049h appears once when the program starts,
// and the ring buffer trimmed it long ago. Losing this state would make vim or
// codex sessions unrenderable after an upgrade.
func TestHandoffKeepsTerminalState(t *testing.T) {
	c := cfg()
	c.RingBytes = 8192
	m := session.NewManager(c)
	s := create(t, m)
	conn := newConn(t, m, "tab")
	s.Subscribe(conn, 0, 0, 0)
	waitFor(t, "shell ready", func() bool { return s.HeadSeq() > 0 })
	enterAltScreen(t, s, conn, c.RingBytes)

	conn.Detach()
	s.Unsubscribe(conn)
	if err := m.Freeze(2 * time.Second); err != nil {
		t.Fatal(err)
	}
	_, before := s.TermSnapshot()
	snap, err := m.Export("test")
	if err != nil {
		t.Fatal(err)
	}
	m.RemoveObserver(conn)

	m2 := session.NewManager(c)
	if err := m2.Restore(snap); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m2.Shutdown)
	s2, ok := m2.Get(s.SID())
	if !ok {
		t.Fatal("session missing after handoff")
	}

	// In the new process, a client switching back after its position was
	// trimmed gets a snapshot identical to the pre-handoff one, still on the
	// alternate screen.
	fresh := newConn(t, m2, "tab-2")
	if st, _ := s2.Subscribe(fresh, 1, 0, 0); st != protocol.ResumeSnapshot {
		t.Fatalf("status = %q, want snapshot", st)
	}
	if !bytes.Equal(fresh.LastSnapshot(), before) {
		t.Fatal("snapshot after handoff differs from before: emulator state was not handed over")
	}
	if !bytes.Contains(before, []byte("\x1b[?1049h")) {
		t.Fatal("snapshot lacks the alternate screen switch")
	}
}

// IT-handoff-1 (ADR-0043 §4): a title set by the foreground program survives a
// handoff. The name is the title immediately after the handoff, without
// flashing back to the directory name until the program sets it again.
func TestHandoffKeepsTitleName(t *testing.T) {
	c := cfg()
	m := session.NewManager(c)
	s := create(t, m)
	conn := newConn(t, m, "tab")
	s.Subscribe(conn, 0, 0, 0)
	waitFor(t, "shell ready", func() bool { return s.HeadSeq() > 0 })
	if err := conn.Send(s, `bash -c 'printf "\033]0;HANDOFF TITLE\007"; exec sleep 30'`+"\r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "name is the title", func() bool { return s.Info().Name == "HANDOFF TITLE" })

	conn.Detach()
	s.Unsubscribe(conn)
	if err := m.Freeze(2 * time.Second); err != nil {
		t.Fatal(err)
	}
	snap, err := m.Export("test")
	if err != nil {
		t.Fatal(err)
	}
	m.RemoveObserver(conn)

	m2 := session.NewManager(c)
	if err := m2.Restore(snap); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m2.Shutdown)
	s2, ok := m2.Get(s.SID())
	if !ok {
		t.Fatal("session missing after handoff")
	}
	if got := s2.Info().Name; got != "HANDOFF TITLE" {
		t.Fatalf("name after handoff = %q, want the title", got)
	}
	// Later polls keep it (the owning process group is still in the
	// foreground).
	for range 5 {
		time.Sleep(100 * time.Millisecond)
		if got := s2.Info().Name; got != "HANDOFF TITLE" {
			t.Fatalf("polling after handoff changed the name to %q", got)
		}
	}
}

// enterAltScreen switches the session to the alternate screen and then cycles
// the ring buffer once, so ESC[?1049h survives only in the emulator.
func enterAltScreen(t *testing.T, s *session.Session, c *fakeConn, ring int) {
	t.Helper()
	if err := c.Send(s, "printf '\\033[?1049h'; printf 'ALT-%s\\n' READY\r"); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "ALT-READY")
	if err := c.Send(s, emitScript(ring/40+200)); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "EMIT-DONE")
	waitFor(t, "buffer trimmed", func() bool { return s.Info().BaseSeq > 0 })
	waitQuiet(t, s, 200*time.Millisecond)
}

// Upgrading from an older version (schema 1, no emulator state in the handoff):
// the new process creates an emulator, feeds it the handed-over ring buffer as
// a best effort, and does not abort the upgrade (end of ADR-0026 §8).
func TestHandoffFromSchema1RebuildsTerminalFromRing(t *testing.T) {
	m := session.NewManager(cfg())
	s := create(t, m)
	conn := newConn(t, m, "tab")
	s.Subscribe(conn, 0, 0, 0)
	if err := conn.Send(s, "printf 'OLD-%s\\n' SCREEN\r"); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, conn, "OLD-SCREEN")
	waitQuiet(t, s, 200*time.Millisecond)

	if err := m.Freeze(2 * time.Second); err != nil {
		t.Fatal(err)
	}
	snap, err := m.Export("v0.1.0")
	if err != nil {
		t.Fatal(err)
	}
	m.RemoveObserver(conn)
	// Pose as a handoff from an older version: schema 1, no emulator state.
	snap.Schema = 1
	for i := range snap.Sessions {
		snap.Sessions[i].VTerm = nil
	}
	m2 := session.NewManager(cfg())
	t.Cleanup(m2.Shutdown)
	if err := m2.Restore(snap); err != nil {
		t.Fatalf("a handoff in the old format must be accepted: %v", err)
	}
	s2, _ := m2.Get(s.SID())
	fresh := newConn(t, m2, "tab-2")
	s2.Subscribe(fresh, 0, 0, 0)
	if !strings.Contains(render(fresh, 80, 24), "OLD-SCREEN") {
		t.Fatal("could not rebuild the screen from the ring buffer")
	}
	// The session still works.
	if err := fresh.Send(s2, "echo NEW-$((6*7))\r"); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, fresh, "NEW-42")
}
