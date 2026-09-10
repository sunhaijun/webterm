// Package transcript 跟踪 AI CLI（Claude Code / Codex）的会话文件，把对话以小 JSON 推给页面
// （ADR-0012 β）。读视图据此渲成 Markdown 卡片：流量只有文字本身，与终端列宽无关。
package transcript

import (
	"path"
	"regexp"
	"strings"
)

var (
	splitCmd  = regexp.MustCompile(`\s*(?:\|\||&&|;|\|)\s*`)
	envAssign = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)
	wrappers  = map[string]bool{
		"sudo": true, "doas": true, "nohup": true, "time": true, "exec": true,
		"env": true, "command": true, "builtin": true, "nice": true, "ionice": true,
	}
)

// ProgramOf 取命令行里"真正跑的程序名"：管道 / 分号 / && 之后最后一段的第一个
// 非环境变量赋值、非包装器（sudo / env / nohup…）的词的 basename。
// 与前端 keymap.ts 的 programOf 同一套规则 —— 键条上下文和转录跟踪要认同一个程序。
func ProgramOf(cmd string) string {
	segs := splitCmd.Split(cmd, -1)
	last := ""
	for i := len(segs) - 1; i >= 0; i-- {
		if strings.TrimSpace(segs[i]) != "" {
			last = segs[i]
			break
		}
	}
	for _, w := range strings.Fields(last) {
		if envAssign.MatchString(w) || wrappers[w] || strings.HasPrefix(w, "-") {
			continue
		}
		base := path.Base(w)
		return strings.Trim(base, `"'`)
	}
	return ""
}

// SourceFor 报告某个程序有没有我们认识的会话文件格式。
func SourceFor(program string) string {
	switch program {
	case "claude":
		return "claude"
	case "codex":
		return "codex"
	}
	return ""
}
