package session_test

import (
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/session"
)

// ptmxFDs 数某个进程手里有几个 /dev/ptmx（别的会话的 master）。
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

// agent 手里的 master 都带 CLOEXEC：后起的 shell 不能继承先前会话的 master ——
// 否则关掉的会话的 pty 释放不了，别的会话里的进程还能读写它。热升级接回来的 fd
// 在交接时清过 CLOEXEC，接回之后要置回来。
func TestLaterShellInheritsNoMaster(t *testing.T) {
	m := session.NewManager(cfg())
	create(t, m)
	if n := ptmxFDs(t, session.ShellPIDForTest(create(t, m))); n != 0 {
		t.Fatalf("新建的 shell 拿着 %d 个别的会话的 master", n)
	}

	// 交接之后再建
	if err := m.Freeze(2 * time.Second); err != nil {
		t.Fatal(err)
	}
	snap, err := m.Export("test")
	if err != nil {
		t.Fatal(err)
	}
	m2 := session.NewManager(cfg())
	t.Cleanup(m2.Shutdown) // 旧 Manager 不 Shutdown：shell 已经交给 m2
	if err := m2.Restore(snap); err != nil {
		t.Fatal(err)
	}
	if n := ptmxFDs(t, session.ShellPIDForTest(create(t, m2))); n != 0 {
		t.Fatalf("交接后新建的 shell 拿着 %d 个别的会话的 master", n)
	}
}
