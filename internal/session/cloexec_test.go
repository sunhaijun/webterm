package session_test

import (
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/session"
)

// ptmxFDs counts the /dev/ptmx fds (other sessions' masters) a process holds.
func ptmxFDs(t *testing.T, pid int) int {
	t.Helper()
	dir := "/proc/" + strconv.Itoa(pid) + "/fd"
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, e := range entries {
		if target, err := os.Readlink(dir + "/" + e.Name()); err == nil && target == "/dev/ptmx" {
			n++
		}
	}
	return n
}

// Every master the agent holds is CLOEXEC, so later shells can't inherit
// earlier sessions' masters. Otherwise a closed session's pty is never released
// and processes in other sessions can read and write it. Fds reattached after a
// hot upgrade had CLOEXEC cleared for the handoff and must get it back.
func TestLaterShellInheritsNoMaster(t *testing.T) {
	m := session.NewManager(cfg())
	create(t, m)
	if n := ptmxFDs(t, session.ShellPIDForTest(create(t, m))); n != 0 {
		t.Fatalf("new shell holds %d masters of other sessions", n)
	}

	// Create another one after a handoff.
	if err := m.Freeze(2 * time.Second); err != nil {
		t.Fatal(err)
	}
	snap, err := m.Export("test")
	if err != nil {
		t.Fatal(err)
	}
	m2 := session.NewManager(cfg())
	t.Cleanup(m2.Shutdown) // don't shut down the old Manager: its shells now belong to m2
	if err := m2.Restore(snap); err != nil {
		t.Fatal(err)
	}
	if n := ptmxFDs(t, session.ShellPIDForTest(create(t, m2))); n != 0 {
		t.Fatalf("shell created after handoff holds %d masters of other sessions", n)
	}
}
