package session_test

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/sunhaijun/webterm/internal/session"
)

func selfOOMAdj(t *testing.T) int {
	t.Helper()
	raw, err := os.ReadFile("/proc/self/oom_score_adj")
	if err != nil {
		t.Skipf("cannot read /proc/self/oom_score_adj: %v", err)
	}
	v, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// IT-oom-1 (ADR-0034 §3): real /proc, real PTYs. The child target is self+100,
// the same direction as production's "agent -900, shell 0" (child above
// agent) but without privileges. Several sessions start concurrently; every
// shell gets the target and the agent ends back at self.
func TestITOOM1_ShellGetsChildAdj(t *testing.T) {
	self := selfOOMAdj(t)
	if self > 900 {
		t.Skipf("oom_score_adj = %d, no room to raise it", self)
	}
	target := self + 100
	defer session.SetChildOOMAdjForTest(target)()

	m := newManager(t, cfg())
	const n = 4
	sessions := make([]*session.Session, n)
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s, err := m.Create(session.Spec{CWD: t.TempDir(), Cols: 80, Rows: 24})
			if err != nil {
				errs <- err
				return
			}
			sessions[i] = s
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}

	if got := selfOOMAdj(t); got != self {
		t.Errorf("agent after starting sessions = %d, want back at %d", got, self)
	}

	// The shell reports its own value ($$ is the shell's pid). The echoed input
	// reads "OOM=$(...", which can't be confused with "OOM=<number>".
	want := fmt.Sprintf("OOM=%d.", target)
	for i, s := range sessions {
		c := newConn(t, m, fmt.Sprintf("tab-%d", i))
		s.Subscribe(c, 0, 0, 0)
		if err := s.Write(c.ClientID(), 0, []byte("echo OOM=$(cat /proc/$$/oom_score_adj).\r")); err != nil {
			t.Fatal(err)
		}
		waitScreen(t, c, want)
	}
}
