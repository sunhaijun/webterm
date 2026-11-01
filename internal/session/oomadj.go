package session

import (
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"
)

// OOM priority for session shells (ADR-0034 §3).
//
// The system service runs the agent at -900 (last to be killed under memory
// pressure). Sessions should be at 0, like SSH logins and tmux panes. The shell
// must be at 0 before it runs any user code: a daemon started from ~/.profile
// (ssh-agent and the like) that inherits -900 stays protected forever. So
// rather than fixing /proc/<pid>/oom_score_adj after the shell starts, the
// agent temporarily sets itself to 0 around the fork.
//
// Raising the value needs no privilege, and lowering it back to the original
// value doesn't go below the floor (the value PID 1 wrote as root), so the
// round trip works as an ordinary user.

const oomAdjPath = "/proc/self/oom_score_adj"

var (
	// childOOMAdj is the target value for session shells. The agent switches
	// only when its own value is lower. Tests change it with
	// SetChildOOMAdjForTest.
	childOOMAdj = 0

	readOOMAdj = func() (int, error) {
		raw, err := os.ReadFile(oomAdjPath)
		if err != nil {
			return 0, err
		}
		return strconv.Atoi(strings.TrimSpace(string(raw)))
	}
	writeOOMAdj = func(v int) error {
		return os.WriteFile(oomAdjPath, []byte(strconv.Itoa(v)), 0)
	}

	// spawnMu serializes raise, fork, restore. oom_score_adj is per process: if
	// two sessions start at once, the first to finish restores the value and
	// the other's child inherits -900.
	spawnMu sync.Mutex
)

// withChildOOMAdj runs start with the agent's oom_score_adj temporarily set to
// childOOMAdj. It does nothing when the agent is already at or above it (0 for
// a manual webterm serve, 200 for the user service).
//
// start must return only after the child has exec'ed, as cmd.Start does. Go
// spawns children with CLONE_VM|CLONE_VFORK, and the kernel propagates
// oom_score_adj changes to processes sharing the mm, so restoring before exec
// would drag the child back too.
//
// A failed switch never blocks starting the shell. If raising fails, the child
// inherits the agent's value (degraded, nothing worse); if restoring fails, the
// agent stays at the target value, like tmux. Both are only logged.
func withChildOOMAdj(start func() error) error {
	spawnMu.Lock()
	defer spawnMu.Unlock()

	self, err := readOOMAdj()
	if err != nil || self >= childOOMAdj {
		return start()
	}
	if err := writeOOMAdj(childOOMAdj); err != nil {
		slog.Warn("cannot raise oom_score_adj before starting the shell; the session inherits the agent's value", "self", self, "want", childOOMAdj, "err", err)
		return start()
	}
	defer func() {
		if err := writeOOMAdj(self); err != nil {
			slog.Warn("cannot restore oom_score_adj after starting the shell; the agent stays at the session's priority", "self", self, "now", childOOMAdj, "err", err)
		}
	}()
	return start()
}
