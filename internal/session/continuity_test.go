package session_test

import (
	"strings"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/session"
)

// Byte-level continuity: the m1 exit criterion, AC-2.1 without a browser.
//
// It doesn't test whether reconnecting works (too weak). It tests that the
// final byte stream is identical to one that was never interrupted. Any seq
// accounting error, slice offset, duplicate replay, or dropped frame makes the
// two runs differ.
//
// E2E-2 repeats this with a real browser and xterm serialization; this is the
// cheapest way to hammer the riskiest logic first.
func TestByteLevelContinuity(t *testing.T) {
	run := func(t *testing.T, interruptions int) string {
		c := cfg()
		c.RingBytes = 1 << 20 // large enough that output during a disconnect never overflows, so always incremental
		m := newManager(t, c)
		s := create(t, m)
		conn := newConn(t, m, "tab")
		waitFor(t, "shell ready", func() bool { return s.HeadSeq() > 0 })
		waitQuiet(t, s, 200*time.Millisecond)
		// Subscribe at the current head (incremental, nothing to catch up), so
		// both runs compare the raw stream after the same starting point,
		// regardless of how fast the startup prompt was drawn.
		if st, _ := conn.SubscribeAt(s, s.HeadSeq()); st != protocol.ResumeOK {
			t.Fatalf("status = %q, want ok", st)
		}

		if err := conn.Send(s, emitScript(400)); err != nil {
			t.Fatal(err)
		}
		for range interruptions {
			time.Sleep(2 * time.Millisecond)
			// Disconnect: stop receiving, read the cut point, then unsubscribe,
			// in the same order as a real connection.
			conn.Detach()
			at := conn.OutSeq()
			s.Unsubscribe(conn)

			time.Sleep(2 * time.Millisecond)
			conn.Attach()
			// Reconnect and resume with the same decision (protocol §5.1); inside
			// the window it must be incremental.
			if st, from := s.Subscribe(conn, at, 0, 0); st != protocol.ResumeOK || from != at {
				t.Fatalf("resume = %s/%d, want ok/%d", st, from, at)
			}
		}
		waitScreen(t, conn, "EMIT-DONE")
		waitQuiet(t, s, 300*time.Millisecond) // same cutoff for both runs

		if conn.Snapshots() != 0 {
			t.Fatalf("took the snapshot path %d times: the buffer overflowed and this comparison is meaningless", conn.Snapshots())
		}
		if conn.gaps != 0 || conn.dups != 0 {
			t.Fatalf("seq accounting error: gaps=%d dups=%d", conn.gaps, conn.dups)
		}
		return conn.Screen()
	}

	baseline := run(t, 0)
	if len(baseline) < 4096 {
		t.Fatalf("baseline output is only %d bytes, too little to test anything", len(baseline))
	}

	for _, n := range []int{1, 3, 10} {
		t.Run(itoa(n)+"_interruptions", func(t *testing.T) {
			got := run(t, n)
			if got == baseline {
				return
			}
			// Report the first divergence to tell an offset from a dropped frame.
			i := 0
			for i < len(got) && i < len(baseline) && got[i] == baseline[i] {
				i++
			}
			t.Fatalf("byte-level continuity broken: diverges at byte %d (baseline %d bytes, got %d bytes)\n"+
				"baseline %q\ngot      %q", i, len(baseline), len(got),
				sample(baseline, i), sample(got, i))
		})
	}
}

func sample(s string, at int) string {
	lo := max(at-40, 0)
	hi := min(at+40, len(s))
	return s[lo:hi]
}

// IT-queue-1: a full session input queue returns ErrInputStalled and never
// blocks.
//
// A blocking enqueue would propagate through ptmx.Write, writeLoop, and the
// queue to stall the connection's read loop. One WebSocket carries every
// session, so one foreground program that doesn't read stdin could stop
// ping/pong, resize, and input to every other session.
func TestITQueue1_InputStalledNeverBlocks(t *testing.T) {
	m := newManager(t, cfg())
	stuck := create(t, m)
	other := create(t, m)

	cs, co := newConn(t, m, "tab"), newConn(t, m, "tab")
	stuck.Subscribe(cs, 0, 0, 0)
	other.Subscribe(co, 0, 0, 0)

	// Make the stuck session's foreground program ignore stdin.
	if err := cs.Send(stuck, "sleep 60\r"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)

	// Fill the queue. Every call must return immediately.
	chunk := make([]byte, 8<<10)
	for i := range chunk {
		chunk[i] = 'x'
	}
	var stalled bool
	deadline := time.Now().Add(20 * time.Second)
	for range 200 {
		start := time.Now()
		err := cs.Send(stuck, string(chunk))
		if d := time.Since(start); d > 2*time.Second {
			t.Fatalf("Write blocked for %v; enqueueing must not block", d)
		}
		if err == session.ErrInputStalled {
			stalled = true
			break
		}
		if err != nil {
			t.Fatalf("unexpected Write error: %v", err)
		}
		if time.Now().After(deadline) {
			break
		}
	}
	if !stalled {
		t.Fatal("1.6 MiB in and no ErrInputStalled: the queue limit is not enforced")
	}

	// The key assertion: the other session is unaffected.
	if err := co.Send(other, "echo STILL-ALIVE\r"); err != nil {
		t.Fatalf("input to the other session failed too: %v", err)
	}
	waitScreen(t, co, "STILL-ALIVE")
}

// The agent does not rewrite the output stream (ADR-0026 §2 / invariant 4):
// out_seq is the cumulative PTY output byte count with nothing stripped. OSC
// 133 / 7 / 1701, once stripped, now pass through to the browser and xterm
// ignores them.
func TestOutSeqIsRawPTYBytes(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	c := newConn(t, m, "tab")
	waitFor(t, "shell ready", func() bool { return s.HeadSeq() > 0 })
	waitQuiet(t, s, 200*time.Millisecond)
	start := s.HeadSeq()
	c.SubscribeAt(s, start)

	// Have the shell print OSC bytes itself (the echo shows literal backslashes,
	// which don't interfere with the assertion).
	script := `printf 'A\033]133;B\007B\033]7;file://h/srv/demo\007C\033]1701;hello;1\007D\033]0;keep-me\007E\n'` +
		"; printf 'RAW-%s\\n' MARK\r"
	if err := c.Send(s, script); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "RAW-MARK")
	waitQuiet(t, s, 300*time.Millisecond)

	screen := c.Screen()
	const want = "A\x1b]133;B\x07B\x1b]7;file://h/srv/demo\x07C\x1b]1701;hello;1\x07D\x1b]0;keep-me\x07E"
	if !strings.Contains(screen, want) {
		t.Errorf("output was rewritten; want %q verbatim", want)
	}
	if got, want := s.HeadSeq()-start, uint64(len(screen)); got != want {
		t.Fatalf("head_seq advanced %d but the client received %d bytes; out_seq must equal the raw byte count", got, want)
	}
	for _, e := range c.Events() {
		if u, ok := e.(*protocol.SessionUpdated); ok && u.CWD != nil && *u.CWD == "/srv/demo" {
			t.Fatal("OSC 7 is no longer a cwd source; cwd comes only from /proc (ADR-0026 §6)")
		}
	}
}
