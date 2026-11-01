package session

import (
	"errors"
	"os"
	"strconv"
	"time"

	"golang.org/x/sys/unix"

	"github.com/sunhaijun/webterm/internal/protocol"
)

// The working directory comes from /proc (ADR-0026 §6), which needs no shell
// cooperation and works with any shell:
//
//	pgrp := ioctl(ptmx, TIOCGPGRP)       the PTY's foreground process group
//	cwd  := readlink(/proc/<pgrp>/cwd)
//
// The foreground group leader is the program the user is using right now
// (shell, vim, claude, ...), and its directory is where the user thinks they
// are. After ssh'ing out it shows the local ssh process's directory; the
// remote one is unknowable anyway.
//
// The same poll also checks the terminal title (ADR-0043): a title set by the
// foreground program takes precedence over the directory name; see title.go.

// foregroundPgrp returns the PTY's foreground process group id.
//
// It must not call Fd() on ptmx, which would switch the pollable file back to
// blocking mode (see winsize.go). The ioctl goes through SyscallConn.Control,
// which leaves the mode alone.
func foregroundPgrp(f *os.File) (int, error) {
	if f == nil {
		return 0, errors.New("session: no ptmx")
	}
	rc, err := f.SyscallConn()
	if err != nil {
		return 0, err
	}
	var pgrp int
	var ierr error
	err = rc.Control(func(fd uintptr) {
		pgrp, ierr = unix.IoctlGetInt(int(fd), unix.TIOCGPGRP)
	})
	if err != nil {
		return 0, err
	}
	return pgrp, ierr
}

// processCWD reads /proc/<pid>/cwd.
func processCWD(pid int) (string, error) {
	return os.Readlink("/proc/" + strconv.Itoa(pid) + "/cwd")
}

// cwdLoop reads the foreground process group's working directory and the
// terminal title every interval and broadcasts changes. It stops when the
// session exits and skips polls during a hot-upgrade freeze, since state must
// not change after the handoff snapshot is taken.
func (s *Session) cwdLoop(interval time.Duration) {
	if interval <= 0 {
		interval = time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-t.C:
			if s.fz.isFrozen() {
				continue
			}
			s.poll()
		}
	}
}

// poll reads the foreground process group's working directory and the
// terminal title once, and broadcasts a session.updated with only the changed
// fields if the directory or name changed (AC-4.4). If the foreground group
// can't be read, the round is skipped. If the directory can't be read (the
// process just exited, permissions), the existing cwd is kept.
func (s *Session) poll() {
	pgrp, err := foregroundPgrp(s.ptmx)
	if err != nil || pgrp <= 0 {
		return
	}
	cwd, err := processCWD(pgrp)
	if err != nil {
		cwd = ""
	}
	shell := 0
	if s.proc != nil {
		shell = s.proc.Pid
	}

	s.mu.Lock()
	oldName := s.displayNameLocked()
	upd := &protocol.SessionUpdated{SID: s.sid}
	if cwd != "" && cwd != s.cwd {
		s.cwd = cwd
		upd.CWD = strPtr(cwd)
	}
	raw, writes := s.term.Title()
	if writes != s.titleSeen { // a title was set: attribute it to the current foreground group
		s.titleSeen = writes
		s.titlePgrp = pgrp
	}
	s.title = pickTitle(raw, pgrp, s.titlePgrp, shell)
	if name := s.displayNameLocked(); name != oldName {
		upd.Name = strPtr(name)
	}
	s.mu.Unlock()
	if upd.CWD != nil || upd.Name != nil {
		s.emit(upd)
	}
}

// busy reports whether the session is running a command, meaning the PTY's
// foreground process group is not the shell itself.
//
// An interactive shell runs with job control. At the prompt the foreground
// group is the shell (pty.Start calls setsid, so the shell's pid equals its
// pgid); while a command runs, it is that command's group. Exited sessions and
// sessions whose foreground group can't be read count as idle: --when-idle
// waits for "nobody is working", and an unknown state shouldn't block the
// upgrade.
func (s *Session) busy() bool {
	s.mu.RLock()
	running := s.status == protocol.StatusRunning
	s.mu.RUnlock()
	if !running || s.proc == nil {
		return false
	}
	pgrp, err := foregroundPgrp(s.ptmx)
	if err != nil || pgrp <= 0 {
		return false
	}
	return pgrp != s.proc.Pid
}
