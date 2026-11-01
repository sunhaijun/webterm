package session_test

import (
	"os"
	"testing"

	"github.com/sunhaijun/webterm/internal/session"
)

// unsetEnv removes an environment variable for the duration of the test and
// restores it afterward (t.Setenv can set but not unset).
func unsetEnv(t *testing.T, key string) {
	t.Helper()
	old, had := os.LookupEnv(key)
	if !had {
		return
	}
	os.Unsetenv(key)
	t.Cleanup(func() { os.Setenv(key, old) })
}

// envHarness starts a session that reads no dotfiles (bash --norc
// --noprofile), so the environment holds only what we inject and assertions
// are deterministic.
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

// showEnv makes the session print a variable.
//
// The marker must appear only in the output. The PTY echoes the command, so
// the output is `KEY[value]` while the command says `KEY[%s]`, and the echo
// can't match the assertion.
func showEnv(t *testing.T, s *session.Session, c *fakeConn, key string) {
	t.Helper()
	if err := c.Send(s, "printf '"+key+"[%s]\\n' \"$"+key+"\"\r"); err != nil {
		t.Fatal(err)
	}
}

// IT-sessionenv-1: --session-env is injected into the session PTY (AC-7.8).
func TestITSessionEnv1_Injected(t *testing.T) {
	s, c := envHarness(t, session.Config{
		SessionEnv: []string{"WEBTERM_TEST_ONE=hello", "WEBTERM_TEST_TWO=world"},
	})
	showEnv(t, s, c, "WEBTERM_TEST_ONE")
	waitScreen(t, c, "WEBTERM_TEST_ONE[hello]")
	showEnv(t, s, c, "WEBTERM_TEST_TWO")
	waitScreen(t, c, "WEBTERM_TEST_TWO[world]")
}

// IT-sessionenv-2: the built-in compat list applies by default and
// --no-altscreen-compat turns it off (AC-7.8).
//
// This is the point of ADR-0024 step 1: only when claude stays off the
// alternate screen is its output an append-only stream the user can scroll
// back through.
func TestITSessionEnv2_AltScreenCompat(t *testing.T) {
	t.Run("injected by default", func(t *testing.T) {
		s, c := envHarness(t, session.Config{})
		showEnv(t, s, c, "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN")
		waitScreen(t, c, "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN[1]")
	})
	t.Run("--no-altscreen-compat disables it", func(t *testing.T) {
		// Sessions inherit the agent's environment. When tests run inside a
		// webterm session, this process already has the variable from the
		// list; clear it so the assertion checks that disabling stops the
		// injection.
		unsetEnv(t, "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN")
		s, c := envHarness(t, session.Config{NoAltScreenCompat: true})
		showEnv(t, s, c, "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN")
		waitScreen(t, c, "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN[]")
	})
}

// IT-sessionenv-3: values the user already set are not overridden,
// --session-env overrides the compat list, and TERM / WEBTERM_SESSION are fixed
// by webterm (AC-7.8).
func TestITSessionEnv3_Precedence(t *testing.T) {
	t.Run("user env wins over compat list", func(t *testing.T) {
		t.Setenv("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN", "0")
		s, c := envHarness(t, session.Config{})
		showEnv(t, s, c, "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN")
		waitScreen(t, c, "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN[0]")
	})
	t.Run("--session-env overrides compat list", func(t *testing.T) {
		s, c := envHarness(t, session.Config{
			SessionEnv: []string{"CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=0"},
		})
		showEnv(t, s, c, "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN")
		waitScreen(t, c, "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN[0]")
	})
	t.Run("TERM cannot be overridden", func(t *testing.T) {
		// The flag layer already rejects --session-env TERM=...; this is the
		// second guard, for callers that build Config directly (tests, future
		// entry points).
		s, c := envHarness(t, session.Config{SessionEnv: []string{"TERM=dumb"}})
		showEnv(t, s, c, "TERM")
		waitScreen(t, c, "TERM[xterm-256color]")
	})
}
