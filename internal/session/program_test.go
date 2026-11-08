package session

import "testing"

// UT-program-1 (AC-3.24, ADR-0054 §2): which program is in front, from the
// executable and argv. The process name isn't used: one claude is "claude",
// another "2.1.316".
func TestClassifyProgram(t *testing.T) {
	cases := []struct {
		name string
		exe  string
		argv []string
		want string
	}{
		{"claude native, run by its version path", "/home/u/.local/share/claude/versions/2.1.316",
			[]string{"/home/u/.local/share/claude/versions/2.1.316", "--resume", "x"}, ProgramClaude},
		{"claude native, run as claude", "/home/u/.local/share/claude/versions/2.1.317", []string{"claude"}, ProgramClaude},
		{"claude from npm", "/usr/bin/node", []string{"node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"}, ProgramClaude},
		{"a script named claude", "/usr/bin/bash", []string{"bash", "/tmp/x/claude"}, ProgramClaude},
		{"codex native", "/home/u/.codex/packages/standalone/releases/0.166.0/bin/codex", []string{"codex"}, ProgramCodex},
		{"codex from npm", "/usr/bin/node", []string{"node", "/usr/lib/node_modules/@openai/codex/bin/codex.js"}, ProgramCodex},
		{"a script named codex via env", "/usr/bin/env", []string{"/usr/bin/env", "/tmp/x/codex"}, ProgramCodex},
		{"vim editing claude.md", "/usr/bin/vim", []string{"vim", "claude.md"}, ProgramOther},
		{"less reading a file named codex", "/usr/bin/less", []string{"less", "/tmp/codex"}, ProgramOther},
		{"python running something else", "/usr/bin/python3", []string{"python3", "app.py"}, ProgramOther},
		{"unreadable", "", nil, ProgramOther},
	}
	for _, c := range cases {
		if got := classifyProgram(c.exe, c.argv); got != c.want {
			t.Errorf("%s: classifyProgram(%q, %q) = %q, want %q", c.name, c.exe, c.argv, got, c.want)
		}
	}
}
