package transcript

import "testing"

// UT-transcript-1：程序名与来源判定要和前端 keymap.ts 的 programOf 一致。
func TestProgramOf(t *testing.T) {
	cases := map[string]string{
		"claude":                                     "claude",
		"claude --model sonnet":                      "claude",
		"cd ~/p && codex --full-auto":                "codex",
		"FOO=1 sudo -E /usr/local/bin/claude -c":     "claude",
		"claude() { printf 'x'; sleep 30; }; claude": "claude",
		"ls | less":                                  "less",
		"":                                           "",
		"   ":                                        "",
	}
	for in, want := range cases {
		if got := ProgramOf(in); got != want {
			t.Errorf("ProgramOf(%q) = %q, want %q", in, got, want)
		}
	}
	if SourceFor("claude") != "claude" || SourceFor("codex") != "codex" || SourceFor("vim") != "" {
		t.Fatal("SourceFor 只认 claude / codex")
	}
}
