package session_test

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/session"
)

// "Waiting for you" (AC-4.3, ADR-0052): the agent sets a session's attention
// when the program signals it's your turn, and session.seen clears it.

// attentionUpdates returns the attention values a connection received in
// session.updated messages for sid, in order.
func attentionUpdates(c *fakeConn, sid uint16) []bool {
	var out []bool
	for _, e := range c.Events() {
		if u, ok := e.(*protocol.SessionUpdated); ok && u.SID == sid && u.Attention != nil {
			out = append(out, *u.Attention)
		}
	}
	return out
}

// staysAttention checks that attention keeps its value for a few poll
// intervals (cfg polls every 100ms).
func staysAttention(t *testing.T, s *session.Session, want bool, what string) {
	t.Helper()
	for range 6 {
		time.Sleep(100 * time.Millisecond)
		if got := s.Info().Attention; got != want {
			t.Fatalf("%s: attention = %v, want %v", what, got, want)
		}
	}
}

func send(t *testing.T, c *fakeConn, s *session.Session, line string) {
	t.Helper()
	if err := c.Send(s, line+"\r"); err != nil {
		t.Fatal(err)
	}
}

// IT-attention-1: a bell sets attention and every connection hears about it,
// subscribed or not; more bells while it's set send nothing; session.seen
// clears it for everyone; bells counted while it was set don't fire again; a
// seen with nothing to clear sends nothing; an unknown sid is an error.
func TestITAttention1_BellSetsSeenClears(t *testing.T) {
	c := cfg()
	c.LongCommand = time.Hour // only the bell in this test
	m := newManager(t, c)
	s := create(t, m)
	phone := newConn(t, m, "phone") // observer only, like a page showing another session
	laptop := newConn(t, m, "laptop")
	waitFor(t, "shell ready", func() bool { return s.HeadSeq() > 0 })
	if s.Info().Attention {
		t.Fatal("a new session has attention")
	}
	staysAttention(t, s, false, "prompt output alone")

	send(t, phone, s, `printf '\a'`)
	waitFor(t, "attention set", func() bool { return s.Info().Attention })
	for _, conn := range []*fakeConn{phone, laptop} {
		waitFor(t, conn.clientID+" gets attention:true", func() bool {
			u := attentionUpdates(conn, s.SID())
			return len(u) == 1 && u[0]
		})
	}

	send(t, phone, s, `printf '\a\a'`)
	staysAttention(t, s, true, "bells while set")
	if u := attentionUpdates(phone, s.SID()); len(u) != 1 {
		t.Fatalf("bells while set sent more updates: %v", u)
	}

	if err := m.Seen(s.SID()); err != nil {
		t.Fatal(err)
	}
	if s.Info().Attention {
		t.Fatal("attention still set after Seen")
	}
	for _, conn := range []*fakeConn{phone, laptop} {
		waitFor(t, conn.clientID+" gets attention:false", func() bool {
			u := attentionUpdates(conn, s.SID())
			return len(u) == 2 && !u[1]
		})
	}
	staysAttention(t, s, false, "bells counted while set")

	if err := m.Seen(s.SID()); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	if u := attentionUpdates(phone, s.SID()); len(u) != 2 {
		t.Fatalf("a seen with nothing to clear sent an update: %v", u)
	}

	if err := m.Seen(999); !errors.Is(err, session.ErrUnknownSession) {
		t.Fatalf("Seen(unknown) = %v, want ErrUnknownSession", err)
	}

	// A desktop notification sets it too.
	send(t, phone, s, `printf '\033]9;done\033\\'`)
	waitFor(t, "OSC 9 sets attention", func() bool { return s.Info().Attention })
}

// IT-attention-2: a title going from a spinner to idle sets attention. A title
// that was never busy doesn't, and neither does a busy title whose program
// exits (the title is no longer in use).
func TestITAttention2_TitleBusyToIdle(t *testing.T) {
	c := cfg()
	c.LongCommand = time.Hour // only the title in this test
	m := newManager(t, c)
	dir := filepath.Join(t.TempDir(), "proj")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	s, err := m.Create(session.Spec{CWD: dir, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	conn := newConn(t, m, "tab")
	waitFor(t, "shell ready", func() bool { return s.HeadSeq() > 0 })
	name := func() string { return s.Info().Name }

	send(t, conn, s, `bash -c 'printf "\033]0;plain\007"; exec sleep 30'`)
	waitFor(t, "name is the idle title", func() bool { return name() == "plain" })
	staysAttention(t, s, false, "a title that was never busy")
	send(t, conn, s, "\x03")
	waitFor(t, "back at the prompt", func() bool { return name() == "proj" })

	send(t, conn, s, `bash -c 'printf "\033]0;◐ work\007"; sleep 0.5'`)
	waitFor(t, "name is the busy title", func() bool { return name() == "◐ work" })
	waitFor(t, "program exited", func() bool { return name() == "proj" })
	staysAttention(t, s, false, "a busy title whose program exited")

	send(t, conn, s, `bash -c 'printf "\033]0;◐ work\007"; sleep 0.5; printf "\033]0;✳ done\007"; exec sleep 30'`)
	waitFor(t, "attention after ◐ → ✳", func() bool { return s.Info().Attention })
	if got := name(); got != "✳ done" {
		t.Fatalf("name = %q, want the idle title", got)
	}
}

// IT-attention-3: a command that ran for at least LongCommand sets attention
// when the shell is back in front; a shorter one doesn't.
func TestITAttention3_LongCommandFinishes(t *testing.T) {
	c := cfg()
	c.LongCommand = time.Second
	m := newManager(t, c)
	s := create(t, m)
	conn := newConn(t, m, "tab")
	waitFor(t, "shell ready", func() bool { return s.HeadSeq() > 0 })

	send(t, conn, s, "sleep 0.3")
	time.Sleep(500 * time.Millisecond)
	staysAttention(t, s, false, "a 0.3 s command")

	send(t, conn, s, "sleep 1.5")
	time.Sleep(700 * time.Millisecond)
	if s.Info().Attention {
		t.Fatal("attention while the command is still running")
	}
	waitFor(t, "attention after a 1.5 s command", func() bool { return s.Info().Attention })
}

// IT-attention-4: an attention set before the session exits stays until seen,
// and Seen works on an exited session.
func TestITAttention4_ExitedKeepsUntilSeen(t *testing.T) {
	c := cfg()
	c.LongCommand = time.Hour
	m := newManager(t, c)
	s := create(t, m)
	conn := newConn(t, m, "tab")
	waitFor(t, "shell ready", func() bool { return s.HeadSeq() > 0 })

	send(t, conn, s, `printf '\a'`)
	waitFor(t, "attention set", func() bool { return s.Info().Attention })
	send(t, conn, s, "exit")
	waitFor(t, "exited", func() bool { return s.Status() == protocol.StatusExited })
	if !s.Info().Attention {
		t.Fatal("exit cleared attention")
	}
	if err := m.Seen(s.SID()); err != nil {
		t.Fatal(err)
	}
	if s.Info().Attention {
		t.Fatal("Seen didn't clear attention on an exited session")
	}
}
