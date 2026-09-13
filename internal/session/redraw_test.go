package session_test

import (
	"strings"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/session"
)

// enterAltScreen 让会话进入备用屏，并把环形缓冲顶掉一轮。
//
// 之后任何从 0 开始的订阅都落在 reset 分支上，而且会话当前在备用屏 ——
// 正是 ADR-0019 要分流的那个状态。
func enterAltScreen(t *testing.T, s *session.Session, c *fakeConn, ring int) {
	t.Helper()
	if err := c.Send(s, "printf '\\033[?1049h'; printf 'ALT-%s\\n' READY\r"); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "ALT-READY")
	// 把窗口顶过一轮，让 base_seq 跑到 ALT-READY 后面
	if err := c.Send(s, emitScript(ring/40+200)); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "EMIT-DONE")
	waitFor(t, "缓冲发生裁剪", func() bool { return s.Snapshot().BaseSeq > 0 })
}

// IT-redraw-1：备用屏会话的 reset 走 redraw，**不回放窗口**（AC-2.16）。
//
// 窗口里是一串离开 ESC[?1049h 就没有意义的差分补丁。回放它必然把补丁打在错误的
// 底图上，而且不会自愈 —— 这正是"切回来一屏很多份 logo"的成因。
func TestITRedraw1_AltScreenUsesRedraw(t *testing.T) {
	c := cfg()
	c.RingBytes = 8192
	m := newManager(t, c)
	s := create(t, m)

	conn := newConn(t, m, "tab")
	s.Subscribe(conn, 0)
	// 收到 SIGWINCH 就整屏重画 —— 对齐真实全屏程序的行为
	if err := conn.Send(s, "trap 'printf \"\\033[2JREPAINTED\"' WINCH\r"); err != nil {
		t.Fatal(err)
	}
	enterAltScreen(t, s, conn, c.RingBytes)

	// 另一个客户端从 0 订阅（= 刷新页面 / 切回来时进度已被裁掉）
	fresh := newConn(t, m, "tab-2")
	s.SubscribeNotifyReset(fresh, 0, 0, 0)

	waitFor(t, "收到 redraw", func() bool { return fresh.Redraws() == 1 })
	r := fresh.LastRedraw()
	if !strings.Contains(r.Modes, "\x1b[?1049h") {
		t.Fatalf("modes 里没有备用屏开关，客户端会把差分帧画进主屏：%q", r.Modes)
	}
	if r.Seq != s.Snapshot().HeadSeq && r.Seq < s.Snapshot().BaseSeq {
		t.Fatalf("redraw.seq = %d，不在 [base, head] 里", r.Seq)
	}
	// 【没有】按字节回放：一份属性修正前缀都不该发
	if fresh.Resets() != 0 {
		t.Fatal("备用屏会话仍然回放了窗口字节 —— 分流没生效")
	}
	// 没有"历史输出已截断"那条通知：备用屏本来就没有历史
	for _, e := range fresh.Events() {
		if _, ok := e.(*protocol.Reset); ok {
			t.Fatal("备用屏会话发了 reset 通知，那条提示在这里是误导")
		}
	}

	// 程序被逼着重画了，内容跟上来
	waitScreen(t, fresh, "REPAINTED")
}

// IT-redraw-2：重画路径传的字节远小于一个窗口（AC-2.17），且 modes 不计入 seq。
func TestITRedraw2_RedrawIsCheap(t *testing.T) {
	c := cfg()
	c.RingBytes = 64 << 10
	m := newManager(t, c)
	s := create(t, m)

	conn := newConn(t, m, "tab")
	s.Subscribe(conn, 0)
	if err := conn.Send(s, "trap 'printf \"\\033[2JREPAINTED\"' WINCH\r"); err != nil {
		t.Fatal(err)
	}
	enterAltScreen(t, s, conn, c.RingBytes)

	fresh := newConn(t, m, "tab-2")
	s.SubscribeNotifyReset(fresh, 0, 0, 0)
	waitFor(t, "收到 redraw", func() bool { return fresh.Redraws() == 1 })
	seq := fresh.LastRedraw().Seq
	waitScreen(t, fresh, "REPAINTED")

	// 客户端的记账从 redraw.seq 起步：modes 的字节不算进去（协议 §3）
	if got := fresh.OutSeq(); got < seq {
		t.Fatalf("out_seq = %d，落在 redraw.seq %d 之前 —— modes 被计进 seq 了", got, seq)
	}
	if n := fresh.OutSeq() - seq; n > 8<<10 {
		t.Fatalf("重画之后收了 %d 字节，超过 8 KiB —— 这条路本该只传一屏（AC-2.17）", n)
	}
	if len(fresh.LastRedraw().Modes) > 256 {
		t.Fatalf("modes 太长了（%d 字节），它只该有十来个开关", len(fresh.LastRedraw().Modes))
	}
}

// IT-redraw-3：程序不响应 SIGWINCH 时退回字节回放（AC-2.18）。
//
// 赌"程序会重画"是有风险的。不兜底的话，用户对着的就是一块清过屏的空白。
func TestITRedraw3_FallsBackWhenProgramWontRepaint(t *testing.T) {
	c := cfg()
	c.RingBytes = 8192
	m := newManager(t, c)
	s := create(t, m)

	conn := newConn(t, m, "tab")
	s.Subscribe(conn, 0)
	enterAltScreen(t, s, conn, c.RingBytes)
	// 前台换成一个【真的不理 SIGWINCH】的程序。
	// 不能指望 bash 自己：它停在提示符上时，readline 收到 SIGWINCH 会重画提示行，
	// 那也是输出，兜底就不会触发了。cat 对 SIGWINCH 取默认处置（忽略），不吐字节。
	if err := conn.Send(s, "cat > /dev/null\r"); err != nil {
		t.Fatal(err)
	}
	waitQuiet(t, s, 300*time.Millisecond)

	fresh := newConn(t, m, "tab-2")
	s.SubscribeNotifyReset(fresh, 0, 0, 0)
	waitFor(t, "收到 redraw", func() bool { return fresh.Redraws() == 1 })

	// 宽限期过后必须退回窗口回放，屏幕上要有东西
	waitFor(t, "兜底的回放到达", func() bool { return fresh.Resets() == 1 })
	if !strings.Contains(fresh.Screen(), "EMIT") {
		t.Fatalf("兜底之后屏幕上没有内容：%q", tail(fresh.Screen(), 80))
	}
}

// 主屏会话不受影响：照常走字节回放那条路（本 ADR 的回归红线）。
func TestRedrawDoesNotTouchMainScreen(t *testing.T) {
	c := cfg()
	c.RingBytes = 4096
	m := newManager(t, c)
	s := create(t, m)

	conn := newConn(t, m, "tab")
	s.Subscribe(conn, 0)
	if err := conn.Send(s, emitScript(300)); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, conn, "EMIT-DONE")
	waitFor(t, "缓冲发生裁剪", func() bool { return s.Snapshot().BaseSeq > 0 })

	fresh := newConn(t, m, "tab-2")
	s.SubscribeNotifyReset(fresh, 0, 0, 0)
	time.Sleep(100 * time.Millisecond)
	if fresh.Redraws() != 0 {
		t.Fatal("主屏会话走了 redraw —— 分流判反了")
	}
	if fresh.Resets() != 1 {
		t.Fatalf("主屏会话的 reset 回放没发：resets = %d", fresh.Resets())
	}
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}
