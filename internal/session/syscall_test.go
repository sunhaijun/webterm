package session_test

import (
	"os"
	"strconv"
	"strings"
	"syscall"
)

// processAlive reports whether a process is still running.
//
// kill(pid, 0) alone isn't enough because it succeeds for zombies. A zombie runs
// no code and holds no resources while it waits to be reaped, so for "is the
// program still running after the session closed" it counts as dead.
func processAlive(pid int) bool {
	if err := syscall.Kill(pid, 0); err != nil {
		return false
	}
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return false
	}
	i := strings.LastIndexByte(string(b), ')')
	if i < 0 || i+2 >= len(b) {
		return false
	}
	fields := strings.Fields(string(b[i+2:]))
	return len(fields) > 0 && fields[0] != "Z"
}
