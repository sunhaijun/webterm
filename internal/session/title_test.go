package session

import (
	"strings"
	"testing"
)

// UT-name-2: title sanitizing (ADR-0043 §3). Control characters become spaces,
// whitespace runs collapse, leading and trailing whitespace is trimmed, and the
// length is capped at 64 characters. Content (claude's ✳ ◐ prefix) is kept.
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

// UT-name-2: a title is used only while the process group that set it is still
// in the foreground and is not the shell itself (ADR-0043 §2).
func TestPickTitle(t *testing.T) {
	const shell, prog, other = 100, 200, 300
	cases := []struct {
		name             string
		raw              string
		fg, owner, shPID int
		want             string
	}{
		{"set by the program, still in foreground", "✳ Claude Code", prog, prog, shell, "✳ Claude Code"},
		{"set by the shell at the prompt", "user@host: ~/x", shell, shell, shell, ""},
		{"program exited, back at the prompt", "✳ Claude Code", shell, prog, shell, ""},
		{"another program in foreground, no title yet", "✳ Claude Code", other, prog, shell, ""},
		{"no title set", "", prog, prog, shell, ""},
		{"empty after sanitizing", " \x07 ", prog, prog, shell, ""},
		{"shell pid unknown", "vim", prog, prog, 0, "vim"},
		{"no owner", "x", prog, 0, shell, ""},
	}
	for _, c := range cases {
		if got := pickTitle(c.raw, c.fg, c.owner, c.shPID); got != c.want {
			t.Errorf("%s: pickTitle = %q, want %q", c.name, got, c.want)
		}
	}
}
