package session_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/session"
	"github.com/sunhaijun/webterm/internal/shellinit"
	"github.com/sunhaijun/webterm/internal/store"
)

// 降级路径：会话里换了 shell 之后，手动 eval 也要能把集成接回来。
//
// 这是 `webterm shell-init bash` 存在的理由（exec zsh / su / 进容器之后
// rcfile 注入的那份就失效了）。
func TestManualEvalRestoresIntegration(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	scriptPath := filepath.Join(home, "webterm-init.bash")
	if err := os.WriteFile(scriptPath, []byte(shellinit.Script()), 0o644); err != nil {
		t.Fatal(err)
	}

	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })

	// 【不】注入 rcfile —— 模拟"集成已经失效"的状态
	m := session.NewManager(session.Config{
		MaxSessions: 5, RingBytes: 1 << 20, Shell: "bash", History: true,
	}, st)
	t.Cleanup(m.Shutdown)

	s, err := m.Create(session.Spec{CWD: home, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0)

	if got := s.Snapshot().Integration; got != protocol.IntegrationInactive {
		t.Fatalf("前提不成立：integration = %q, want inactive", got)
	}

	// 手动接入
	if err := c.Send(s, "source "+scriptPath+"\r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "手动 eval 之后集成恢复", func() bool {
		return s.Snapshot().Integration == protocol.IntegrationActive
	})

	// 接回来之后命令记录也要开始工作
	if err := c.Send(s, "echo manual-eval-works\r"); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "manual-eval-works")
	waitQuiet(t, s, 300*time.Millisecond)

	cmds, err := st.ListCommands(store.Filter{Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, cmd := range cmds {
		if strings.Contains(cmd.Text, "manual-eval-works") {
			found = true
		}
	}
	if !found {
		t.Fatal("手动接入之后命令仍然没有落库")
	}
}

// 重复 source 不该把钩子装两遍（rcfile 注入 + 用户又手动 eval 一次）。
func TestDoubleSourceIsIdempotent(t *testing.T) {
	home := t.TempDir()
	runD := filepath.Join(t.TempDir(), "run")
	t.Setenv("HOME", home)
	scriptPath := filepath.Join(home, "webterm-init.bash")
	if err := os.WriteFile(scriptPath, []byte(shellinit.Script()), 0o644); err != nil {
		t.Fatal(err)
	}

	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })

	m := session.NewManager(session.Config{
		MaxSessions: 5, RingBytes: 1 << 20, Shell: "bash", History: true,
		RCFileFor: func(sid uint16) (string, error) {
			return shellinit.Render(sid, shellinit.Options{Dir: runD})
		},
	}, st)
	t.Cleanup(m.Shutdown)

	s, err := m.Create(session.Spec{CWD: home, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0)
	waitFor(t, "首次握手", func() bool {
		return s.Snapshot().Integration == protocol.IntegrationActive
	})

	// 再手动 source 一遍
	if err := c.Send(s, "source "+scriptPath+"\r"); err != nil {
		t.Fatal(err)
	}
	if err := c.Send(s, "echo after-double-source\r"); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "after-double-source")
	waitQuiet(t, s, 400*time.Millisecond)

	cmds, err := st.ListCommands(store.Filter{Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, cmd := range cmds {
		if strings.Contains(cmd.Text, "after-double-source") {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("重复 source 之后同一条命令被记了 %d 次，钩子装了两遍", n)
	}
}
