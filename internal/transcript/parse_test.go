package transcript

import (
	"testing"
)

// UT-transcript-2：Claude Code 会话行 → 转录条目。样本取自本机真实文件的形状。
func TestParseClaude(t *testing.T) {
	user := []byte(`{"type":"user","uuid":"u1","timestamp":"2026-09-09T06:31:00.000Z","cwd":"/home/sun","message":{"role":"user","content":"请解释 Go 的 context 包"}}`)
	got := parseClaude(user, 1)
	if len(got) != 1 || got[0].Role != "user" || got[0].Kind != "text" || got[0].Text != "请解释 Go 的 context 包" || got[0].ID != "u1#0" || got[0].At != 1788935460000 {
		t.Fatalf("user = %+v", got)
	}

	asst := []byte(`{"type":"assistant","uuid":"a1","timestamp":"2026-09-09T06:31:05.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"…"},{"type":"text","text":"## context\n\n用于取消。"},{"type":"tool_use","name":"Bash","input":{"command":"go test ./...","description":"跑测试"}}]}}`)
	got = parseClaude(asst, 2)
	if len(got) != 2 {
		t.Fatalf("assistant 应有 text + tool_use 两条（thinking 不进），得 %d: %+v", len(got), got)
	}
	if got[0].Role != "assistant" || got[0].Kind != "text" || got[0].Text != "## context\n\n用于取消。" || got[0].ID != "a1#1" {
		t.Fatalf("text = %+v", got[0])
	}
	if got[1].Role != "tool" || got[1].Kind != "tool_use" || got[1].Name != "Bash" || got[1].Text != "go test ./..." {
		t.Fatalf("tool_use = %+v", got[1])
	}

	// 工具结果、元消息、子代理、别的类型都不进转录
	for name, line := range map[string]string{
		"tool_result": `{"type":"user","uuid":"u2","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"ok"}]}}`,
		"isMeta":      `{"type":"user","uuid":"u3","isMeta":true,"message":{"role":"user","content":"meta"}}`,
		"sidechain":   `{"type":"assistant","uuid":"a2","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"sub"}]}}`,
		"other":       `{"type":"file-history-snapshot","messageId":"m"}`,
		"garbage":     `not json`,
	} {
		if got := parseClaude([]byte(line), 9); len(got) != 0 {
			t.Errorf("%s 不该产生条目: %+v", name, got)
		}
	}

	// 斜杠命令的本地回显标成 system
	cmd := []byte(`{"type":"user","uuid":"u4","message":{"role":"user","content":"<command-name>/model</command-name>"}}`)
	if got := parseClaude(cmd, 3); len(got) != 1 || got[0].Role != "system" {
		t.Fatalf("command echo = %+v", got)
	}
}

// UT-transcript-3：Codex rollout 行 → 转录条目。
func TestParseCodex(t *testing.T) {
	dev := []byte(`{"timestamp":"2026-09-09T13:26:12.437Z","type":"response_item","payload":{"type":"message","id":"m0","role":"developer","content":[{"type":"input_text","text":"<skills_instructions>"}]}}`)
	if got := parseCodex(dev, 1); len(got) != 0 {
		t.Fatalf("developer 不进转录: %+v", got)
	}
	injected := []byte(`{"timestamp":"2026-09-09T13:26:12.437Z","type":"response_item","payload":{"type":"message","id":"m1","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions\n\n…"},{"type":"input_text","text":"<environment_context>\n<cwd>/x</cwd>"}]}}`)
	if got := parseCodex(injected, 2); len(got) != 0 {
		t.Fatalf("注入的上下文不进转录: %+v", got)
	}
	user := []byte(`{"timestamp":"2026-09-09T13:26:20.000Z","type":"response_item","payload":{"type":"message","id":"m2","role":"user","content":[{"type":"input_text","text":"继续推进"}]}}`)
	got := parseCodex(user, 3)
	if len(got) != 1 || got[0].Role != "user" || got[0].Text != "继续推进" || got[0].ID != "m2#0" {
		t.Fatalf("user = %+v", got)
	}
	asst := []byte(`{"timestamp":"2026-09-09T13:26:30.000Z","type":"response_item","payload":{"type":"message","id":"m3","role":"assistant","content":[{"type":"output_text","text":"我先查看仓库约定。"}]}}`)
	got = parseCodex(asst, 4)
	if len(got) != 1 || got[0].Role != "assistant" || got[0].Kind != "text" || got[0].Text != "我先查看仓库约定。" {
		t.Fatalf("assistant = %+v", got)
	}
	tool := []byte(`{"timestamp":"2026-09-09T13:26:31.000Z","type":"response_item","payload":{"type":"function_call","id":"f1","name":"shell","arguments":"{\"command\":\"ls -la\"}"}}`)
	got = parseCodex(tool, 5)
	if len(got) != 1 || got[0].Role != "tool" || got[0].Name != "shell" || got[0].Text != "ls -la" {
		t.Fatalf("function_call = %+v", got)
	}
	for name, line := range map[string]string{
		"reasoning": `{"type":"response_item","payload":{"type":"reasoning","summary":[]}}`,
		"event":     `{"type":"event_msg","payload":{"type":"token_count"}}`,
		"meta":      `{"type":"session_meta","payload":{"cwd":"/home/sun"}}`,
	} {
		if got := parseCodex([]byte(line), 9); len(got) != 0 {
			t.Errorf("%s 不该产生条目: %+v", name, got)
		}
	}
	if codexMetaCWD([]byte(`{"type":"session_meta","payload":{"cwd":"/home/sun"}}`)) != "/home/sun" {
		t.Fatal("session_meta.cwd")
	}
}
