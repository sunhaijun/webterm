package transcript

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/sunhaijun/webterm/internal/protocol"
)

// Codex 的 rollout：~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl。
// 每行 {timestamp, type, payload}；对话在 response_item/message 里，developer 消息是系统提示，
// 注入的用户消息（AGENTS.md、environment_context）以 # / < 开头。
type codexLine struct {
	Type      string          `json:"type"`
	Timestamp string          `json:"timestamp"`
	Payload   json.RawMessage `json:"payload"`
}

type codexPayload struct {
	Type      string `json:"type"`
	ID        string `json:"id"`
	Role      string `json:"role"`
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
	Input     string `json:"input"`
	CWD       string `json:"cwd"`
	Content   []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
}

func parseCodex(line []byte, seq int) []protocol.TranscriptItem {
	var l codexLine
	if err := json.Unmarshal(line, &l); err != nil || l.Type != "response_item" {
		return nil
	}
	var p codexPayload
	if err := json.Unmarshal(l.Payload, &p); err != nil {
		return nil
	}
	at := parseTime(l.Timestamp)
	id := p.ID
	if id == "" {
		id = fmt.Sprintf("c%d", seq)
	}
	switch p.Type {
	case "message":
		if p.Role == "developer" {
			return nil
		}
		var out []protocol.TranscriptItem
		for i, c := range p.Content {
			if c.Type != "input_text" && c.Type != "output_text" {
				continue
			}
			t := strings.TrimSpace(c.Text)
			if t == "" {
				continue
			}
			role := "assistant"
			if p.Role == "user" {
				// 注入的上下文不是用户说的话
				if strings.HasPrefix(t, "<") || strings.HasPrefix(t, "# AGENTS.md") {
					continue
				}
				role = "user"
			}
			out = append(out, protocol.TranscriptItem{ID: fmt.Sprintf("%s#%d", id, i), Role: role, Kind: "text", Text: c.Text, At: at})
		}
		return out
	case "function_call", "custom_tool_call":
		text := p.Input
		if text == "" && p.Arguments != "" {
			text = summarizeInput(p.Name, json.RawMessage(p.Arguments))
			if text == "" {
				text = oneLine(p.Arguments)
			}
		}
		return []protocol.TranscriptItem{{ID: id, Role: "tool", Kind: "tool_use", Name: p.Name, Text: oneLine(text), At: at}}
	}
	return nil
}

// codexMetaCWD 从 session_meta 行取 cwd（定位会话文件时核对用）。
func codexMetaCWD(line []byte) string {
	var l codexLine
	if err := json.Unmarshal(line, &l); err != nil || l.Type != "session_meta" {
		return ""
	}
	var p codexPayload
	if err := json.Unmarshal(l.Payload, &p); err != nil {
		return ""
	}
	return p.CWD
}
