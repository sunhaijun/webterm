package session

import (
	"errors"
	"os"
	"strconv"
	"time"

	"golang.org/x/sys/unix"

	"github.com/sunhaijun/webterm/internal/protocol"
)

// 工作目录改读 /proc（ADR-0026 §6）：不需要 shell 配合，任何 shell 都适用。
//
//	pgrp := ioctl(ptmx, TIOCGPGRP)       PTY 的前台进程组
//	cwd  := readlink(/proc/<pgrp>/cwd)
//
// 前台进程组的组长就是用户此刻在用的程序（shell、vim、claude…），它的目录
// 就是用户认为"我在哪"。ssh 出去之后显示的是本机 ssh 进程的目录 —— 远端的
// 目录本来就不可知。
//
// 同一次轮询也看终端标题（ADR-0043）：前台程序设的标题优先于目录名，见 title.go。

// foregroundPgrp 返回 PTY 的前台进程组 id。
//
// 【不能对 ptmx 调 Fd()】：那会把可轮询的文件切回阻塞模式（见 winsize.go），
// 走 SyscallConn.Control 拿 fd 做 ioctl 不改模式。
func foregroundPgrp(f *os.File) (int, error) {
	if f == nil {
		return 0, errors.New("session: 没有 ptmx")
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

// processCWD 读 /proc/<pid>/cwd。
func processCWD(pid int) (string, error) {
	return os.Readlink("/proc/" + strconv.Itoa(pid) + "/cwd")
}

// cwdLoop 每 interval 读一次前台进程组的工作目录与终端标题，变了就广播。
// 会话退出就停；热升级冻结期间跳过（交接快照拍下之后状态不该再变）。
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

// poll 读一次前台进程组的工作目录与终端标题，目录或名字变了就广播一条
// session.updated（只带变了的字段，AC-4.4）。读不到前台进程组就跳过这一轮；
// 读不到目录（进程刚退出、权限）只是不更新目录，不清空已有的 cwd。
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
	if writes != s.titleSeen { // 有人设过标题：归到此刻的前台进程组名下
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

// busy 报告这个会话是否有命令在跑：PTY 的前台进程组不是 shell 自己。
//
// 交互式 shell 开着 job control，停在提示符时前台进程组就是 shell（pty.Start
// 已 setsid，shell 的 pid == 它的进程组 id）；跑命令时前台换成那条命令的进程组。
// 已退出的会话、读不到前台进程组的会话算空闲 —— --when-idle 等的是"没人在干活"，
// 看不清的不该把升级卡住。
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
