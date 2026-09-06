package session_test

import (
	"strings"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/session"
)

// 字节级连续性 —— m1 的出口标准，AC-2.1 的无浏览器版本。
//
// 它不测"重连能不能连上"（那太弱），而是测【最终收到的字节流是否与从未
// 断线时完全一致】。任何 seq 记账错误、切片偏移、重复回放、丢帧，都会让
// 两次结果不同。
//
// E2E-2 会在真浏览器 + xterm 序列化的层面再测一遍；这里先用最便宜的手段
// 把风险最高的那段逻辑打穿。
func TestByteLevelContinuity(t *testing.T) {
	run := func(t *testing.T, interruptions int) string {
		c := cfg()
		c.RingBytes = 1 << 20 // 足够大，断线窗口内的输出不会溢出 → 不走 reset
		m := newManager(t, c)
		s := create(t, m)
		conn := newConn(t, "tab")
		s.Subscribe(conn, 0)
		waitFor(t, "shell 就绪", func() bool { return s.HeadSeq() > 0 })

		if err := conn.Send(s, emitScript(400)); err != nil {
			t.Fatal(err)
		}
		for range interruptions {
			time.Sleep(2 * time.Millisecond)
			// 断线：先停止接收，再读断点，最后摘订阅 —— 顺序和真实连接一致
			conn.Detach()
			at := conn.OutSeq()
			s.Unsubscribe(conn)

			time.Sleep(2 * time.Millisecond)
			conn.Attach()
			s.Subscribe(conn, at) // 重连续传
		}
		waitScreen(t, conn, "EMIT-DONE")
		waitQuiet(t, s, 300*time.Millisecond) // 两轮用同一个截止点

		if conn.Resets() != 0 {
			t.Fatalf("走了 %d 次 reset —— 缓冲溢出了，这一轮的比较没有意义", conn.Resets())
		}
		if conn.gaps != 0 || conn.dups != 0 {
			t.Fatalf("seq 记账出错: gaps=%d dups=%d", conn.gaps, conn.dups)
		}
		return conn.Screen()
	}

	baseline := run(t, 0)
	if len(baseline) < 4096 {
		t.Fatalf("基准输出只有 %d 字节，太少了，测不出东西", len(baseline))
	}

	for _, n := range []int{1, 3, 10} {
		t.Run(itoa(n)+"次断开", func(t *testing.T) {
			got := run(t, n)
			if got == baseline {
				return
			}
			// 报告第一处分歧，方便定位是偏移还是丢帧
			i := 0
			for i < len(got) && i < len(baseline) && got[i] == baseline[i] {
				i++
			}
			t.Fatalf("字节级连续性被破坏：第 %d 字节起分歧（基准 %d 字节，实际 %d 字节）\n"+
				"基准 %q\n实际 %q", i, len(baseline), len(got),
				sample(baseline, i), sample(got, i))
		})
	}
}

func sample(s string, at int) string {
	lo := max(at-40, 0)
	hi := min(at+40, len(s))
	return s[lo:hi]
}

// IT-queue-1：会话输入队列满 → ErrInputStalled，且【绝不阻塞】。
//
// 入队阻塞会顺着 ptmx.Write → writeLoop → 队列一路把连接的读循环卡死，
// 而一条 WebSocket 复用所有会话 —— 一个不读 stdin 的前台程序就能把
// ping/pong、resize、其它会话的输入全停掉。
func TestITQueue1_InputStalledNeverBlocks(t *testing.T) {
	m := newManager(t, cfg())
	stuck := create(t, m)
	other := create(t, m)

	cs, co := newConn(t, "tab"), newConn(t, "tab")
	stuck.Subscribe(cs, 0)
	other.Subscribe(co, 0)

	// 让 stuck 会话的前台程序不读 stdin
	if err := cs.Send(stuck, "sleep 60\r"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)

	// 灌到队列满。每次调用都必须【立刻】返回。
	chunk := make([]byte, 8<<10)
	for i := range chunk {
		chunk[i] = 'x'
	}
	var stalled bool
	deadline := time.Now().Add(20 * time.Second)
	for range 200 {
		start := time.Now()
		err := cs.Send(stuck, string(chunk))
		if d := time.Since(start); d > 2*time.Second {
			t.Fatalf("Write 阻塞了 %v —— 入队必须是非阻塞的", d)
		}
		if err == session.ErrInputStalled {
			stalled = true
			break
		}
		if err != nil {
			t.Fatalf("Write 返回了意外的错误: %v", err)
		}
		if time.Now().After(deadline) {
			break
		}
	}
	if !stalled {
		t.Fatal("灌了 1.6 MiB 都没触发 ErrInputStalled —— 队列上限没生效")
	}

	// 关键断言：另一个会话完全不受影响
	if err := co.Send(other, "echo STILL-ALIVE\r"); err != nil {
		t.Fatalf("另一个会话的输入也失败了: %v", err)
	}
	waitScreen(t, co, "STILL-ALIVE")
}

// out_seq 必须在剥离 OSC【之后】计数（ADR-0006 / AC-2.5 / UT-osc-9）。
//
// 先计数再剥离的话，续传时按 out_seq 切片就会错位，屏幕会花。这条在没有
// shell 集成的会话里测不出来（bash 根本不发那些序列），所以这里让 shell
// 自己把序列打出来，走完整的 readLoop → Feed → Append 路径。
func TestOutSeqCountsAfterStripping(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	c := newConn(t, "tab")
	s.Subscribe(c, 0)
	waitFor(t, "shell 就绪", func() bool { return s.HeadSeq() > 0 })

	// 让 shell 打出真正的 OSC 字节（回显里是字面量反斜杠，不会干扰断言）
	script := `printf 'A\033]133;B\007B\033]7;file://h/srv/demo\007C\033]1701;hello;1\007D\033]0;keep-me\007E\n'` +
		"; printf 'STRIP-%s\\n' MARK\r"
	if err := c.Send(s, script); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "STRIP-MARK")

	screen := c.Screen()

	t.Run("webterm 的 OSC 一个都不许漏出去", func(t *testing.T) {
		for _, bad := range []string{"\x1b]133", "\x1b]7;file", "\x1b]1701"} {
			if strings.Contains(screen, bad) {
				t.Errorf("客户端收到了本该被剥离的序列 %q", bad)
			}
		}
	})

	t.Run("无关的 OSC 必须原样透传", func(t *testing.T) {
		// OSC 0（窗口标题）不是我们的，剥了会破坏终端功能
		if !strings.Contains(screen, "\x1b]0;keep-me\x07") {
			t.Error("OSC 0 被吞掉了")
		}
	})

	t.Run("剥离后的字节严丝合缝地连在一起", func(t *testing.T) {
		// 三个 webterm 序列被抽走，中间那个 OSC 0 原样留下 —— 合起来必须
		// 正好是这一串，多一个字节少一个字节都说明剥离有偏差
		const want = "ABCD\x1b]0;keep-me\x07E"
		if !strings.Contains(screen, want) {
			t.Errorf("剥离留下了空隙或残渣，期望片段 %q", want)
		}
	})

	t.Run("head_seq 严格等于客户端收到的字节数", func(t *testing.T) {
		// 客户端从 seq 0 订阅、全程无空洞，所以两者必须完全相等。
		// 若计数发生在剥离之前，head_seq 会比实际发出的字节多出被剥离的那些。
		if got, want := s.HeadSeq(), uint64(len(screen)); got != want {
			t.Fatalf("head_seq = %d，客户端实收 %d 字节，差 %d —— "+
				"out_seq 必须在剥离之后计数", got, want, int64(got)-int64(want))
		}
	})

	t.Run("结构化事件从同一条流里抽了出来", func(t *testing.T) {
		var gotPrompt, gotCWD, gotIntegration bool
		for _, e := range c.Events() {
			switch v := e.(type) {
			case *protocol.Prompt:
				gotPrompt = true
			case *protocol.CWD:
				if v.Path == "/srv/demo" {
					gotCWD = true
				}
			case *protocol.SessionUpdated:
				if v.Integration != nil && *v.Integration == protocol.IntegrationActive {
					gotIntegration = true
				}
			}
		}
		if !gotPrompt {
			t.Error("没收到 prompt 事件")
		}
		if !gotCWD {
			t.Error("没收到 cwd 事件（OSC 7 的 percent-decode / host 忽略可能有问题）")
		}
		if !gotIntegration {
			t.Error("OSC 1701;hello 没把 integration 置成 active")
		}
	})
}
