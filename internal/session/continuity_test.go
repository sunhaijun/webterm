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
		c.RingBytes = 1 << 20 // 足够大，断线窗口内的输出不会溢出 → 一直走增量
		m := newManager(t, c)
		s := create(t, m)
		conn := newConn(t, m, "tab")
		waitFor(t, "shell 就绪", func() bool { return s.HeadSeq() > 0 })
		waitQuiet(t, s, 200*time.Millisecond)
		// 从当前 head 起订阅（增量路径，没有要补的）：两轮比较的都是同一个
		// 起点之后的原始字节流，与启动时 prompt 画得快慢无关
		if st, _ := conn.SubscribeAt(s, s.HeadSeq()); st != protocol.ResumeOK {
			t.Fatalf("status = %q, want ok", st)
		}

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
			// 重连续传：同一个判定（协议 §5.1），落在窗口内必须走增量
			if st, from := s.Subscribe(conn, at, 0, 0); st != protocol.ResumeOK || from != at {
				t.Fatalf("续传 = %s/%d, want ok/%d", st, from, at)
			}
		}
		waitScreen(t, conn, "EMIT-DONE")
		waitQuiet(t, s, 300*time.Millisecond) // 两轮用同一个截止点

		if conn.Snapshots() != 0 {
			t.Fatalf("走了 %d 次快照 —— 缓冲溢出了，这一轮的比较没有意义", conn.Snapshots())
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

	cs, co := newConn(t, m, "tab"), newConn(t, m, "tab")
	stuck.Subscribe(cs, 0, 0, 0)
	other.Subscribe(co, 0, 0, 0)

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

// agent 不改写输出流（ADR-0026 §2 / 不变式 ④）：out_seq = PTY 输出的累计字节数，
// 一个字节都不剥离。以前被剥掉的 OSC 133 / 7 / 1701 现在原样透传给浏览器，由
// xterm 自己忽略。
func TestOutSeqIsRawPTYBytes(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	c := newConn(t, m, "tab")
	waitFor(t, "shell 就绪", func() bool { return s.HeadSeq() > 0 })
	waitQuiet(t, s, 200*time.Millisecond)
	start := s.HeadSeq()
	c.SubscribeAt(s, start)

	// 让 shell 自己打出 OSC 字节（回显里是字面量反斜杠，不会干扰断言）
	script := `printf 'A\033]133;B\007B\033]7;file://h/srv/demo\007C\033]1701;hello;1\007D\033]0;keep-me\007E\n'` +
		"; printf 'RAW-%s\\n' MARK\r"
	if err := c.Send(s, script); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "RAW-MARK")
	waitQuiet(t, s, 300*time.Millisecond)

	screen := c.Screen()
	const want = "A\x1b]133;B\x07B\x1b]7;file://h/srv/demo\x07C\x1b]1701;hello;1\x07D\x1b]0;keep-me\x07E"
	if !strings.Contains(screen, want) {
		t.Errorf("输出被改写了，期望原样出现 %q", want)
	}
	if got, want := s.HeadSeq()-start, uint64(len(screen)); got != want {
		t.Fatalf("head_seq 推进了 %d，客户端实收 %d 字节 —— out_seq 必须等于原始字节数", got, want)
	}
	for _, e := range c.Events() {
		if u, ok := e.(*protocol.SessionUpdated); ok && u.CWD != nil && *u.CWD == "/srv/demo" {
			t.Fatal("OSC 7 不再是 cwd 的来源 —— cwd 只读 /proc（ADR-0026 §6）")
		}
	}
}
