package history

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// UT-history-1 (AC-3.24, ADR-0057 §1): what you sent recently, newest first,
// each distinct entry once, at most 30, multi-line entries kept.

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func jsonl(field string, entries ...string) string {
	var b strings.Builder
	for i, e := range entries {
		fmt.Fprintf(&b, `{%q:%q,"timestamp":%d}`+"\n", field, e, 1000+i)
	}
	return b.String()
}

func TestClaudeNewestFirstDistinct(t *testing.T) {
	home := t.TempDir()
	write(t, filepath.Join(home, ".claude", "history.jsonl"), jsonl("display",
		"/clear", "继续", "fix the bug\nand add a test", "[Pasted text #1 +20 lines] explain", "  ", "继续", "[Image #1] what is this",
	)+"not json\n")
	got := Items("claude", home, "bash")
	want := []string{"继续", "fix the bug\nand add a test", "/clear"}
	if !slices.Equal(got, want) {
		t.Fatalf("Items = %q, want %q", got, want)
	}
}

func TestCodex(t *testing.T) {
	home := t.TempDir()
	write(t, filepath.Join(home, ".codex", "history.jsonl"), jsonl("text", "run tests", "ok", "run tests"))
	if got, want := Items("codex", home, "bash"), []string{"run tests", "ok"}; !slices.Equal(got, want) {
		t.Fatalf("Items = %q, want %q", got, want)
	}
}

func TestBashAndZsh(t *testing.T) {
	home := t.TempDir()
	write(t, filepath.Join(home, ".bash_history"), "#1700000000\ngit status\nls\nmake test\ngit status\n")
	if got, want := Items("shell", home, "/bin/bash"), []string{"git status", "make test", "ls"}; !slices.Equal(got, want) {
		t.Fatalf("bash: %q, want %q (newest first; # lines are timestamps; short ones count now)", got, want)
	}
	write(t, filepath.Join(home, ".zsh_history"), ": 1700000000:0;git pull\n: 1700000001:0;npm test\n")
	if got, want := Items("shell", home, "zsh"), []string{"npm test", "git pull"}; !slices.Equal(got, want) {
		t.Fatalf("zsh: %q, want %q", got, want)
	}
}

func TestAtMost30(t *testing.T) {
	home := t.TempDir()
	var entries []string
	for i := range 50 {
		entries = append(entries, fmt.Sprintf("prompt %02d", i))
	}
	write(t, filepath.Join(home, ".claude", "history.jsonl"), jsonl("display", entries...))
	got := Items("claude", home, "bash")
	if len(got) != MaxItems || MaxItems != 30 || got[0] != "prompt 49" || got[29] != "prompt 20" {
		t.Fatalf("Items = %d entries, first %q, last %q", len(got), got[0], got[len(got)-1])
	}
}

func TestSkipsHugeEntries(t *testing.T) {
	home := t.TempDir()
	write(t, filepath.Join(home, ".claude", "history.jsonl"), jsonl("display", "small", strings.Repeat("x", MaxEntryBytes+1)))
	if got := Items("claude", home, "bash"); !slices.Equal(got, []string{"small"}) {
		t.Fatalf("Items = %d entries, want only the small one", len(got))
	}
}

func TestReadsOnlyTheTail(t *testing.T) {
	home := t.TempDir()
	big := strings.Repeat(`{"display":"ancient"}`+"\n", (2<<20)/22)
	write(t, filepath.Join(home, ".claude", "history.jsonl"), big+jsonl("display", "recent"))
	if got, want := Items("claude", home, "bash"), []string{"recent", "ancient"}; !slices.Equal(got, want) {
		t.Fatalf("Items = %q, want %q", got, want)
	}
}

func TestMissingOrOther(t *testing.T) {
	home := t.TempDir()
	for _, p := range []string{"claude", "codex", "shell", "other", ""} {
		if got := Items(p, home, "bash"); len(got) != 0 {
			t.Errorf("Items(%q) with no files = %q, want empty", p, got)
		}
	}
	if got := Items("shell", home, "fish"); len(got) != 0 {
		t.Errorf("unsupported shell gave %q", got)
	}
}
