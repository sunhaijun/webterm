package session_test

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/session"
)

func cfg() session.Config {
	return session.Config{MaxSessions: 5, RingBytes: 64 << 10, Shell: "bash"}
}

func create(t *testing.T, m *session.Manager) *session.Session {
	t.Helper()
	s, err := m.Create(session.Spec{CWD: t.TempDir(), Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// IT-session-1：多会话各自独立 PTY、独立缓冲、独立序列号。
func TestITSession1_Independence(t *testing.T) {
	m := newManager(t, cfg())
	a, b := create(t, m), create(t, m)
	if a.SID() == b.SID() {
		t.Fatal("两个会话拿到了同一个 sid")
	}

	ca, cb := newConn(t, m, "tab-a"), newConn(t, m, "tab-b")
	a.Subscribe(ca, 0)
	b.Subscribe(cb, 0)

	if err := a.Write("tab-a", 0, []byte("echo AAA-marker\r")); err != nil {
		t.Fatal(err)
	}
	if err := b.Write("tab-b", 0, []byte("echo BBB-marker\r")); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, ca, "AAA-marker")
	waitScreen(t, cb, "BBB-marker")

	if strings.Contains(ca.Screen(), "BBB-marker") {
		t.Error("会话 A 的输出里混进了 B 的内容")
	}
	if strings.Contains(cb.Screen(), "AAA-marker") {
		t.Error("会话 B 的输出里混进了 A 的内容")
	}
	// 序列号各自独立：两个会话的 head_seq 无关
	if a.HeadSeq() == 0 || b.HeadSeq() == 0 {
		t.Fatal("head_seq 没有推进")
	}
}

// IT-session-2：会话数上限。
func TestITSession2_Limit(t *testing.T) {
	c := cfg()
	c.MaxSessions = 2
	m := newManager(t, c)
	create(t, m)
	create(t, m)
	_, err := m.Create(session.Spec{CWD: t.TempDir(), Cols: 80, Rows: 24})
	if err != session.ErrSessionLimit {
		t.Fatalf("err = %v, want ErrSessionLimit", err)
	}
	// 关掉一个之后又能建了
	if _, err := m.Close(m.List()[0].SID()); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Create(session.Spec{CWD: t.TempDir(), Cols: 80, Rows: 24}); err != nil {
		t.Fatalf("关闭后仍无法新建: %v", err)
	}
}

// IT-session-3：自动命名跟随 CWD，手动改名后停止跟随（AC-4.4）。
func TestITSession3_AutoNaming(t *testing.T) {
	m := newManager(t, cfg())
	dir := t.TempDir()
	sub := dir + "/myproject"
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	s, err := m.Create(session.Spec{CWD: sub, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	if got := s.Snapshot().Name; got != "myproject" {
		t.Fatalf("默认名 = %q, want 目录 basename", got)
	}
	if s.Snapshot().NameIsManual {
		t.Fatal("默认名不该是手动名")
	}

	manual := "构建"
	s.Rename(&manual)
	snap := s.Snapshot()
	if snap.Name != manual || !snap.NameIsManual {
		t.Fatalf("改名后 = %+v", snap)
	}
	// 传 nil 恢复自动
	s.Rename(nil)
	if snap := s.Snapshot(); snap.Name != "myproject" || snap.NameIsManual {
		t.Fatalf("恢复自动后 = %+v", snap)
	}
}

// IT-session-4：shell 退出后状态变 exited 并携带退出码；缓冲保留可查看（AC-4.5）。
func TestITSession4_ExitedKeepsBuffer(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0)

	if err := c.Send(s, "echo before-exit\rexit 3\r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "会话退出", func() bool { return s.Status() == protocol.StatusExited })

	snap := s.Snapshot()
	if snap.ExitCode == nil || *snap.ExitCode != 3 {
		t.Fatalf("退出码 = %v, want 3", snap.ExitCode)
	}
	// 缓冲保留：切走再回来仍能看到退出前的输出
	if !strings.Contains(c.Screen(), "before-exit") {
		t.Fatal("退出前的输出丢了")
	}
	replay := newConn(t, m, "tab2")
	s.Subscribe(replay, 0)
	if !strings.Contains(replay.Screen(), "before-exit") {
		t.Fatal("exited 会话的缓冲没有保留，无法回看最后的报错")
	}
	// exited 会话不接受输入
	if err := c.Send(s, "echo nope\r"); err != session.ErrSessionExited {
		t.Fatalf("向已退出的会话写入 err = %v, want ErrSessionExited", err)
	}
}

// IT-session-5：关闭会话必须杀掉整个进程组，否则子进程会变成孤儿继续跑。
func TestITSession5_CloseKillsProcessGroup(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0)

	// 起一个后台子进程，把它的 pid 打出来
	marker := t.TempDir() + "/child.pid"
	cmd := fmt.Sprintf("sleep 300 & echo $! > %s; echo spawned\r", marker)
	if err := c.Send(s, cmd); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "spawned")

	var pid int
	waitFor(t, "子进程 pid 落盘", func() bool {
		b, err := os.ReadFile(marker)
		if err != nil {
			return false
		}
		_, err = fmt.Sscanf(strings.TrimSpace(string(b)), "%d", &pid)
		return err == nil && pid > 0
	})

	if _, err := m.Close(s.SID()); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "后台作业被回收", func() bool { return !processAlive(pid) })
}

// 忽略 SIGHUP 的后台作业也必须被清掉 —— 这条走的是 SIGKILL 兜底路径。
//
// 交互式 bash 开着 job control，后台作业在【自己的】进程组里，kill(-pgid)
// 根本打不到它。优雅路径靠 bash 转发 SIGHUP；作业把 SIGHUP 屏蔽了的话，
// 只剩按会话清扫这一条路。
func TestCloseKillsHupImmuneJob(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0)

	marker := t.TempDir() + "/child.pid"
	script := fmt.Sprintf(
		`bash -c 'trap "" HUP; echo $$ > %s; sleep 300' & printf 'SPAWN-%%s\n' OK`+"\r",
		marker)
	if err := c.Send(s, script); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "SPAWN-OK")

	var pid int
	waitFor(t, "子进程 pid 落盘", func() bool {
		b, err := os.ReadFile(marker)
		if err != nil {
			return false
		}
		_, err = fmt.Sscanf(strings.TrimSpace(string(b)), "%d", &pid)
		return err == nil && pid > 0
	})
	if !processAlive(pid) {
		t.Fatal("测试前提不成立：子进程还没起来")
	}

	if _, err := m.Close(s.SID()); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "屏蔽 SIGHUP 的作业也被杀掉", func() bool { return !processAlive(pid) })
}

// 关闭 exited 会话不需要走信号流程，且必须是幂等的。
func TestCloseExitedSession(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	if err := s.Write("tab", 0, []byte("exit 0\r")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "退出", func() bool { return s.Status() == protocol.StatusExited })

	start := time.Now()
	if _, err := m.Close(s.SID()); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("关闭 exited 会话花了 %v —— 不该等信号宽限期", d)
	}
	if _, err := m.Close(s.SID()); err != session.ErrUnknownSession {
		t.Fatalf("重复关闭 err = %v, want ErrUnknownSession", err)
	}
}

// sid 不复用刚释放的值 —— 避免"客户端还没处理完 sid=N 的关闭，新会话又叫 sid=N"。
func TestSIDNotImmediatelyReused(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	sid := s.SID()
	if _, err := m.Close(sid); err != nil {
		t.Fatal(err)
	}
	s2 := create(t, m)
	if s2.SID() == sid {
		t.Fatalf("sid %d 被立刻复用了", sid)
	}
}

// resize 会真的作用到 PTY 上。
func TestResizeAppliesToPTY(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0)

	if err := s.Resize(100, 30); err != nil {
		t.Fatal(err)
	}
	if err := c.Send(s, "stty size\r"); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "30 100")

	if err := s.Resize(0, 24); err == nil {
		t.Fatal("cols=0 应当被拒绝")
	}
}
