package session

import (
	"os"

	"golang.org/x/sys/unix"
)

// setWinsize sets the PTY window size.
//
// It can't use pty.Setsize, which calls f.Fd(). (*os.File).Fd() switches a
// pollable file back to blocking mode and removes it from the poller, after
// which SetReadDeadline stops working and a hot upgrade can't interrupt
// readLoop (ADR-0016). Getting the fd through SyscallConn.Control for the
// ioctl leaves the mode alone.
func setWinsize(f *os.File, cols, rows uint16) error {
	if f == nil {
		return nil
	}
	rc, err := f.SyscallConn()
	if err != nil {
		return err
	}
	var ierr error
	err = rc.Control(func(fd uintptr) {
		ierr = unix.IoctlSetWinsize(int(fd), unix.TIOCSWINSZ, &unix.Winsize{Row: rows, Col: cols})
	})
	if err != nil {
		return err
	}
	return ierr
}
