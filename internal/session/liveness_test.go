package session

import (
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/protocol"
)

// 按命令的活性探测（协议 §4.7）。
//
// 规则只有一条：一次 Enter 之后【有输出却零标记】才算一次未标记往返。
// 有钩子的 shell 里，非空命令几十毫秒内发 133;C，空 Enter 重画 prompt
// 发 133;A/B —— 所以"零标记"是明确的，不需要时间阈值来猜。
//
// 这里不等真实的 2 秒定时器，直接调 resolveProbe(gen) 模拟到期。

func newProbed(state, integration string) *Session {
	return &Session{promptState: state, integration: integration}
}

func enter(s *Session) int {
	s.mu.Lock()
	s.armProbeLocked([]byte("ls\r"), time.Now())
	gen := s.probeGen
	s.mu.Unlock()
	return gen
}

func output(s *Session) {
	s.mu.Lock()
	if s.probeArmed {
		s.probeOutput = true
	}
	s.mu.Unlock()
}

func mark(s *Session) { s.markIntegrationAlive() }

func state(s *Session) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.integration, s.unmarkedInput
}

// 这是【绝大多数】情况：Enter → 133;C 到达 → 探针清零，什么都不发生。
func TestProbeMarkArrivesInTime(t *testing.T) {
	s := newProbed(protocol.PromptInput, protocol.IntegrationActive)
	for i := 0; i < 5; i++ {
		gen := enter(s)
		output(s)
		mark(s) // 133;C
		s.resolveProbe(gen)
	}
	if in, un := state(s); in != protocol.IntegrationActive || un {
		t.Errorf("正常往返后 integration=%q unmarked=%v", in, un)
	}
}

// 空 Enter 也会重画 prompt 发 A/B —— 同样算"有标记"，不能记 miss。
func TestProbeEmptyEnterIsNotAMiss(t *testing.T) {
	s := newProbed(protocol.PromptInput, protocol.IntegrationActive)
	for i := 0; i < 5; i++ {
		gen := enter(s)
		output(s) // 新 prompt 也是输出
		mark(s)   // 133;A/B
		s.resolveProbe(gen)
	}
	if in, _ := state(s); in != protocol.IntegrationActive {
		t.Errorf("空 Enter 之后 integration=%q", in)
	}
}

// 真踩到的场景 #1 的对偶：在 prompt 前敲命令，有输出，却一个标记都没有 ——
// 这个 shell 自己的钩子没了（trap - DEBUG / PROMPT_COMMAND=）。
func TestProbeHooksGoneAtPrompt(t *testing.T) {
	s := newProbed(protocol.PromptInput, protocol.IntegrationActive)

	gen := enter(s)
	output(s)
	s.resolveProbe(gen)
	if in, _ := state(s); in != protocol.IntegrationActive {
		t.Fatalf("一次 miss 就判 inactive 了 —— 单次可能是巧合")
	}

	gen = enter(s)
	output(s)
	s.resolveProbe(gen)
	if in, un := state(s); in != protocol.IntegrationInactive || un {
		t.Errorf("两次 miss 后 integration=%q unmarked=%v，想要 inactive/false", in, un)
	}
}

// ssh / su / 容器 / REPL：外层命令在跑，里面 Enter 有回应却无标记。
// 【不能动 integration】—— 外层 shell 没坏，只报告"输入去了没集成的地方"。
func TestProbeSubProgramWhileRunning(t *testing.T) {
	s := newProbed(protocol.PromptRunning, protocol.IntegrationActive)
	for i := 0; i < 2; i++ {
		gen := enter(s)
		output(s)
		s.resolveProbe(gen)
	}
	if in, un := state(s); in != protocol.IntegrationActive || !un {
		t.Errorf("子程序里两次 miss 后 integration=%q unmarked=%v，想要 active/true", in, un)
	}

	// 退出子程序：外层 133;D / A / B 回来 → 清零
	mark(s)
	if _, un := state(s); un {
		t.Error("标记回来之后 unmarked 没清")
	}
}

// 没有输出就不算：sleep 之类安静的命令不能被当成未标记往返。
func TestProbeNoOutputIsNotAMiss(t *testing.T) {
	s := newProbed(protocol.PromptInput, protocol.IntegrationActive)
	for i := 0; i < 3; i++ {
		gen := enter(s)
		s.resolveProbe(gen) // 到期时没有任何输出
	}
	if in, _ := state(s); in != protocol.IntegrationActive {
		t.Errorf("无输出到期后 integration=%q", in)
	}
}

// 到期定时器只认自己那一代 —— 旧探针的定时器不能结算新探针。
func TestProbeStaleTimerIgnored(t *testing.T) {
	s := newProbed(protocol.PromptInput, protocol.IntegrationActive)
	gen1 := enter(s)
	mark(s) // 第一次正常：标记到了，探针清零
	gen2 := enter(s)
	output(s)
	s.resolveProbe(gen1) // 旧定时器晚到
	s.mu.Lock()
	armed := s.probeArmed
	s.mu.Unlock()
	if !armed {
		t.Fatal("旧一代的定时器把新探针结算掉了")
	}
	_ = gen2
}

// 快速连按 Enter 不能被合并成一次：已有探针在等时不重新装。
func TestProbeDoesNotRearmWhileArmed(t *testing.T) {
	s := newProbed(protocol.PromptInput, protocol.IntegrationActive)
	g1 := enter(s)
	g2 := enter(s)
	if g1 != g2 {
		t.Errorf("探针在等的时候又装了一个：gen %d → %d", g1, g2)
	}
}

// 握手两级判定：收到 hello 就不再因超时判 inactive；没收到才判。
func TestHelloTimeoutOnlyWithoutHello(t *testing.T) {
	noHello := &Session{integration: protocol.IntegrationPending}
	noHello.onHelloTimeout()
	if in, _ := state(noHello); in != protocol.IntegrationInactive {
		t.Errorf("没有 hello 超时后 integration=%q，想要 inactive", in)
	}

	withHello := &Session{integration: protocol.IntegrationPending, helloSeen: true}
	withHello.onHelloTimeout()
	if in, _ := state(withHello); in != protocol.IntegrationPending {
		t.Errorf("收到 hello 但 dotfile 慢，超时后 integration=%q，应保持 pending", in)
	}

	// 之后第一个标记到达 → active
	mark(withHello)
	if in, _ := state(withHello); in != protocol.IntegrationActive {
		t.Errorf("第一个标记后 integration=%q，想要 active", in)
	}
}
