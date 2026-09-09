package session

import (
	"testing"

	"github.com/sunhaijun/webterm/internal/protocol"
)

// orderLog 把控制消息（经 sink）与输出帧（经 Push）记进同一条时间线，
// 用来证明两者的先后。
type orderLog struct {
	events []string
}

type orderSub struct{ log *orderLog }

func (o *orderSub) ClientID() string { return "order" }
func (o *orderSub) Push(_ uint16, seq uint64, data []byte, _ bool) {
	o.log.events = append(o.log.events, "frame")
	_ = seq
	_ = data
}
func (o *orderSub) Event(msg any) {}

// IT-order-1：command.start / command.end 先于包含其 out_seq 的输出帧到达
// （协议 §4 顺序承诺；ADR-0011 ④ 的行锚点靠它）。
//
// 事件与帧走同一条按序写队列，所以 consume 里调用的先后就是客户端收到的先后。
func TestITOrder1_CommandEventsBeforeFrame(t *testing.T) {
	s, _ := newStampSession(t)
	log := &orderLog{}
	s.sink = func(msg any) {
		switch msg.(type) {
		case *protocol.CommandStart:
			log.events = append(log.events, "start")
		case *protocol.CommandEnd:
			log.events = append(log.events, "end")
		}
	}
	s.subs = map[Subscriber]struct{}{} // newStampSession 不建订阅表
	s.Subscribe(&orderSub{log: log}, 0)
	// 让 Subscribe 可能推的初始帧不干扰计数
	log.events = nil

	// 一条快命令的 start / 输出 / end 在同一次读里到达
	s.consume([]byte("$ " + cmdOSC("echo hi") + "\x1b]133;C\x07" + "hi\n" + "\x1b]133;D;0\x07" + "$ "))

	want := []string{"start", "end", "frame"}
	if len(log.events) != len(want) {
		t.Fatalf("时间线 = %v，想要 %v", log.events, want)
	}
	for i := range want {
		if log.events[i] != want[i] {
			t.Fatalf("时间线 = %v，想要 %v（事件必须先于帧）", log.events, want)
		}
	}
}
