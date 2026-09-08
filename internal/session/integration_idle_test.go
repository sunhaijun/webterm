package session

import (
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/protocol"
)

// 集成"失效"判定。
//
// 【没有 OSC 133 标记 ≠ 集成坏了】。标记只在 prompt 前后发，所以"多久
// 没标记"根本不是存活信号。原来的实现只看时间差，把两种完全正常的
// 情况判成失效 —— 其中第一种真的发生了：用户在 top 里待了几分钟，
// UI 就弹出"shell 集成未生效"。
func TestCheckIntegrationIdle(t *testing.T) {
	now := time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)
	long := integrationIdleTimeout + time.Minute
	short := time.Minute

	cases := []struct {
		name        string
		promptState string
		markAgo     time.Duration
		inputAgo    time.Duration // 距 now 多久之前有过输入
		noMarkYet   bool
		wantStale   bool
	}{
		{
			// 这条就是真踩到的：top 跑着，前台程序不产生任何标记
			name: "前台跑着长命令 → 不算失效", promptState: protocol.PromptRunning,
			markAgo: long, inputAgo: long + time.Minute, wantStale: false,
		},
		{
			name: "停在 prompt 前发呆 → 不算失效", promptState: protocol.PromptInput,
			markAgo: long, inputAgo: long + time.Minute, wantStale: false,
		},
		{
			// 敲了东西、命令跑过，却一个标记都没来 —— 这才是真坏了
			name: "标记之后有输入却始终没有新标记 → 失效", promptState: protocol.PromptInput,
			markAgo: long, inputAgo: short, wantStale: true,
		},
		{
			name: "有输入但还没超时 → 不算失效", promptState: protocol.PromptInput,
			markAgo: short, inputAgo: short / 2, wantStale: false,
		},
		{
			name: "从来没有过标记 → 交给握手超时管，这里不判", promptState: "",
			noMarkYet: true, inputAgo: short, wantStale: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := &Session{integration: protocol.IntegrationActive, promptState: tc.promptState}
			if !tc.noMarkYet {
				s.lastMark = now.Add(-tc.markAgo)
			}
			s.lastInput = now.Add(-tc.inputAgo)

			s.checkIntegrationIdle(now)

			s.mu.Lock()
			got := s.integration
			s.mu.Unlock()
			want := protocol.IntegrationActive
			if tc.wantStale {
				want = protocol.IntegrationInactive
			}
			if got != want {
				t.Errorf("integration = %q，想要 %q", got, want)
			}
		})
	}
}

// 收到标记要立刻从 inactive 转回 active —— 误判过也要能自己恢复。
func TestMarkIntegrationAliveRecovers(t *testing.T) {
	s := &Session{integration: protocol.IntegrationInactive}
	s.markIntegrationAlive()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.integration != protocol.IntegrationActive {
		t.Errorf("收到标记后 integration = %q，想要 active", s.integration)
	}
	if s.lastMark.IsZero() {
		t.Error("lastMark 应当被更新")
	}
}
