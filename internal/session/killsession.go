package session

import (
	"os"
	"strconv"
	"strings"
	"syscall"
)

// killSession 给会话 sid 下的所有进程发信号，跳过 self。
//
// 为什么不能只靠 kill(-pgid)：交互式 bash 开着 job control，**每个作业都在
// 自己的进程组里**（`sleep 300 &` 的 pgid ≠ shell 的 pgid）。所以给 shell
// 的进程组发信号只能打到 shell 自己。
//
// 优雅路径靠的是 bash 收到 SIGHUP 后自己给所有作业转发 SIGHUP —— 那条路走通
// 时一切正常。但 SIGKILL 兜底那条路上 bash 已经没机会转发了，作业就会变成
// 孤儿继续跑。这时必须按【会话】清扫。
//
// pty.Start 已经 setsid，所以 shell 的 sid == shell 的 pid，它的后代都继承
// 这个 sid。主动 setsid 脱离的进程（nohup / setsid / systemd-run）会逃掉 ——
// 那是用户明确的意图，符合预期。
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

// procSessionID 读 /proc/<pid>/stat 的第 6 个字段（session id）。读不到返回 -1。
func procSessionID(pid int) int {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return -1
	}
	// comm 字段用括号包着且可能含空格与右括号，所以从【最后一个】右括号切。
	i := strings.LastIndexByte(string(b), ')')
	if i < 0 || i+2 >= len(b) {
		return -1
	}
	// 右括号之后依次是：state ppid pgrp session …
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
