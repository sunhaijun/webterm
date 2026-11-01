package session

import (
	"os"
	"strconv"
	"strings"
	"syscall"
)

// killSession signals every process in POSIX session sid, skipping the agent
// itself.
//
// kill(-pgid) is not enough: interactive bash runs with job control, so each
// job has its own process group (`sleep 300 &` has a different pgid from the
// shell), and signaling the shell's group reaches only the shell.
//
// The graceful path relies on bash forwarding SIGHUP to its jobs, which works
// fine. On the SIGKILL fallback bash has no chance to forward, and jobs would
// keep running as orphans, so the whole session has to be swept.
//
// pty.Start calls setsid, so the shell's session id equals its pid and every
// descendant inherits it. Processes that detach with setsid (nohup, setsid,
// systemd-run) escape, which is what the user asked for.
func killSession(sid int, sig syscall.Signal) {
	self := os.Getpid()
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return
	}
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid == self || pid == sid {
			continue
		}
		if procSessionID(pid) == sid {
			_ = syscall.Kill(pid, sig)
		}
	}
}

// procSessionID returns field 6 (session id) of /proc/<pid>/stat, or -1 if it
// can't be read.
func procSessionID(pid int) int {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return -1
	}
	// comm is parenthesized and may contain spaces and ')', so split at the
	// last ')'.
	i := strings.LastIndexByte(string(b), ')')
	if i < 0 || i+2 >= len(b) {
		return -1
	}
	// After ')': state ppid pgrp session ...
	fields := strings.Fields(string(b[i+2:]))
	if len(fields) < 4 {
		return -1
	}
	s, err := strconv.Atoi(fields[3])
	if err != nil {
		return -1
	}
	return s
}
