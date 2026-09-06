package session_test

import (
	"os"
	"strconv"
	"strings"
	"syscall"
)

// processAlive 报告进程是否还在【运行】。
//
// 不能只用 kill(pid, 0)：僵尸进程也会返回成功。僵尸已经不跑代码、不占资源，
// 等它的新父进程收尸而已 —— 对"会话关掉后程序还在跑吗"这个问题应当算死。
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
