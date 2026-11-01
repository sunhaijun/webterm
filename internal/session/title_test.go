package session

import (
	"strings"
	"testing"
)

// UT-name-2：终端标题清洗（ADR-0043 §3）。控制字符换成空格、连续空白合一、
// 去掉首尾空白、最多 64 个字符；内容本身（claude 的 ✳ ◐ 前缀）原样保留。
func TestCleanTitle(t *testing.T) {
	cases := []struct{ in, want string }{
		{"✳ Claude Code", "✳ Claude Code"},
		{"◐ Fix login bug", "◐ Fix login bug"},
		{"  padded  ", "padded"},
		{"a\tb\x01c\x7fd\u0085e", "a b c d e"},
		{"line1\nline2", "line1 line2"},
		{"a   b", "a b"},
		{"\x00\x1f  ", ""},
		{"", ""},
		{strings.Repeat("长", 70), strings.Repeat("长", 64)},
	}
	for _, c := range cases {
		if got := cleanTitle(c.in); got != c.want {
			t.Errorf("cleanTitle(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// UT-name-2：标题只在「设它的进程组仍在前台、且不是 shell 本身」时采用（ADR-0043 §2）。
func TestPickTitle(t *testing.T) {
	const shell, prog, other = 100, 200, 300
	cases := []struct {
		name             string
		raw              string
		fg, owner, shPID int
		want             string
	}{
		{"程序设的、它还在前台", "✳ Claude Code", prog, prog, shell, "✳ Claude Code"},
		{"shell 在提示符时设的", "sun@host: ~/x", shell, shell, shell, ""},
		{"程序退出、回到提示符", "✳ Claude Code", shell, prog, shell, ""},
		{"别的程序在前台、还没设过", "✳ Claude Code", other, prog, shell, ""},
		{"没设过标题", "", prog, prog, shell, ""},
		{"清洗后为空", " \x07 ", prog, prog, shell, ""},
		{"不知道 shell 的 pid", "vim", prog, prog, 0, "vim"},
		{"没有归属", "x", prog, 0, shell, ""},
	}
	for _, c := range cases {
		if got := pickTitle(c.raw, c.fg, c.owner, c.shPID); got != c.want {
			t.Errorf("%s: pickTitle = %q, want %q", c.name, got, c.want)
		}
	}
}
