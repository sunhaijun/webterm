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

// testShellArgs 让 bash 不读任何 dotfile：断言才有确定性。生产默认是登录 shell
// `-l -i`（见 TestLoginShellByDefault）。
var testShellArgs = []string{"--norc", "--noprofile", "-i"}

func cfg() session.Config {
	return session.Config{
		MaxSessions: 5, RingBytes: 64 << 10, Shell: "bash", ShellArgs: testShellArgs,
		CWDPollInterval: 100 * time.Millisecond,
	}
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
	a.Subscribe(ca, 0, 0, 0)
	b.Subscribe(cb, 0, 0, 0)

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

// IT-session-3：工作目录读 /proc/<前台进程组>/cwd，每秒一次，变了才发
// session.updated{cwd, name}；自动命名跟随 CWD，手动改名后停止跟随（AC-4.4）。
//
// 任何 shell 都适用 —— 这里的 bash 不带任何 dotfile，没有一行 shell 集成。
func TestITSession3_CWDPollingAndAutoNaming(t *testing.T) {
	m := newManager(t, cfg())
	dir := t.TempDir()
	sub := dir + "/myproject"
	other := dir + "/other"
	for _, d := range []string{sub, other} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	s, err := m.Create(session.Spec{CWD: sub, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	if got := s.Info().Name; got != "myproject" {
		t.Fatalf("默认名 = %q, want 目录 basename", got)
	}
	if s.Info().NameIsManual {
		t.Fatal("默认名不该是手动名")
	}
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0, 0, 0)

	// shell 里 cd：agent 自己从 /proc 读到，名字跟着变
	if err := c.Send(s, "cd "+other+"\r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "收到 session.updated{cwd, name}", func() bool {
		for _, e := range c.Events() {
			if u, ok := e.(*protocol.SessionUpdated); ok && u.SID == s.SID() &&
				u.CWD != nil && *u.CWD == other && u.Name != nil && *u.Name == "other" {
				return true
			}
		}
		return false
	})
	if info := s.Info(); info.CWD != other || info.Name != "other" {
		t.Fatalf("info = %+v", info)
	}

	// 目录没变就不再发：一秒一次的轮询不能变成一秒一条消息
	count := func() int {
		n := 0
		for _, e := range c.Events() {
			if u, ok := e.(*protocol.SessionUpdated); ok && u.CWD != nil {
				n++
			}
		}
		return n
	}
	before := count()
	time.Sleep(500 * time.Millisecond) // 5 个轮询周期
	if got := count(); got != before {
		t.Fatalf("目录没变却又发了 %d 条 cwd 更新", got-before)
	}

	// 前台程序的目录：跑起来的命令在哪，用户就"在哪"
	if err := c.Send(s, "(cd "+sub+" && exec sleep 30)\r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "前台命令的目录被读到", func() bool { return s.Info().CWD == sub })
	if err := c.Send(s, "\x03"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "回到提示符后目录跟回 shell", func() bool { return s.Info().CWD == other })

	manual := "构建"
	s.Rename(&manual)
	info := s.Info()
	if info.Name != manual || !info.NameIsManual {
		t.Fatalf("改名后 = %+v", info)
	}
	// 手动名不跟随 CWD
	if err := c.Send(s, "cd "+sub+"\r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "cwd 跟上", func() bool { return s.Info().CWD == sub })
	if got := s.Info().Name; got != manual {
		t.Fatalf("手动名被 CWD 改掉了: %q", got)
	}
	// 传 nil 恢复自动
	s.Rename(nil)
	if info := s.Info(); info.Name != "myproject" || info.NameIsManual {
		t.Fatalf("恢复自动后 = %+v", info)
	}
}

// IT-session-6：前台程序设的终端标题作自动名（AC-4.4，ADR-0043）。
//
// shell 在提示符时设的标题不用；前台程序设的用；程序退出回到目录名；再启动的程序
// 设标题之前不沿用上一次的，设了一模一样的也认得出（看写入次数，不看内容）；手动名优先。
func TestITSession6_TerminalTitleAutoNaming(t *testing.T) {
	m := newManager(t, cfg())
	dir := t.TempDir() + "/proj"
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	s, err := m.Create(session.Spec{CWD: dir, Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0, 0, 0)
	waitFor(t, "shell 就绪", func() bool { return s.HeadSeq() > 0 })
	name := func() string { return s.Info().Name }
	stays := func(what, want string) {
		t.Helper()
		for range 5 { // 5 个轮询周期
			time.Sleep(100 * time.Millisecond)
			if got := name(); got != want {
				t.Fatalf("%s：名字 = %q, want %q", what, got, want)
			}
		}
	}

	// shell 自己设的（printf 是内建命令，前台就是 shell）：不用
	if err := c.Send(s, `printf '\033]0;SHELL TITLE\007'`+"\r"); err != nil {
		t.Fatal(err)
	}
	stays("shell 设的标题", "proj")

	// 前台程序设的：用，并且发 session.updated{name}
	prog := `bash -c 'printf "\033]0;PROG TITLE\007"; exec sleep 30'` + "\r"
	if err := c.Send(s, prog); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "名字变成程序设的标题", func() bool { return name() == "PROG TITLE" })
	waitFor(t, "发了 session.updated{name}", func() bool {
		for _, e := range c.Events() {
			if u, ok := e.(*protocol.SessionUpdated); ok && u.Name != nil && *u.Name == "PROG TITLE" {
				return true
			}
		}
		return false
	})
	if s.Info().NameIsManual {
		t.Fatal("标题不是手动名")
	}

	// 手动名优先；恢复自动后又是标题（程序还在前台）
	manual := "构建"
	s.Rename(&manual)
	stays("手动名", manual)
	s.Rename(nil)
	if got := name(); got != "PROG TITLE" {
		t.Fatalf("恢复自动后 = %q", got)
	}

	// 程序退出、回到提示符：回到目录名
	if err := c.Send(s, "\x03"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "回到目录名", func() bool { return name() == "proj" })

	// 再起一个不设标题的程序：不沿用上一次的标题
	if err := c.Send(s, "sleep 30\r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "sleep 在前台", func() bool { return s.Info().CWD == dir && session.BusyForTest(s) })
	stays("没设标题的新程序", "proj")
	if err := c.Send(s, "\x03"); err != nil {
		t.Fatal(err)
	}

	// 新程序设了一模一样的标题：认得出
	if err := c.Send(s, prog); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "同样的标题再设一次也采用", func() bool { return name() == "PROG TITLE" })
	if err := c.Send(s, "\x03"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "又回到目录名", func() bool { return name() == "proj" })
}

// IT-session-4：shell 退出后状态变 exited 并携带退出码；缓冲保留可查看（AC-4.5）。
func TestITSession4_ExitedKeepsBuffer(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0, 0, 0)

	if err := c.Send(s, "echo before-exit\rexit 3\r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "会话退出", func() bool { return s.Status() == protocol.StatusExited })

	info := s.Info()
	if info.ExitCode == nil || *info.ExitCode != 3 {
		t.Fatalf("退出码 = %v, want 3", info.ExitCode)
	}
	// 缓冲保留：切走再回来仍能看到退出前的输出
	if !strings.Contains(c.Screen(), "before-exit") {
		t.Fatal("退出前的输出丢了")
	}
	// 模拟器保留：已退出的会话订阅照样拿快照（刷新页面也能回看最后的报错）
	replay := newConn(t, m, "tab2")
	if st, _ := s.Subscribe(replay, 0, 0, 0); st != protocol.ResumeSnapshot {
		t.Fatalf("status = %q, want snapshot", st)
	}
	if !strings.Contains(render(replay, 80, 24), "before-exit") {
		t.Fatal("exited 会话的快照里没有退出前的输出，无法回看最后的报错")
	}
	// 已退出的会话照样能增量续传（ring 也保留着）
	incr := newConn(t, m, "tab3")
	if st, _ := s.Subscribe(incr, 1, 0, 0); st != protocol.ResumeOK {
		t.Fatalf("status = %q, want ok", st)
	}
	// exited 会话不接受输入
	if err := c.Send(s, "echo nope\r"); err != session.ErrSessionExited {
		t.Fatalf("向已退出的会话写入 err = %v, want ErrSessionExited", err)
	}
}

// 退出消息排在最后一段输出之后：shell 退出时内核里往往还躺着最后几行输出，
// agent 要等 readLoop 读到 EOF 再宣布退出。否则这几行 OUTPUT 会排在
// session.updated{status:"exited"} 后面，前端的「进程结束」提示行就插到了输出前面。
// 消息里的 head_seq 正好等于最后一帧的末尾。
func TestExitedAfterLastOutput(t *testing.T) {
	for i := range 3 { // 竞态类的 bug，多跑几轮
		m := newManager(t, cfg())
		s := create(t, m)
		c := newConn(t, m, "tab")
		s.Subscribe(c, 0, 0, 0)
		if err := c.Send(s, `for i in $(seq 1 3000); do printf 'tail-%05d xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n' $i; done; exit 3`+"\r"); err != nil {
			t.Fatal(err)
		}
		var upd *protocol.SessionUpdated
		at := -1
		waitFor(t, "收到 exited", func() bool {
			for j, e := range c.Timeline() {
				if u, ok := e.(*protocol.SessionUpdated); ok && u.Status != nil && *u.Status == protocol.StatusExited {
					upd, at = u, j
					return true
				}
			}
			return false
		})
		time.Sleep(200 * time.Millisecond) // 给可能迟到的帧一点时间暴露出来
		tl := c.Timeline()
		var last *frameRec
		for j, e := range tl {
			f, ok := e.(frameRec)
			if !ok {
				continue
			}
			if j > at {
				t.Fatalf("第 %d 轮：exited 之后还有帧 %+v —— 输出没读完就宣布退出了", i, f)
			}
			last = &f
		}
		if upd.ExitCode == nil || *upd.ExitCode != 3 {
			t.Fatalf("退出码 = %v", upd.ExitCode)
		}
		if upd.HeadSeq == nil || last == nil || *upd.HeadSeq != last.seq+uint64(last.n) {
			t.Fatalf("第 %d 轮：exited 里的 head_seq = %v，最后一帧末尾 = %d", i, upd.HeadSeq, last.seq+uint64(last.n))
		}
		if *upd.HeadSeq != s.HeadSeq() {
			t.Fatalf("head_seq = %d，会话 head = %d", *upd.HeadSeq, s.HeadSeq())
		}
		if !strings.Contains(c.Screen(), "tail-03000") {
			t.Fatal("最后一行输出没到")
		}
	}
}

// 后台进程还占着 PTY 从端时 EOF 不会来：最多等 500 ms 照样宣布退出。
func TestExitedEvenIfBackgroundHoldsPTY(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0, 0, 0)
	// setsid：shell 退出时它不会被 SIGHUP 带走，从端一直开着
	if err := c.Send(s, "setsid sleep 5 & exit 0\r"); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	waitFor(t, "会话退出", func() bool { return s.Status() == protocol.StatusExited })
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("等了 %v —— 不该等后台进程放掉 PTY", d)
	}
}

// IT-session-5：关闭会话必须杀掉整个进程组，否则子进程会变成孤儿继续跑。
func TestITSession5_CloseKillsProcessGroup(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0, 0, 0)

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
	s.Subscribe(c, 0, 0, 0)

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

// IT-resize-1：resize 消息真的作用到 PTY 上（TIOCSWINSZ），
// 会话里 stty size 看到的就是前端算出来的尺寸（AC-3.11）。
func TestITResize1_AppliesToPTY(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0, 0, 0)

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
	if err := s.Resize(1001, 24); err == nil {
		t.Fatal("cols>1000 应当被拒绝")
	}
}

// startWinchProgram 在会话里起一个前台程序：每收到一次 SIGWINCH 就打一行"重画"，
// 内容是它看到的尺寸。
//
// 【必须是非交互的脚本】：交互式 bash 开着 job control，循环里的每个 sleep 都在
// 自己的进程组里当前台，SIGWINCH 只打到 sleep，装了 trap 的 bash 收不到。
// bash 脚本不开 job control，自己和子进程同在前台进程组；wait 被信号打断后
// trap 立刻执行。
func startWinchProgram(t *testing.T, s *session.Session, c *fakeConn) {
	t.Helper()
	script := t.TempDir() + "/winch.sh"
	body := `trap 'printf "REDRAW-%s\n" "$(stty size)"' WINCH
printf 'WINCH-%s\n' READY
while :; do sleep 0.05 & wait $!; done
`
	if err := os.WriteFile(script, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := c.Send(s, "bash "+script+"\r"); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "WINCH-READY")
}

// IT-resize-2：列数变了 → agent 以自己的重排为准，重发一份快照给每个订阅者；
// 快照【先于】程序因 SIGWINCH 重画的字节（AC-2.22 / ADR-0026 §4）。
//
// 反过来的话，重画字节会落在快照之前，被快照覆盖掉 —— 客户端拿不到那一屏。
func TestITResize2_ColsChangeResendsSnapshotBeforeRedraw(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	a, b := newConn(t, m, "tab-a"), newConn(t, m, "tab-b")
	s.Subscribe(a, 0, 0, 0)
	s.Subscribe(b, 0, 0, 0)
	startWinchProgram(t, s, a)

	t.Run("resize 消息", func(t *testing.T) {
		before := a.Snapshots()
		if err := s.Resize(100, 24); err != nil {
			t.Fatal(err)
		}
		for _, c := range []*fakeConn{a, b} {
			waitFor(t, "每个订阅者都收到新快照", func() bool { return c.Snapshots() == before+1 })
			waitScreen(t, c, "REDRAW-24 100")
			if strings.Contains(string(c.LastSnapshot()), "REDRAW-24 100") {
				t.Fatal("重画字节跑到了快照之前 —— TIOCSWINSZ 必须在快照入队之后")
			}
			if c.gaps != 0 || c.dups != 0 {
				t.Fatalf("seq 记账出错: gaps=%d dups=%d", c.gaps, c.dups)
			}
		}
		if cols := s.Info().Cols; cols != 100 {
			t.Fatalf("会话 cols = %d", cols)
		}
	})

	t.Run("subscribe 带来新的列数", func(t *testing.T) {
		before := a.Snapshots()
		c := newConn(t, m, "tab-c")
		// out_seq 在窗口内也不管用：列数变了就走快照
		if st, _ := s.Subscribe(c, s.HeadSeq(), 90, 24); st != protocol.ResumeSnapshot {
			t.Fatalf("status = %q, want snapshot", st)
		}
		if c.Snapshots() != 1 {
			t.Fatalf("新订阅者收到 %d 份快照，want 1", c.Snapshots())
		}
		waitFor(t, "已有的订阅者也收到新快照", func() bool { return a.Snapshots() == before+1 })
		waitScreen(t, c, "REDRAW-24 90")
		if strings.Contains(string(c.LastSnapshot()), "REDRAW-24 90") {
			t.Fatal("重画字节跑到了快照之前")
		}
	})
}

// 只改行数：模拟器.Resize + TIOCSWINSZ，【不发快照】—— 手机每弹一次软键盘就
// 改一次行数，每次重发上百 KiB、清掉浏览器的回看位置，代价太大（ADR-0026 §4）。
func TestResizeRowsOnlyNoSnapshot(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0, 0, 0)
	startWinchProgram(t, s, c)
	before := c.Snapshots()

	if err := s.Resize(80, 30); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "REDRAW-30 80") // PTY 确实改了
	if c.Snapshots() != before {
		t.Fatal("只改行数却重发了快照")
	}
	// subscribe 只带来新的行数：按 out_seq 走增量，同样不发快照
	c2 := newConn(t, m, "tab-2")
	if st, _ := s.Subscribe(c2, s.HeadSeq(), 80, 20); st != protocol.ResumeOK {
		t.Fatalf("status = %q, want ok", st)
	}
	waitScreen(t, c2, "REDRAW-20 80")
	if c2.Snapshots() != 0 || c.Snapshots() != before {
		t.Fatal("只改行数却发了快照")
	}
	// 尺寸没变：什么都不做
	if err := s.Resize(80, 20); err != nil {
		t.Fatal(err)
	}
	if c.Snapshots() != before {
		t.Fatal("尺寸没变却发了快照")
	}
}

// 空闲 = 每个运行中的会话，PTY 的前台进程组就是 shell 自己；有命令在跑就算忙
// （webterm reload --when-idle、控制 socket 的忙碌数）。
func TestBusyFollowsForegroundProcessGroup(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	idle := create(t, m)
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0, 0, 0)
	waitFor(t, "shell 就绪", func() bool { return s.HeadSeq() > 0 && idle.HeadSeq() > 0 })
	waitFor(t, "停在提示符算闲", func() bool { return m.Busy() == 0 })

	if err := c.Send(s, "sleep 30\r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "sleep 30 在前台算忙", func() bool { return m.Busy() == 1 })

	// Ctrl-C 要补发：前台进程组换成 bash fork 出的子进程时就已经算忙，但它可能还没 exec
	// sleep。这个窗口里的 SIGINT 被子进程里 bash 自己的处理函数接走，exec 之后就没了，
	// sleep 照睡 30 秒（CI 上 -race 加并行时撞到过，本地 6 份并行约 2.5%）。
	// 多出来的 ^C 落在提示符上，无害。
	var lastIntr time.Time
	waitFor(t, "回到提示符算闲", func() bool {
		if time.Since(lastIntr) > 300*time.Millisecond {
			if err := c.Send(s, "\x03"); err != nil {
				t.Fatal(err)
			}
			lastIntr = time.Now()
		}
		return m.Busy() == 0
	})

	// 已退出的会话算闲
	if err := c.Send(s, "exit\r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "退出", func() bool { return s.Status() == protocol.StatusExited })
	if m.Busy() != 0 {
		t.Fatal("已退出的会话不该算忙")
	}
}

// shell 照常启动（ADR-0026 §6）：默认登录交互 shell（-l -i），--no-login-shell
// 时只 -i。webterm 不注入任何东西。
func TestLoginShellByDefault(t *testing.T) {
	t.Setenv("HOME", t.TempDir()) // 别读到跑测试的人自己的 dotfile
	for _, tc := range []struct {
		noLogin bool
		want    string
	}{{false, "LOGIN[on]"}, {true, "LOGIN[off]"}} {
		c := cfg()
		c.ShellArgs = nil
		c.NoLoginShell = tc.noLogin
		m := newManager(t, c)
		s := create(t, m)
		conn := newConn(t, m, "tab")
		s.Subscribe(conn, 0, 0, 0)
		if err := conn.Send(s, `shopt -q login_shell && v=on || v=off; printf 'LOGIN[%s]\n' "$v"`+"\r"); err != nil {
			t.Fatal(err)
		}
		waitScreen(t, conn, tc.want)
	}
}
