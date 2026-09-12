package session

import (
	"os"

	"golang.org/x/sys/unix"
)

// setWinsize 给 PTY 设窗口大小。
//
// 【不能用 pty.Setsize】：它内部调 f.Fd()，而 Go 的 (*os.File).Fd() 会把一个可轮询
// 的文件切回阻塞模式、摘出 poller —— 之后 SetReadDeadline 失效，热升级时就
// 打断不了 readLoop（ADR-0016）。走 SyscallConn.Control 拿 fd 做 ioctl 不改模式。
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
