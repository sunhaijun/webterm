package session_test

import (
	"bytes"
	"log/slog"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/session"
)

// emitScript produces deterministic output: fixed content and order, with ANSI
// colors, CJK wide characters, and long lines. No timestamps, random numbers,
// or hostnames, which would make byte-level comparison meaningless.
func emitScript(lines int) string {
	return "for i in $(seq 1 " + itoa(lines) + "); do " +
		`printf '\033[3%dmline %03d\033[0m 中文宽字符 %s\n' $((i%8)) $i "$(printf 'x%.0s' $(seq 1 40))"; ` +
		// The done marker must appear only in the output, never in the echoed
		// command line; otherwise the wait would succeed as soon as the
		// command is typed, testing the echo rather than the output.
		"done; printf 'EMIT-%s\\n' DONE\r"
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

// IT-resume-1: a session doesn't pause while disconnected; the PTY keeps
// running and the ring buffer keeps filling.
func TestITResume1_SessionKeepsRunningWhileDisconnected(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0, 0, 0)

	waitFor(t, "shell ready", func() bool { return s.HeadSeq() > 0 })

	// "Disconnect": the connection layer drops the subscription.
	s.Unsubscribe(c)
	before := s.HeadSeq()

	if err := c.Send(s, "echo while-offline\r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "output accumulates while disconnected", func() bool { return s.HeadSeq() > before })

	if s.Status() != protocol.StatusRunning {
		t.Fatal("disconnecting paused the session")
	}
	// Reconnect and catch up: every byte produced while disconnected must come
	// back.
	c2 := newConn(t, m, "tab")
	if st, _ := s.Subscribe(c2, before, 0, 0); st != protocol.ResumeOK {
		t.Fatalf("status = %q, want ok", st)
	}
	waitScreen(t, c2, "while-offline")
}

// IT-resume-2: incremental replay. The agent sends only bytes after out_seq
// and never resends what the client already has.
func TestITResume2_IncrementalReplay(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0, 0, 0)

	// The marker must appear only in the output. With a plain
	// "echo ONE-MARK" the echoed command line already contains it, and the cut
	// would land after typing but before the output.
	if err := c.Send(s, `printf 'ONE-%s\n' MARK`+"\r"); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "ONE-MARK")
	waitQuiet(t, s, 200*time.Millisecond) // cut after the first output has fully finished

	c.Detach() // bytes after the disconnect must go nowhere, or races blur the cut point
	at := c.OutSeq()
	s.Unsubscribe(c)

	if err := c.Send(s, `printf 'TWO-%s\n' MARK`+"\r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "second output produced", func() bool { return s.HeadSeq() > at })

	// Resubscribe from the cut: only what follows it should arrive.
	c2 := newConn(t, m, "tab")
	st, from := s.Subscribe(c2, at, 0, 0)
	if st != protocol.ResumeOK || from != at {
		t.Fatalf("resume = %s/%d, want ok/%d", st, from, at)
	}
	waitScreen(t, c2, "TWO-MARK")

	if strings.Contains(c2.Screen(), "ONE-MARK") {
		t.Fatal("resent bytes the client already had; resume should be incremental")
	}
	if c2.Snapshots() != 0 {
		t.Fatal("took the snapshot path without a buffer overflow")
	}
}

// IT-resume-3: input survives a reconnect without loss, duplication, or
// input_gap.
//
// in_ack is kept per (client_id, sid) and survives reconnects. If it were per
// connection, in_ack would reset to 0 on reconnect while the client's pending
// input still starts at the old seq; the agent would see seq > in_ack, send
// input_gap, close the connection, and loop reconnecting forever, defeating
// "no input lost while disconnected".
func TestITResume3_InputSurvivesReconnect(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	c := newConn(t, m, "tab-1")
	s.Subscribe(c, 0, 0, 0)

	if err := c.Send(s, "echo A1\r"); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "A1")
	waitFor(t, "input acked", func() bool { return s.InAck("tab-1") == c.inSeqNext })

	// "Disconnect".
	s.Unsubscribe(c)
	s.DetachClient("tab-1")

	// Reconnect: the same client_id gets its in_ack back (Resume also
	// subscribes).
	c2 := newConn(t, m, "tab-1")
	resumed := m.Resume(c2, m.InstanceID(), []protocol.ResumeReq{
		{SID: s.SID(), OutSeq: c.OutSeq()},
	})
	if len(resumed) != 1 {
		t.Fatalf("resumed = %+v", resumed)
	}
	r := resumed[0]
	if r.Status != protocol.ResumeOK {
		t.Fatalf("status = %q, want ok", r.Status)
	}
	if r.InAck == 0 {
		t.Fatal("in_ack reset to 0 after reconnect; the client would resend from the old seq and hit input_gap")
	}
	if r.InAck != c.inSeqNext {
		t.Fatalf("in_ack = %d, want %d (everything was written before the disconnect)", r.InAck, c.inSeqNext)
	}

	// The client trims its resend queue to in_ack and sends new input.
	c2.TrimTo(r.InAck)
	if err := c2.Send(s, "echo A2\r"); err != nil {
		t.Fatalf("first write after reconnect failed: %v", err)
	}
	waitScreen(t, c2, "A2")

	// No gaps or duplicates throughout.
	if c2.gaps != 0 || c2.dups != 0 {
		t.Fatalf("seq accounting error: gaps=%d dups=%d", c2.gaps, c2.dups)
	}
}

// Resent input that was already processed is deduplicated: the agent drops the
// first in_ack-seq bytes and writes only the rest.
func TestInputResendIsDeduplicated(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0, 0, 0)

	first := "echo DEDUP-"
	if err := c.Send(s, first); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "first chunk written to PTY", func() bool { return s.InAck("tab") == uint64(len(first)) })

	// After reconnecting the client resends everything (including the
	// processed part) plus new input.
	whole := first + "OK\r"
	if err := c.Resend(s, 0, whole); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "DEDUP-OK")

	if strings.Count(c.Screen(), "DEDUP-DEDUP") > 0 {
		t.Fatal("the resent part was written to the PTY twice")
	}
	waitFor(t, "in_ack reaches the full length", func() bool { return s.InAck("tab") == uint64(len(whole)) })
}

// At disconnect, writeLoop is stuck on a chunk (the foreground program isn't
// reading stdin and the PTY input is full): taken from the queue but not acked,
// with another chunk queued behind it. After reconnecting the client resends
// everything from in_ack, and each byte must reach the PTY exactly once.
func TestDetachKeepsInFlightInput(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0, 0, 0)

	// In raw mode, ignore stdin for 1 second, then read everything and count
	// the bytes.
	f := t.TempDir() + "/in"
	cmd := "stty raw -echo; printf 'STALL-%s\\n' ON; sleep 1; timeout --foreground 1 cat >" + f +
		"; stty sane; echo COUNT=$(wc -c <" + f + ")\r"
	if err := c.Send(s, cmd); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "STALL-ON")
	ack0 := s.InAck("tab")

	stuck, tail := strings.Repeat("x", 128<<10), strings.Repeat("y", 1<<10)
	if err := c.Send(s, stuck); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond) // writeLoop takes stuck and blocks in ptmx.Write
	if err := c.Send(s, tail); err != nil {
		t.Fatal(err)
	}

	// Disconnect (tail is dropped), reconnect for in_ack, resend everything
	// from there.
	s.Unsubscribe(c)
	s.DetachClient("tab")
	r := m.Resume(c, m.InstanceID(), []protocol.ResumeReq{{SID: s.SID(), OutSeq: c.OutSeq()}})[0]
	if r.InAck != ack0 {
		t.Fatalf("precondition failed: in_ack = %d, want %d (stuck should still be blocked)", r.InAck, ack0)
	}
	c.TrimTo(r.InAck)
	if err := c.Send(s, stuck+tail); err != nil {
		t.Fatal(err)
	}

	re := regexp.MustCompile(`COUNT=(\d+)`)
	var got []string
	waitFor(t, "COUNT", func() bool { got = re.FindStringSubmatch(c.Screen()); return got != nil })
	if want := itoa(len(stuck) + len(tail)); got[1] != want {
		t.Fatalf("PTY received %s bytes, want %s (was the stuck chunk written twice?)", got[1], want)
	}
}

// A gap in input must return ErrInputGap so the connection layer closes the
// connection.
func TestInputGapDetected(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	if err := s.Write("tab", 0, []byte("abc")); err != nil {
		t.Fatal(err)
	}
	if err := s.Write("tab", 100, []byte("def")); err != session.ErrInputGap {
		t.Fatalf("err = %v, want ErrInputGap", err)
	}
}

// Two tabs keep independent accounting.
func TestInputAccountingIsPerClient(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	if err := s.Write("tab-a", 0, []byte("echo ")); err != nil {
		t.Fatal(err)
	}
	// tab-b's first frame also starts at 0 and must not be affected by tab-a.
	if err := s.Write("tab-b", 0, []byte("echo ")); err != nil {
		t.Fatalf("tab-b starting at seq 0 was rejected: %v", err)
	}
	waitFor(t, "both clients acked", func() bool {
		return s.InAck("tab-a") == 5 && s.InAck("tab-b") == 5
	})
}

// seq restarting at 0 for a client_id that already has accounting means the
// client reset its counter but kept its id (protocol §5.4, ADR-0020 item 5).
// The overlap is still dropped as a resend, but a Warn must be logged because
// the browser shows no sign of the drop. Normal first frames and reconnect
// resends must stay quiet.
func TestInputCounterResetIsLogged(t *testing.T) {
	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	m := newManager(t, cfg())
	s := create(t, m)
	if err := s.Write("tab", 0, []byte("abc")); err != nil {
		t.Fatal(err)
	}
	if err := s.Write("tab", 1, []byte("bcd")); err != nil { // reconnect resend: the first two bytes overlap
		t.Fatal(err)
	}
	waitFor(t, "first frame and resend written", func() bool { return s.InAck("tab") == 4 })
	if logs.Len() != 0 {
		t.Fatalf("first frame and normal resend should not log: %s", logs.String())
	}

	if err := s.Write("tab", 0, []byte("xyz")); err != nil {
		t.Fatal(err)
	}
	out := logs.String()
	if !strings.Contains(out, "level=WARN") || !strings.Contains(out, "client=tab") || !strings.Contains(out, "accepted=4") {
		t.Fatalf("counter reset was not logged: %q", out)
	}
	time.Sleep(100 * time.Millisecond)
	if got := s.InAck("tab"); got != 4 {
		t.Fatalf("in_ack = %d: the overlap should still be dropped as a resend", got)
	}
}

// IT-resume-4: an instance_id mismatch answers every resume with gone.
//
// After an agent restart, sids start over. Without an instance id,
// resume{sid:1, out_seq:large} would attach to an unrelated new session: the
// screen keeps the old session's content and continues with another
// session's output.
func TestITResume4_InstanceMismatchIsGone(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	waitFor(t, "some output", func() bool { return s.HeadSeq() > 0 })

	t.Run("matching instance, position in window: incremental", func(t *testing.T) {
		head := s.HeadSeq()
		got := m.Resume(newConn(t, m, "tab"), m.InstanceID(), []protocol.ResumeReq{{SID: s.SID(), OutSeq: head}})
		if got[0].Status != protocol.ResumeOK || got[0].FromSeq != head {
			t.Fatalf("got %+v, want ok/%d", got[0], head)
		}
	})

	t.Run("mismatched instance: always gone, nothing pushed", func(t *testing.T) {
		c := newConn(t, m, "tab")
		got := m.Resume(c, "some-old-instance", []protocol.ResumeReq{
			{SID: s.SID(), OutSeq: 999999},
			{SID: s.SID(), OutSeq: 0},
		})
		for _, r := range got {
			if r.Status != protocol.ResumeGone {
				t.Fatalf("sid %d status = %q, want gone", r.SID, r.Status)
			}
		}
		if len(c.Frames()) != 0 {
			t.Fatal("a gone session should push no frames")
		}
	})

	t.Run("first connect without instance_id takes the normal path", func(t *testing.T) {
		got := m.Resume(newConn(t, m, "tab"), "", []protocol.ResumeReq{{SID: s.SID(), OutSeq: 0}})
		if got[0].Status != protocol.ResumeSnapshot {
			t.Fatalf("status = %q, want snapshot (out_seq is 0)", got[0].Status)
		}
	})

	t.Run("unknown sid is gone too", func(t *testing.T) {
		got := m.Resume(newConn(t, m, "tab"), m.InstanceID(), []protocol.ResumeReq{{SID: 60000, OutSeq: 0}})
		if got[0].Status != protocol.ResumeGone {
			t.Fatalf("status = %q, want gone", got[0].Status)
		}
	})
}

// Incremental or snapshot (protocol §5.1): out_seq > 0 and inside the window
// means incremental; anything else means snapshot. hello.resume and subscribe
// share the same decision.
func TestResumeSnapshotWhenOutOfWindow(t *testing.T) {
	c := cfg()
	c.RingBytes = 4096 // small, so falling out of the window is testable
	m := newManager(t, c)
	s := create(t, m)
	conn := newConn(t, m, "tab")
	s.Subscribe(conn, 0, 0, 0)

	if err := conn.Send(s, emitScript(300)); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, conn, "EMIT-DONE")
	waitFor(t, "buffer trimmed", func() bool { return s.Info().BaseSeq > 0 })
	waitQuiet(t, s, 200*time.Millisecond)

	t.Run("out of window: snapshot, from_seq is the snapshot seq", func(t *testing.T) {
		re := newConn(t, m, "tab-r")
		got := m.Resume(re, m.InstanceID(), []protocol.ResumeReq{{SID: s.SID(), OutSeq: 1}})
		if got[0].Status != protocol.ResumeSnapshot {
			t.Fatalf("status = %q, want snapshot", got[0].Status)
		}
		if re.Snapshots() != 1 || got[0].FromSeq != re.OutSeq() || got[0].FromSeq != s.HeadSeq() {
			t.Fatalf("from_seq = %d, snapshot seq = %d, head = %d; all three should be equal", got[0].FromSeq, re.OutSeq(), s.HeadSeq())
		}
		// The snapshot is the complete picture, including history that fell out
		// of the window (AC-2.6: no more truncation).
		if !strings.Contains(render(re, 80, 24), "EMIT-DONE") {
			t.Fatal("snapshot lacks the current screen")
		}
	})

	t.Run("out_seq 0 (first open or reload): snapshot", func(t *testing.T) {
		fresh := newConn(t, m, "tab-2")
		if st, _ := s.Subscribe(fresh, 0, 0, 0); st != protocol.ResumeSnapshot || fresh.Snapshots() != 1 {
			t.Fatalf("status = %q snapshots = %d", st, fresh.Snapshots())
		}
	})

	t.Run("ahead of head: snapshot", func(t *testing.T) {
		ahead := newConn(t, m, "tab-3")
		if st, from := s.Subscribe(ahead, s.HeadSeq()+1000, 0, 0); st != protocol.ResumeSnapshot || from != s.HeadSeq() {
			t.Fatalf("got %s/%d, want snapshot/%d", st, from, s.HeadSeq())
		}
	})

	t.Run("in window: incremental, raw missing bytes, no snapshot", func(t *testing.T) {
		base, head := s.Info().BaseSeq, s.HeadSeq()
		incr := newConn(t, m, "tab-4")
		st, from := s.Subscribe(incr, base+10, 0, 0)
		if st != protocol.ResumeOK || from != base+10 {
			t.Fatalf("got %s/%d, want ok/%d", st, from, base+10)
		}
		if incr.Snapshots() != 0 {
			t.Fatal("sent a snapshot inside the window")
		}
		if uint64(len(incr.Screen())) != head-(base+10) || incr.OutSeq() != head {
			t.Fatalf("caught up %d bytes, want %d", len(incr.Screen()), head-(base+10))
		}
	})
}

// When an unsubscribed session produces output, unsubscribed connections still
// get its head_seq, from which unread state is derived.
//
// Subscribing only controls OUTPUT bytes; sending head_seq only to subscribers
// would make unread impossible to compute for background sessions.
func TestUnreadDerivedFromHeadSeq(t *testing.T) {
	m := newManager(t, cfg())
	visible, background := create(t, m), create(t, m)

	c := newConn(t, m, "tab")
	visible.Subscribe(c, 0, 0, 0) // subscribe only to the visible one

	if err := c.Send(background, "echo in-background\r"); err != nil {
		t.Fatal(err)
	}

	waitFor(t, "background session head_seq", func() bool {
		for _, e := range c.Events() {
			if u, ok := e.(*protocol.SessionUpdated); ok &&
				u.SID == background.SID() && u.HeadSeq != nil && *u.HeadSeq > 0 {
				return true
			}
		}
		return false
	})

	// Its bytes must not cross the network; this is a key mobile optimization.
	if strings.Contains(c.Screen(), "in-background") {
		t.Fatal("an unsubscribed session pushed its output")
	}
}
