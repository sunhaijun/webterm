package session_test

import (
	"strings"
	"testing"

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
	c := newConn(t, "tab")
	s.Subscribe(c, 0)

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
	c2 := newConn(t, "tab")
	s.Subscribe(c2, before)
	waitScreen(t, c2, "while-offline")
}

// IT-resume-2：增量回放 —— agent 只发 out_seq 之后的字节，不重发已收到的。
func TestITResume2_IncrementalReplay(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	c := newConn(t, "tab")
	s.Subscribe(c, 0)

	if err := c.Send(s, "echo marker-one\r"); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "marker-one")

	at := c.OutSeq()
	s.Unsubscribe(c)
	if err := c.Send(s, "echo marker-two\r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "第二段输出产生", func() bool { return s.HeadSeq() > at })

	// 从断点续订：只应收到断点之后的内容
	c2 := newConn(t, "tab")
	s.Subscribe(c2, at)
	waitScreen(t, c2, "marker-two")

	if strings.Contains(c2.Screen(), "marker-one") {
		t.Fatal("重发了客户端已经收到的字节 —— 续传应当是增量的")
	}
	if c2.Resets() != 0 {
		t.Fatal("缓冲没溢出却走了 reset 路径")
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
	c := newConn(t, "tab-1")
	s.Subscribe(c, 0)

	if err := c.Send(s, "echo A1\r"); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, c, "A1")
	waitFor(t, "输入被 ack", func() bool { return s.InAck("tab-1") == c.inSeqNext })

	// "断线"
	s.Unsubscribe(c)
	s.DetachClient("tab-1")

	// 重连：同一个 client_id 拿回自己的 in_ack
	c2 := newConn(t, "tab-1")
	resumed := m.Resume("tab-1", m.InstanceID(), []protocol.ResumeReq{
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
	s.Subscribe(c2, r.FromSeq)

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
	c := newConn(t, "tab")
	s.Subscribe(c, 0)

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
// 会落进"客户端领先"分支 —— 屏幕上留着旧会话的内容，之后接的却是一个
// 毫不相干的新会话的输出。
func TestITResume4_InstanceMismatchIsGone(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	waitFor(t, "有输出", func() bool { return s.HeadSeq() > 0 })

	t.Run("实例相符正常续传", func(t *testing.T) {
		got := m.Resume("tab", m.InstanceID(), []protocol.ResumeReq{{SID: s.SID(), OutSeq: 0}})
		if got[0].Status != protocol.ResumeOK {
			t.Fatalf("status = %q, want ok", got[0].Status)
		}
	})

	t.Run("实例不符一律 gone", func(t *testing.T) {
		got := m.Resume("tab", "some-old-instance", []protocol.ResumeReq{
			{SID: s.SID(), OutSeq: 999999},
			{SID: s.SID(), OutSeq: 0},
		})
		for _, r := range got {
			if r.Status != protocol.ResumeGone {
				t.Fatalf("sid %d status = %q, want gone", r.SID, r.Status)
			}
		}
	})

	t.Run("首次连接没有 instance_id 时按正常流程走", func(t *testing.T) {
		got := m.Resume("tab", "", []protocol.ResumeReq{{SID: s.SID(), OutSeq: 0}})
		if got[0].Status != protocol.ResumeOK {
			t.Fatalf("status = %q, want ok", got[0].Status)
		}
	})

	t.Run("sid 不存在也是 gone", func(t *testing.T) {
		got := m.Resume("tab", m.InstanceID(), []protocol.ResumeReq{{SID: 60000, OutSeq: 0}})
		if got[0].Status != protocol.ResumeGone {
			t.Fatalf("status = %q, want gone", got[0].Status)
		}
	})
}

// 缓冲被覆盖 → reset，并且【只有】这种情况才前置 ESC[0m。
func TestResumeResetWhenBufferOverwritten(t *testing.T) {
	c := cfg()
	c.RingBytes = 4096 // 调小，让 reset 路径可测
	m := newManager(t, c)
	s := create(t, m)
	conn := newConn(t, "tab")
	s.Subscribe(conn, 0)

	if err := conn.Send(s, emitScript(300)); err != nil {
		t.Fatal(err)
	}
	waitScreen(t, conn, "EMIT-DONE")
	waitFor(t, "缓冲发生裁剪", func() bool { return s.Snapshot().BaseSeq > 0 })

	got := m.Resume("tab", m.InstanceID(), []protocol.ResumeReq{{SID: s.SID(), OutSeq: 0}})
	if got[0].Status != protocol.ResumeReset {
		t.Fatalf("status = %q, want reset", got[0].Status)
	}
	if got[0].FromSeq != s.Snapshot().BaseSeq {
		t.Fatalf("from_seq = %d, want base_seq %d", got[0].FromSeq, s.Snapshot().BaseSeq)
	}

	// 走 reset 路径的订阅：必须带属性修正前缀
	fresh := newConn(t, "tab-2")
	s.Subscribe(fresh, 0)
	if fresh.Resets() != 1 {
		t.Fatalf("reset 次数 = %d, want 1", fresh.Resets())
	}
	if !strings.HasPrefix(fresh.Screen(), string(protocol.AttrPrefix)) {
		t.Fatal("reset 回放没有前置 ESC[0m")
	}

	// 而普通增量续传【绝不能】前置 —— 注入会清掉断点处生效中的属性
	incr := newConn(t, "tab-3")
	s.Subscribe(incr, s.Snapshot().BaseSeq+10)
	if incr.Resets() != 0 {
		t.Fatal("增量续传注入了 ESC[0m —— 会让字节级连续性失败")
	}
}

// 客户端领先（out_seq > head_seq）时不回放，不当成空洞。
func TestResumeClientAhead(t *testing.T) {
	m := newManager(t, cfg())
	s := create(t, m)
	waitFor(t, "有输出", func() bool { return s.HeadSeq() > 0 })

	head := s.HeadSeq()
	got := m.Resume("tab", m.InstanceID(), []protocol.ResumeReq{{SID: s.SID(), OutSeq: head + 1000}})
	if got[0].Status != protocol.ResumeOK || got[0].FromSeq != head {
		t.Fatalf("got %+v, want ok/from_seq=%d", got[0], head)
	}
}
