package session_test

import "syscall"

// syscallKillZero 用信号 0 探测进程是否还在。返回 nil 表示进程仍存活。
func syscallKillZero(pid int) error { return syscall.Kill(pid, 0) }
