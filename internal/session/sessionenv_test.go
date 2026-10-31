package session_test

import (
	"testing"

	"github.com/sunhaijun/webterm/internal/session"
)

// envHarness 起一个不读 dotfile 的会话：bash --norc --noprofile，
// 环境里只有我们注入的那些，断言才有确定性。
func envHarness(t *testing.T, cfg session.Config) (*session.Session, *fakeConn) {
	t.Helper()
	cfg.MaxSessions, cfg.RingBytes, cfg.Shell, cfg.ShellArgs = 5, 1<<20, "bash", testShellArgs
	m := newManager(t, cfg)
	s, err := m.Create(session.Spec{Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0, 0, 0)
	return s, c
}

// showEnv 让会话把某个变量打出来。
//
// 【标记只能出现在输出里】：命令原文会被 PTY 回显，所以打印的是
// `KEY[值]` 而命令里写的是 `KEY[%s]` —— 回显那一份不会撞上断言。
func showEnv(t *testing.T, s *session.Session, c *fakeConn, key string) {
	t.Helper()
	if err := c.Send(s, "printf '"+key+"[%s]\\n' \"$"+key+"\"\r"); err != nil {
		t.Fatal(err)
	}
}

// IT-sessionenv-1：--session-env 注入到会话 PTY（AC-7.8）。
func TestITSessionEnv1_Injected(t *testing.T) {
	s, c := envHarness(t, session.Config{
		SessionEnv: []string{"WEBTERM_TEST_ONE=hello", "WEBTERM_TEST_TWO=world"},
	})
	showEnv(t, s, c, "WEBTERM_TEST_ONE")
	waitScreen(t, c, "WEBTERM_TEST_ONE[hello]")
	showEnv(t, s, c, "WEBTERM_TEST_TWO")
	waitScreen(t, c, "WEBTERM_TEST_TWO[world]")
}

// IT-sessionenv-2：内置兼容清单默认生效，--no-altscreen-compat 能关掉（AC-7.8）。
//
// 这条是 ADR-0024 第 1 步的全部意义所在：claude 不进备用屏，输出才是追加流，
// 用户才有 scrollback 可以往回拖。
func TestITSessionEnv2_AltScreenCompat(t *testing.T) {
	t.Run("默认注入", func(t *testing.T) {
		s, c := envHarness(t, session.Config{})
		showEnv(t, s, c, "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN")
		waitScreen(t, c, "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN[1]")
	})
	t.Run("--no-altscreen-compat 关掉", func(t *testing.T) {
		s, c := envHarness(t, session.Config{NoAltScreenCompat: true})
		showEnv(t, s, c, "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN")
		waitScreen(t, c, "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN[]")
	})
}

// IT-sessionenv-3：用户已经设过的不被覆盖；--session-env 压过清单；
// TERM / WEBTERM_SESSION 由 webterm 定死（AC-7.8）。
func TestITSessionEnv3_Precedence(t *testing.T) {
	t.Run("用户环境里已有 → 清单不覆盖", func(t *testing.T) {
		t.Setenv("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN", "0")
		s, c := envHarness(t, session.Config{})
		showEnv(t, s, c, "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN")
		waitScreen(t, c, "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN[0]")
	})
	t.Run("--session-env 压过清单", func(t *testing.T) {
		s, c := envHarness(t, session.Config{
			SessionEnv: []string{"CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=0"},
		})
		showEnv(t, s, c, "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN")
		waitScreen(t, c, "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN[0]")
	})
	t.Run("TERM 改不动", func(t *testing.T) {
		// flag 层已经拒了 --session-env TERM=...，这里守的是第二道：
		// 直接构造 Config 的调用方（测试、将来的别的入口）也不能把它改歪。
		s, c := envHarness(t, session.Config{SessionEnv: []string{"TERM=dumb"}})
		showEnv(t, s, c, "TERM")
		waitScreen(t, c, "TERM[xterm-256color]")
	})
}
