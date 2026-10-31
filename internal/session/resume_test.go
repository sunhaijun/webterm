package session_test

import (
	"strings"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/session"
)

// emitScript 产生确定性的输出：固定内容、固定顺序、含 ANSI 颜色、CJK 宽字符、
// 长行。不含时间戳/随机数/主机名 —— 否则字节级比较没有意义。
func emitScript(lines int) string {
	return "for i in $(seq 1 " + itoa(lines) + "); do " +
		`printf '\033[3%dmline %03d\033[0m 中文宽字符 %s\n' $((i%8)) $i "$(printf 'x%.0s' $(seq 1 40))"; ` +
		// 完成标记必须【只出现在输出里】，不能出现在被回显的命令行里 ——
		// 否则等待条件会在命令刚敲完时就满足，测的是回显而不是输出。
		"done; printf 'EMIT-%s\\n' DONE\r"
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

// IT-resume-1：断线期间会话不暂停 —— PTY 继续运行，环形缓冲继续累积。
func TestITResume1_SessionKeepsRunningWhileDisconnected(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0, 0, 0)

	waitFor(t, "shell 就绪", func() bool { return s.HeadSeq() > 0 })

	// "断线"：连接层摘掉订阅
	s.Unsubscribe(c)
	before := s.HeadSeq()

	if err := c.Send(s, "echo while-offline\r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "断线期间仍有输出累积", func() bool { return s.HeadSeq() > before })

	if s.Status() != protocol.StatusRunning {
		t.Fatal("断线导致会话暂停了")
	}
	// 重连补齐：断线期间的输出必须一个字节不少地回来
	c2 := newConn(t, m, "tab")
	if st, _ := s.Subscribe(c2, before, 0, 0); st != protocol.ResumeOK {
		t.Fatalf("status = %q, want ok", st)
	}
	waitScreen(t, c2, "while-offline")
}

// IT-resume-2：增量回放 —— agent 只发 out_seq 之后的字节，不重发已收到的。
func TestITResume2_IncrementalReplay(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0, 0, 0)

	// 标记必须【只出现在输出里】—— 直接写 "echo ONE-MARK" 的话，被回显的
	// 命令行本身就含这个串，断点会落在命令刚敲完、输出还没出来的位置。
	if err := c.Send(s, `printf 'ONE-%s\n' MARK`+"\r"); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "ONE-MARK")
	waitQuiet(t, s, 200*time.Millisecond) // 断点取在第一段输出彻底结束之后

	c.Detach() // 断线之后到达的字节应当石沉大海，否则断点会被竞态污染
	at := c.OutSeq()
	s.Unsubscribe(c)

	if err := c.Send(s, `printf 'TWO-%s\n' MARK`+"\r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "第二段输出产生", func() bool { return s.HeadSeq() > at })

	// 从断点续订：只应收到断点之后的内容
	c2 := newConn(t, m, "tab")
	st, from := s.Subscribe(c2, at, 0, 0)
	if st != protocol.ResumeOK || from != at {
		t.Fatalf("续传 = %s/%d, want ok/%d", st, from, at)
	}
	waitScreen(t, c2, "TWO-MARK")

	if strings.Contains(c2.Screen(), "ONE-MARK") {
		t.Fatal("重发了客户端已经收到的字节 —— 续传应当是增量的")
	}
	if c2.Snapshots() != 0 {
		t.Fatal("缓冲没溢出却走了快照路径")
	}
}

// IT-resume-3 ★：输入跨重连不丢、不重、不触发 input_gap。
//
// in_ack 按 (client_id, sid) 记账并跨重连存活。若按连接记账，重连后 in_ack
// 归零而客户端的 pending 仍从旧 seq 起，agent 会判 seq > in_ack → input_gap
// → 关连接 → 无限重连，"断线期间的输入不丢"整条就废了。
func TestITResume3_InputSurvivesReconnect(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	c := newConn(t, m, "tab-1")
	s.Subscribe(c, 0, 0, 0)

	if err := c.Send(s, "echo A1\r"); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "A1")
	waitFor(t, "输入被 ack", func() bool { return s.InAck("tab-1") == c.inSeqNext })

	// "断线"
	s.Unsubscribe(c)
	s.DetachClient("tab-1")

	// 重连：同一个 client_id 拿回自己的 in_ack（Resume 顺带订阅上去）
	c2 := newConn(t, m, "tab-1")
	resumed := m.Resume(c2, m.InstanceID(), []protocol.ResumeReq{
		{SID: s.SID(), OutSeq: c.OutSeq()},
	})
	if len(resumed) != 1 {
		t.Fatalf("resumed = %+v", resumed)
	}
	r := resumed[0]
	if r.Status != protocol.ResumeOK {
		t.Fatalf("status = %q, want ok", r.Status)
	}
	if r.InAck == 0 {
		t.Fatal("重连后 in_ack 归零了 —— 客户端会从旧 seq 重发，必然 input_gap")
	}
	if r.InAck != c.inSeqNext {
		t.Fatalf("in_ack = %d, want %d（断开前已全部写入）", r.InAck, c.inSeqNext)
	}

	// 客户端按 in_ack 裁剪重发队列，然后继续发新输入
	c2.TrimTo(r.InAck)
	if err := c2.Send(s, "echo A2\r"); err != nil {
		t.Fatalf("重连后第一次写入就失败了: %v", err)
	}
	waitScreen(t, c2, "A2")

	// 全程不能有空洞/重复
	if c2.gaps != 0 || c2.dups != 0 {
		t.Fatalf("seq 记账出错: gaps=%d dups=%d", c2.gaps, c2.dups)
	}
}

// 重发已处理过的输入必须去重：agent 丢弃前 in_ack-seq 字节，只写剩下的。
func TestInputResendIsDeduplicated(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	c := newConn(t, m, "tab")
	s.Subscribe(c, 0, 0, 0)

	first := "echo DEDUP-"
	if err := c.Send(s, first); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "首段写入 PTY", func() bool { return s.InAck("tab") == uint64(len(first)) })

	// 重连后客户端重发了整段（含已处理的部分）+ 新内容
	whole := first + "OK\r"
	if err := c.Resend(s, 0, whole); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "DEDUP-OK")

	if strings.Count(c.Screen(), "DEDUP-DEDUP") > 0 {
		t.Fatal("重发的部分被重复写进了 PTY")
	}
	waitFor(t, "in_ack 推进到整段长度", func() bool { return s.InAck("tab") == uint64(len(whole)) })
}

// 输入出现空洞必须报 ErrInputGap，让连接层关连接。
func TestInputGapDetected(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	if err := s.Write("tab", 0, []byte("abc")); err != nil {
		t.Fatal(err)
	}
	if err := s.Write("tab", 100, []byte("def")); err != session.ErrInputGap {
		t.Fatalf("err = %v, want ErrInputGap", err)
	}
}

// 两个标签页各自独立记账 —— 混在一起没有意义。
func TestInputAccountingIsPerClient(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	if err := s.Write("tab-a", 0, []byte("echo ")); err != nil {
		t.Fatal(err)
	}
	// tab-b 的第一帧同样从 0 开始，不该被 tab-a 的进度影响
	if err := s.Write("tab-b", 0, []byte("echo ")); err != nil {
		t.Fatalf("tab-b 从 seq 0 开始却被拒: %v", err)
	}
	waitFor(t, "两个 client 各自 ack", func() bool {
		return s.InAck("tab-a") == 5 && s.InAck("tab-b") == 5
	})
}

// IT-resume-4：instance_id 不符 → 所有 resume 判 gone。
//
// agent 重启后 sid 从头分配。没有实例标识的话，resume{sid:1, out_seq:很大}
// 会被接到一个毫不相干的新会话上 —— 屏幕上留着旧会话的内容，之后接的却是
// 另一个会话的输出。
func TestITResume4_InstanceMismatchIsGone(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	waitFor(t, "有输出", func() bool { return s.HeadSeq() > 0 })

	t.Run("实例相符、进度在窗口内：增量", func(t *testing.T) {
		head := s.HeadSeq()
		got := m.Resume(newConn(t, m, "tab"), m.InstanceID(), []protocol.ResumeReq{{SID: s.SID(), OutSeq: head}})
		if got[0].Status != protocol.ResumeOK || got[0].FromSeq != head {
			t.Fatalf("got %+v, want ok/%d", got[0], head)
		}
	})

	t.Run("实例不符一律 gone，什么都不推", func(t *testing.T) {
		c := newConn(t, m, "tab")
		got := m.Resume(c, "some-old-instance", []protocol.ResumeReq{
			{SID: s.SID(), OutSeq: 999999},
			{SID: s.SID(), OutSeq: 0},
		})
		for _, r := range got {
			if r.Status != protocol.ResumeGone {
				t.Fatalf("sid %d status = %q, want gone", r.SID, r.Status)
			}
		}
		if len(c.Frames()) != 0 {
			t.Fatal("gone 的会话不该推任何帧")
		}
	})

	t.Run("首次连接没有 instance_id 时按正常流程走", func(t *testing.T) {
		got := m.Resume(newConn(t, m, "tab"), "", []protocol.ResumeReq{{SID: s.SID(), OutSeq: 0}})
		if got[0].Status != protocol.ResumeSnapshot {
			t.Fatalf("status = %q, want snapshot（out_seq 为 0）", got[0].Status)
		}
	})

	t.Run("sid 不存在也是 gone", func(t *testing.T) {
		got := m.Resume(newConn(t, m, "tab"), m.InstanceID(), []protocol.ResumeReq{{SID: 60000, OutSeq: 0}})
		if got[0].Status != protocol.ResumeGone {
			t.Fatalf("status = %q, want gone", got[0].Status)
		}
	})
}

// 增量还是快照（协议 §5.1）：out_seq > 0 且在窗口内 → 增量；其余一律快照。
// hello.resume 与 subscribe 走同一个判定。
func TestResumeSnapshotWhenOutOfWindow(t *testing.T) {
	c := cfg()
	c.RingBytes = 4096 // 调小，让落出窗口可测
	m := newManager(t, c)
	s := create(t, m)
	conn := newConn(t, m, "tab")
	s.Subscribe(conn, 0, 0, 0)

	if err := conn.Send(s, emitScript(300)); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, conn, "EMIT-DONE")
	waitFor(t, "缓冲发生裁剪", func() bool { return s.Info().BaseSeq > 0 })
	waitQuiet(t, s, 200*time.Millisecond)

	t.Run("落出窗口 → 快照，from_seq = 快照的 seq", func(t *testing.T) {
		re := newConn(t, m, "tab-r")
		got := m.Resume(re, m.InstanceID(), []protocol.ResumeReq{{SID: s.SID(), OutSeq: 1}})
		if got[0].Status != protocol.ResumeSnapshot {
			t.Fatalf("status = %q, want snapshot", got[0].Status)
		}
		if re.Snapshots() != 1 || got[0].FromSeq != re.OutSeq() || got[0].FromSeq != s.HeadSeq() {
			t.Fatalf("from_seq = %d，快照 seq = %d，head = %d —— 三者应当相等", got[0].FromSeq, re.OutSeq(), s.HeadSeq())
		}
		// 快照就是完整的画面：落出窗口的那段历史照样在里面（AC-2.6 不再"截断"）
		if !strings.Contains(render(re, 80, 24), "EMIT-DONE") {
			t.Fatal("快照里没有当前屏")
		}
	})

	t.Run("out_seq 为 0（第一次打开 / 刷新）→ 快照", func(t *testing.T) {
		fresh := newConn(t, m, "tab-2")
		if st, _ := s.Subscribe(fresh, 0, 0, 0); st != protocol.ResumeSnapshot || fresh.Snapshots() != 1 {
			t.Fatalf("status = %q snapshots = %d", st, fresh.Snapshots())
		}
	})

	t.Run("领先于 head → 快照", func(t *testing.T) {
		ahead := newConn(t, m, "tab-3")
		if st, from := s.Subscribe(ahead, s.HeadSeq()+1000, 0, 0); st != protocol.ResumeSnapshot || from != s.HeadSeq() {
			t.Fatalf("got %s/%d, want snapshot/%d", st, from, s.HeadSeq())
		}
	})

	t.Run("窗口内 → 增量，原样推缺的那段，不发快照", func(t *testing.T) {
		base, head := s.Info().BaseSeq, s.HeadSeq()
		incr := newConn(t, m, "tab-4")
		st, from := s.Subscribe(incr, base+10, 0, 0)
		if st != protocol.ResumeOK || from != base+10 {
			t.Fatalf("got %s/%d, want ok/%d", st, from, base+10)
		}
		if incr.Snapshots() != 0 {
			t.Fatal("窗口内却发了快照")
		}
		if uint64(len(incr.Screen())) != head-(base+10) || incr.OutSeq() != head {
			t.Fatalf("补齐了 %d 字节，want %d", len(incr.Screen()), head-(base+10))
		}
	})
}

// 未订阅的会话产生输出时，未订阅的连接也要收到 head_seq —— 未读靠它推导。
//
// 订阅只决定收不收 OUTPUT 字节；只发给订阅者的话，后台会话永远算不出未读。
func TestUnreadDerivedFromHeadSeq(t *testing.T) {
	m := newManager(t, cfg())
	visible, background := create(t, m), create(t, m)

	c := newConn(t, m, "tab")
	visible.Subscribe(c, 0, 0, 0) // 只订阅当前可见的那个

	if err := c.Send(background, "echo in-background\r"); err != nil {
		t.Fatal(err)
	}

	waitFor(t, "收到后台会话的 head_seq", func() bool {
		for _, e := range c.Events() {
			if u, ok := e.(*protocol.SessionUpdated); ok &&
				u.SID == background.SID() && u.HeadSeq != nil && *u.HeadSeq > 0 {
				return true
			}
		}
		return false
	})

	// 而它的字节【不该】过网络 —— 这是移动端的关键优化
	if strings.Contains(c.Screen(), "in-background") {
		t.Fatal("未订阅的会话把输出也推过来了")
	}
}
