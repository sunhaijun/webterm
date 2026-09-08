package session

import (
	"encoding/base64"
	"testing"

	"github.com/sunhaijun/webterm/internal/oscparse"
	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/ringbuf"
	"github.com/sunhaijun/webterm/internal/store"
)

// command.start / command.end 的 out_seq 必须是标记在输出流里的【精确位置】。
//
// 一条快命令的 1701;cmd、133;C、输出、133;D、新 prompt 常在同一次 PTY 读里
// 到达。以前用整块 append 之后的 head 盖戳，于是 start == end，块的字节
// 区间为空 —— 命令块视图渲染成一行空白。本地读块碎所以偶发，CI 上稳定复现。
func newStampSession(t *testing.T) (*Session, *[]any) {
	t.Helper()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	var got []any
	s := &Session{
		sid:        1,
		ring:       ringbuf.New(1 << 16),
		osc:        oscparse.New(),
		store:      st,
		mgrHistory: func() bool { return true },
		inQueued:   map[string]uint64{},
		inAck:      map[string]uint64{},
	}
	s.sink = func(msg any) { got = append(got, msg) }
	return s, &got
}

func cmdOSC(text string) string {
	return "\x1b]1701;cmd;" + base64.StdEncoding.EncodeToString([]byte(text)) + "\x07"
}

func stamps(got []any) (start *protocol.CommandStart, end *protocol.CommandEnd) {
	for _, m := range got {
		switch v := m.(type) {
		case *protocol.CommandStart:
			start = v
		case *protocol.CommandEnd:
			end = v
		}
	}
	return
}

func TestOutSeqPreciseWithinOneChunk(t *testing.T) {
	s, got := newStampSession(t)
	pre, out, post := "$ ", "hello\n", "$ "
	// 整条命令的生命周期在【一次】读里到达
	s.consume([]byte(pre + cmdOSC("echo hello") + "\x1b]133;C\x07" + out + "\x1b]133;D;0\x07" + post))

	start, end := stamps(*got)
	if start == nil || end == nil {
		t.Fatalf("没有收到 start/end：%#v", *got)
	}
	if start.OutSeq != uint64(len(pre)) {
		t.Errorf("start.out_seq = %d，想要 %d（133;C 之前只吐了 prompt）", start.OutSeq, len(pre))
	}
	if end.OutSeq != uint64(len(pre)+len(out)) {
		t.Errorf("end.out_seq = %d，想要 %d", end.OutSeq, len(pre)+len(out))
	}
	if end.OutSeq == start.OutSeq {
		t.Fatal("start == end：块区间为空 —— 就是那个 CI 上的 bug")
	}
	// 按区间从环形缓冲切出来的，必须恰好是这条命令的输出
	data, _, _ := s.ring.Replay(start.OutSeq)
	if got := string(data[:end.OutSeq-start.OutSeq]); got != out {
		t.Errorf("按 [start,end) 切出 %q，想要 %q", got, out)
	}
}

// 环形缓冲里已经有内容时，盖戳要加上块首 seq，而不是从 0 算。
func TestOutSeqAddsChunkBase(t *testing.T) {
	s, got := newStampSession(t)
	s.consume([]byte("earlier output\n")) // 15 字节，无事件
	s.consume([]byte(cmdOSC("true") + "\x1b]133;C\x07" + "x\n" + "\x1b]133;D;0\x07"))

	start, end := stamps(*got)
	if start == nil || end == nil {
		t.Fatal("没有收到 start/end")
	}
	if start.OutSeq != 15 || end.OutSeq != 17 {
		t.Errorf("start/end = %d/%d，想要 15/17", start.OutSeq, end.OutSeq)
	}
}

// 分两次读到达时结论必须相同 —— 偏移是相对每次 Feed 的，session 要各加各的块首。
func TestOutSeqSameAcrossSplit(t *testing.T) {
	s, got := newStampSession(t)
	s.consume([]byte("$ " + cmdOSC("echo hi") + "\x1b]133;C\x07hi\n"))
	s.consume([]byte("\x1b]133;D;0\x07$ "))

	start, end := stamps(*got)
	if start == nil || end == nil {
		t.Fatal("没有收到 start/end")
	}
	if start.OutSeq != 2 || end.OutSeq != 5 {
		t.Errorf("start/end = %d/%d，想要 2/5", start.OutSeq, end.OutSeq)
	}
}
