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
		t.Skipf("读不到 /proc/self/oom_score_adj：%v", err)
	}
	v, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// IT-oom-1（ADR-0034 §3）：真 /proc、真 PTY。子进程目标值调成 self+100 —— 和生产里
// 「agent -900、shell 0」是同一个方向（子进程比 agent 高），却不需要特权。
// 并发起几个会话，每个 shell 都拿到目标值，agent 最后回到 self。
func TestITOOM1_ShellGetsChildAdj(t *testing.T) {
	self := selfOOMAdj(t)
	if self > 900 {
		t.Skipf("oom_score_adj = %d，没有往上调的余地", self)
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
		t.Errorf("起完会话后 agent = %d，want 回到 %d", got, self)
	}

	// shell 自己报它的值（$$ 是 shell 的 pid）。输入的回显里是 "OOM=$(…"，
	// 不会和 "OOM=<数字>" 混淆。
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
