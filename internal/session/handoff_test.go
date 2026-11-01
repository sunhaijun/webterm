package session_test

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/handoff"
	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/session"
	"github.com/sunhaijun/webterm/internal/vterm"
)

// IT-handoff-1：跨交接的字节级连续性（ADR-0016，AC-2.14）。
//
// 与 TestByteLevelContinuity 同一把尺子：一段输出中途做一次 Freeze → Export →
// 新 Manager Restore，同一个"客户端"接着订阅，最终屏幕与从未交接时逐字节一致。
// 外加 ADR-0026 §8 的一条：交接前后同一会话生成的快照逐字节相等。
// 同进程内做而不真的 exec：fd 与 pid 在同一个进程里同样有效，测的正是状态
// 搬运有没有漏、有没有重；真 exec 由 E2E-26 覆盖。
//
// 旧 Manager【不能 Shutdown】—— 那会杀掉 shell；交接之后它就是一具空壳。
func TestHandoffByteLevelContinuity(t *testing.T) {
	run := func(t *testing.T, handoffs int) string {
		c := cfg()
		c.RingBytes = 1 << 20
		m := session.NewManager(c)
		s := create(t, m)
		conn := newConn(t, m, "tab")
		waitFor(t, "shell 就绪", func() bool { return s.HeadSeq() > 0 })
		waitQuiet(t, s, 200*time.Millisecond)
		conn.SubscribeAt(s, s.HeadSeq()) // 增量路径，起点与基准一致
		if err := conn.Send(s, emitScript(400)); err != nil {
			t.Fatal(err)
		}
		for range handoffs {
			time.Sleep(3 * time.Millisecond)
			// 断线 + 交接：连接层此刻会关掉所有 WebSocket
			conn.Detach()
			at := conn.OutSeq()
			s.Unsubscribe(conn)
			if err := m.Freeze(2 * time.Second); err != nil {
				t.Fatal(err)
			}
			beforeSeq, before := s.TermSnapshot()
			snap, err := m.Export("test")
			if err != nil {
				t.Fatal(err)
			}
			m.RemoveObserver(conn)

			m2 := session.NewManager(c)
			if err := m2.Restore(snap); err != nil {
				t.Fatal(err)
			}
			s2, ok := m2.Get(s.SID())
			if !ok {
				t.Fatal("交接后找不到会话")
			}
			if m2.InstanceID() != m.InstanceID() || m2.Generation() != m.Generation()+1 {
				t.Fatalf("instance_id / generation 不对: %s→%s gen %d→%d", m.InstanceID(), m2.InstanceID(), m.Generation(), m2.Generation())
			}
			// 【交接前后快照逐字节相等】。新进程的循环已经在跑、可能吃进了新输出，
			// 所以拿交接数据本身导回来比：新会话的模拟器就是它导回来的那一个
			if afterSeq, after := importedSnapshot(t, snap, s.SID()); afterSeq != beforeSeq || !bytes.Equal(after, before) {
				t.Fatalf("交接前后快照不同：seq %d→%d，%d→%d 字节", beforeSeq, afterSeq, len(before), len(after))
			}
			m, s = m2, s2
			m.AddObserver(conn)
			conn.Attach()
			if st, _ := s.Subscribe(conn, at, 0, 0); st != protocol.ResumeOK {
				t.Fatalf("交接之后续传 = %s, want ok", st)
			}
		}
		t.Cleanup(m.Shutdown)
		waitScreen(t, conn, "EMIT-DONE")
		waitQuiet(t, s, 300*time.Millisecond)
		if conn.Snapshots() != 0 || conn.gaps != 0 || conn.dups != 0 {
			t.Fatalf("seq 记账出错: snapshots=%d gaps=%d dups=%d", conn.Snapshots(), conn.gaps, conn.dups)
		}
		// shell 还活着：交接之后仍能执行命令
		if handoffs > 0 {
			if err := conn.Send(s, "echo ALIVE-$((40+2))\r"); err != nil {
				t.Fatal(err)
			}
			waitScreen(t, conn, "ALIVE-42")
			// 去掉这段尾巴再比较 —— 基准没有它
			screen := conn.Screen()
			return screen[:strings.Index(screen, "EMIT-DONE")+len("EMIT-DONE")]
		}
		screen := conn.Screen()
		return screen[:strings.Index(screen, "EMIT-DONE")+len("EMIT-DONE")]
	}

	baseline := run(t, 0)
	if len(baseline) < 4096 {
		t.Fatalf("基准输出只有 %d 字节", len(baseline))
	}
	for _, n := range []int{1, 3} {
		t.Run(itoa(n)+"次交接", func(t *testing.T) {
			got := run(t, n)
			if got == baseline {
				return
			}
			i := 0
			for i < len(got) && i < len(baseline) && got[i] == baseline[i] {
				i++
			}
			t.Fatalf("跨交接的字节级连续性被破坏：第 %d 字节起分歧\n基准 %q\n实际 %q", i, sample(baseline, i), sample(got, i))
		})
	}
}

// importedSnapshot 用交接数据里的模拟器状态重建一个模拟器，返回它的快照与对应 seq。
func importedSnapshot(t *testing.T, snap *handoff.Snapshot, sid uint16) (uint64, []byte) {
	t.Helper()
	for _, hs := range snap.Sessions {
		if hs.SID != sid {
			continue
		}
		term, err := vterm.Import(hs.VTerm)
		if err != nil {
			t.Fatalf("交接数据里的模拟器状态导不回来: %v", err)
		}
		return hs.RingBase + uint64(len(hs.RingData)), term.Snapshot()
	}
	t.Fatalf("交接数据里没有会话 %d", sid)
	return 0, nil
}

// 冻结期间到达的输入不丢不重：它躺在队列里随快照走，新进程写进 PTY 并 ack。
func TestHandoffCarriesPendingInput(t *testing.T) {
	m := session.NewManager(cfg())
	s := create(t, m)
	conn := newConn(t, m, "tab")
	s.Subscribe(conn, 0, 0, 0)
	waitFor(t, "shell 就绪", func() bool { return s.HeadSeq() > 0 })
	waitQuiet(t, s, 200*time.Millisecond)

	if err := m.Freeze(2 * time.Second); err != nil {
		t.Fatal(err)
	}
	// 冻结中提交输入：只能入队，写不进 PTY
	if err := conn.Send(s, "echo PEND-$((20+3))\r"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if s.InAck("tab") != 0 {
		t.Fatalf("冻结期间不该写进 PTY，inAck=%d", s.InAck("tab"))
	}
	snap, err := m.Export("test")
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Sessions) != 1 || len(snap.Sessions[0].Pending) != 1 {
		t.Fatalf("待写输入没进快照: %+v", snap.Sessions)
	}
	at := conn.OutSeq()
	conn.Detach()
	s.Unsubscribe(conn)
	m.RemoveObserver(conn)

	m2 := session.NewManager(cfg())
	t.Cleanup(m2.Shutdown)
	if err := m2.Restore(snap); err != nil {
		t.Fatal(err)
	}
	s2, _ := m2.Get(s.SID())
	m2.AddObserver(conn)
	conn.Attach()
	s2.Subscribe(conn, at, 0, 0)
	waitScreen(t, conn, "PEND-23")
	waitFor(t, "ack 追上", func() bool { return s2.InAck("tab") == uint64(len("echo PEND-$((20+3))\r")) })
	if conn.gaps != 0 || conn.dups != 0 {
		t.Fatalf("seq 记账出错: gaps=%d dups=%d", conn.gaps, conn.dups)
	}
	// 回显里是未展开的 PEND-$((20+3))，展开后的 PEND-23 只能来自命令结果 —— 恰好一次。
	// 多了就是同一段输入被写进 PTY 两遍
	if n := strings.Count(conn.Screen(), "PEND-23"); n != 1 {
		t.Fatalf("PEND-23 出现 %d 次，输入被重复写入了", n)
	}
}

// 预检失败路径：Freeze 之后 Thaw，会话照常工作、输出不丢。
func TestFreezeThawResumes(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	conn := newConn(t, m, "tab")
	s.Subscribe(conn, 0, 0, 0)
	waitFor(t, "shell 就绪", func() bool { return s.HeadSeq() > 0 })

	if err := conn.Send(s, emitScript(200)); err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond)
	if err := m.Freeze(2 * time.Second); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Create(session.Spec{CWD: t.TempDir(), Cols: 80, Rows: 24}); err != session.ErrFrozen {
		t.Fatalf("冻结期间 Create 应当返回 ErrFrozen，实际 %v", err)
	}
	head := s.HeadSeq()
	time.Sleep(150 * time.Millisecond)
	if s.HeadSeq() != head {
		t.Fatal("冻结期间 ring 不该增长")
	}
	m.Thaw()
	waitScreen(t, conn, "EMIT-DONE")
	if conn.gaps != 0 || conn.dups != 0 || conn.Snapshots() != 1 {
		t.Fatalf("解冻后记账出错: gaps=%d dups=%d snapshots=%d", conn.gaps, conn.dups, conn.Snapshots())
	}
	if !strings.Contains(conn.Screen(), "line 200") {
		t.Fatal("解冻后输出不完整")
	}
}

// 已退出的会话也交接：ring 与模拟器保留供回看（AC-4.5），没有 fd 与进程。
func TestHandoffKeepsExitedSession(t *testing.T) {
	m := session.NewManager(cfg())
	s := create(t, m)
	conn := newConn(t, m, "tab")
	s.Subscribe(conn, 0, 0, 0)
	waitFor(t, "shell 就绪", func() bool { return s.HeadSeq() > 0 })
	if err := conn.Send(s, "echo BYE-$((1+1)); exit 7\r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "会话退出", func() bool { return s.Status() == protocol.StatusExited })
	waitScreen(t, conn, "BYE-2")

	if err := m.Freeze(time.Second); err != nil {
		t.Fatal(err)
	}
	snap, err := m.Export("test")
	if err != nil {
		t.Fatal(err)
	}
	hs := snap.Sessions[0]
	if hs.Status != protocol.StatusExited || hs.PtmxFD != -1 || hs.ShellPID != 0 || hs.ExitCode == nil || *hs.ExitCode != 7 {
		t.Fatalf("已退出会话的快照不对: %+v", hs)
	}
	m2 := session.NewManager(cfg())
	t.Cleanup(m2.Shutdown)
	if err := m2.Restore(snap); err != nil {
		t.Fatal(err)
	}
	s2, _ := m2.Get(s.SID())
	info := s2.Info()
	if info.Status != protocol.StatusExited || info.HeadSeq != s.HeadSeq() {
		t.Fatalf("恢复后状态不对: %+v", info)
	}
	c2 := newConn(t, m2, "tab2")
	s2.Subscribe(c2, 0, 0, 0)
	if !strings.Contains(render(c2, 80, 24), "BYE-2") {
		t.Fatal("恢复后的快照里回看不到退出前的输出")
	}
	if _, err := m2.Close(s2.SID()); err != nil {
		t.Fatal(err)
	}
}

// Validate 挡住不完整的快照，Restore 不会带着半套状态起来。
func TestRestoreRejectsBadSnapshot(t *testing.T) {
	m := newManager(t, cfg())
	if err := m.Restore(&handoff.Snapshot{Schema: handoff.Schema + 1, InstanceID: "x"}); err == nil {
		t.Fatal("schema 太新必须拒绝")
	}
}

// IT-handoff-2：模拟器状态跟着交接走（ADR-0026 §8）。
//
// 【它推导不出来】：ESC[?1049h 只在程序开头出现一次，环形缓冲早把它裁掉了。
// 交接丢了这份状态，升级之后切回 vim / codex 的会话就画不出来。
func TestHandoffKeepsTerminalState(t *testing.T) {
	c := cfg()
	c.RingBytes = 8192
	m := session.NewManager(c)
	s := create(t, m)
	conn := newConn(t, m, "tab")
	s.Subscribe(conn, 0, 0, 0)
	waitFor(t, "shell 就绪", func() bool { return s.HeadSeq() > 0 })
	enterAltScreen(t, s, conn, c.RingBytes)

	conn.Detach()
	s.Unsubscribe(conn)
	if err := m.Freeze(2 * time.Second); err != nil {
		t.Fatal(err)
	}
	_, before := s.TermSnapshot()
	snap, err := m.Export("test")
	if err != nil {
		t.Fatal(err)
	}
	m.RemoveObserver(conn)

	m2 := session.NewManager(c)
	if err := m2.Restore(snap); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m2.Shutdown)
	s2, ok := m2.Get(s.SID())
	if !ok {
		t.Fatal("交接后找不到会话")
	}

	// 新进程里"切回且进度已被裁掉"：快照与交接前逐字节相等，仍在备用屏
	fresh := newConn(t, m2, "tab-2")
	if st, _ := s2.Subscribe(fresh, 1, 0, 0); st != protocol.ResumeSnapshot {
		t.Fatalf("status = %q, want snapshot", st)
	}
	if !bytes.Equal(fresh.LastSnapshot(), before) {
		t.Fatal("交接之后的快照与交接前不同 —— 模拟器状态没跟着走")
	}
	if !bytes.Contains(before, []byte("\x1b[?1049h")) {
		t.Fatal("快照里没有备用屏开关")
	}
}

// IT-handoff-1（ADR-0043 §4）：前台程序设的标题跨交接保留。交接之后名字立刻就是
// 标题，不先闪回目录名、等程序下次写标题才回来。
func TestHandoffKeepsTitleName(t *testing.T) {
	c := cfg()
	m := session.NewManager(c)
	s := create(t, m)
	conn := newConn(t, m, "tab")
	s.Subscribe(conn, 0, 0, 0)
	waitFor(t, "shell 就绪", func() bool { return s.HeadSeq() > 0 })
	if err := conn.Send(s, `bash -c 'printf "\033]0;HANDOFF TITLE\007"; exec sleep 30'`+"\r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "名字是标题", func() bool { return s.Info().Name == "HANDOFF TITLE" })

	conn.Detach()
	s.Unsubscribe(conn)
	if err := m.Freeze(2 * time.Second); err != nil {
		t.Fatal(err)
	}
	snap, err := m.Export("test")
	if err != nil {
		t.Fatal(err)
	}
	m.RemoveObserver(conn)

	m2 := session.NewManager(c)
	if err := m2.Restore(snap); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(m2.Shutdown)
	s2, ok := m2.Get(s.SID())
	if !ok {
		t.Fatal("交接后找不到会话")
	}
	if got := s2.Info().Name; got != "HANDOFF TITLE" {
		t.Fatalf("交接之后名字 = %q, want 标题", got)
	}
	// 之后的轮询也不把它改掉（归属的进程组还在前台）
	for range 5 {
		time.Sleep(100 * time.Millisecond)
		if got := s2.Info().Name; got != "HANDOFF TITLE" {
			t.Fatalf("交接之后轮询把名字改成了 %q", got)
		}
	}
}

// enterAltScreen 让会话进入备用屏，并把环形缓冲顶掉一轮：之后 ESC[?1049h 只在
// 模拟器里，环形缓冲里已经没有了。
func enterAltScreen(t *testing.T, s *session.Session, c *fakeConn, ring int) {
	t.Helper()
	if err := c.Send(s, "printf '\\033[?1049h'; printf 'ALT-%s\\n' READY\r"); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "ALT-READY")
	if err := c.Send(s, emitScript(ring/40+200)); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "EMIT-DONE")
	waitFor(t, "缓冲发生裁剪", func() bool { return s.Info().BaseSeq > 0 })
	waitQuiet(t, s, 200*time.Millisecond)
}

// 从旧版本升级上来（schema 1，交接数据里没有模拟器状态）：新进程新建模拟器、
// 把交接来的环形缓冲喂进去尽力还原，【不中止升级】（ADR-0026 §8 末段）。
func TestHandoffFromSchema1RebuildsTerminalFromRing(t *testing.T) {
	m := session.NewManager(cfg())
	s := create(t, m)
	conn := newConn(t, m, "tab")
	s.Subscribe(conn, 0, 0, 0)
	if err := conn.Send(s, "printf 'OLD-%s\\n' SCREEN\r"); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, conn, "OLD-SCREEN")
	waitQuiet(t, s, 200*time.Millisecond)

	if err := m.Freeze(2 * time.Second); err != nil {
		t.Fatal(err)
	}
	snap, err := m.Export("v0.1.0")
	if err != nil {
		t.Fatal(err)
	}
	m.RemoveObserver(conn)
	// 伪装成旧版本交过来的：schema 1，没有模拟器状态
	snap.Schema = 1
	for i := range snap.Sessions {
		snap.Sessions[i].VTerm = nil
	}
	m2 := session.NewManager(cfg())
	t.Cleanup(m2.Shutdown)
	if err := m2.Restore(snap); err != nil {
		t.Fatalf("旧格式的交接必须接得住: %v", err)
	}
	s2, _ := m2.Get(s.SID())
	fresh := newConn(t, m2, "tab-2")
	s2.Subscribe(fresh, 0, 0, 0)
	if !strings.Contains(render(fresh, 80, 24), "OLD-SCREEN") {
		t.Fatal("没能从环形缓冲还原出画面")
	}
	// 会话照常可用
	if err := fresh.Send(s2, "echo NEW-$((6*7))\r"); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, fresh, "NEW-42")
}
