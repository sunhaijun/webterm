package session

// SetChildOOMAdjForTest sets the target oom_score_adj for session shells and
// returns a function that restores it. IT-oom-1 uses it to exercise the real
// /proc without privileges by setting a target above the agent's own value
// (raising needs no privilege, and restoring never goes below the floor).
func SetChildOOMAdjForTest(v int) (restore func()) {
	old := childOOMAdj
	childOOMAdj = v
	return func() { childOOMAdj = old }
}

// BusyForTest reports whether something other than the shell is in the
// session's foreground.
func BusyForTest(s *Session) bool { return s.busy() }

// ShellPIDForTest returns the pid of the session's shell.
func ShellPIDForTest(s *Session) int { return s.proc.Pid }
