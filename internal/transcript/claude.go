package transcript

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/sunhaijun/webterm/internal/protocol"
)

// Claude Code 的会话文件：~/.claude/projects/<cwd-slug>/<session>.jsonl，
// 每个内容块一行（thinking / text / tool_use / tool_result），块完成即落盘。
type claudeLine struct {
	Type        string `json:"type"`
	UUID        string `json:"uuid"`
	Timestamp   string `json:"timestamp"`
	IsSidechain bool   `json:"isSidechain"`
	IsMeta      bool   `json:"isMeta"`
	CWD         string `json:"cwd"`
	Message     struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

type claudeBlock struct {
	Type  string          `json:"type"`
	Text  string          `json:"text"`
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
}

// parseClaude 把一行变成 0..n 条转录。子代理（sidechain）、元消息、工具结果、思考都不进转录。
func parseClaude(line []byte, seq int) []protocol.TranscriptItem {
	var l claudeLine
	if err := json.Unmarshal(line, &l); err != nil {
		return nil
	}
	if l.Type != "user" && l.Type != "assistant" {
		return nil
	}
	if l.IsSidechain || l.IsMeta {
		return nil
	}
	at := parseTime(l.Timestamp)
	id := l.UUID
	if id == "" {
		id = fmt.Sprintf("l%d", seq)
	}
	var out []protocol.TranscriptItem
	// user 的 content 可能是字串（就是 prompt）
	var str string
	if err := json.Unmarshal(l.Message.Content, &str); err == nil {
		if t := strings.TrimSpace(str); t != "" {
			out = append(out, protocol.TranscriptItem{ID: id + "#0", Role: roleOf(l.Type, t), Kind: "text", Text: str, At: at})
		}
		return out
	}
	var blocks []claudeBlock
	if err := json.Unmarshal(l.Message.Content, &blocks); err != nil {
		return nil
	}
	for i, b := range blocks {
		bid := fmt.Sprintf("%s#%d", id, i)
		switch b.Type {
		case "text":
			if strings.TrimSpace(b.Text) == "" {
				continue
			}
			out = append(out, protocol.TranscriptItem{ID: bid, Role: roleOf(l.Type, b.Text), Kind: "text", Text: b.Text, At: at})
		case "tool_use":
			out = append(out, protocol.TranscriptItem{ID: bid, Role: "tool", Kind: "tool_use", Name: b.Name, Text: summarizeInput(b.Name, b.Input), At: at})
		}
	}
	return out
}

// roleOf：斜杠命令的本地回显（<command-name>… / <local-command-stdout>…）标成 system，
// 免得把它们当成用户说的话。
func roleOf(typ, text string) string {
	if typ == "assistant" {
		return "assistant"
	}
	t := strings.TrimSpace(text)
	if strings.HasPrefix(t, "<command-") || strings.HasPrefix(t, "<local-command") || strings.HasPrefix(t, "<system-reminder") || strings.HasPrefix(t, "<task-notification") {
		return "system"
	}
	return "user"
}

// summarizeInput 把工具调用压成一行：Bash 给命令，读写给路径，搜索给模式，其余给第一个字串字段。
func summarizeInput(name string, raw json.RawMessage) string {
	var in map[string]any
	if err := json.Unmarshal(raw, &in); err != nil || in == nil {
		return ""
	}
	pick := func(keys ...string) string {
		for _, k := range keys {
			if v, ok := in[k].(string); ok && strings.TrimSpace(v) != "" {
				return oneLine(v)
			}
		}
		return ""
	}
	if s := pick("command", "file_path", "path", "pattern", "query", "prompt", "description", "url"); s != "" {
		return s
	}
	for _, v := range in {
		if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
			return oneLine(s)
		}
	}
	return ""
}

func oneLine(s string) string {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\n", " "))
	const max = 200
	if len(s) > max {
		return s[:max] + "…"
	}
	return s
}

func parseTime(s string) int64 {
	if s == "" {
		return time.Now().UnixMilli()
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t.UnixMilli()
	}
	return time.Now().UnixMilli()
}
