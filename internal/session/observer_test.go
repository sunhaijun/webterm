package session

import (
	"testing"
)

type fakeObs struct{ events []string }

func (f *fakeObs) CommandStarted(sid uint16, text, cwd string) {
	f.events = append(f.events, "start:"+text)
}
func (f *fakeObs) CommandEnded(sid uint16)  { f.events = append(f.events, "end") }
func (f *fakeObs) SessionClosed(sid uint16) { f.events = append(f.events, "closed") }

// IT-observer-1：命令旁听者在 133;C / 133;D 上被同步调用，拿到命令文本（ADR-0012 β）。
func TestCommandObserverHooks(t *testing.T) {
	s, _ := newStampSession(t)
	obs := &fakeObs{}
	s.obs = obs
	s.consume([]byte("$ " + cmdOSC("claude --model sonnet") + "\x1b]133;C\x07" + "hi\n" + "\x1b]133;D;0\x07" + "$ "))
	want := []string{"start:claude --model sonnet", "end"}
	if len(obs.events) != len(want) {
		t.Fatalf("events = %v, want %v", obs.events, want)
	}
	for i := range want {
		if obs.events[i] != want[i] {
			t.Fatalf("events = %v, want %v", obs.events, want)
		}
	}
	// 空回车（没有 1701;cmd）不算命令，不叫旁听者
	obs.events = nil
	s.consume([]byte("\x1b]133;C\x07\x1b]133;D;0\x07$ "))
	if len(obs.events) != 0 {
		t.Fatalf("空回车不该触发旁听者：%v", obs.events)
	}
}
