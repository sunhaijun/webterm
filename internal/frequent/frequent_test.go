package frequent

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// UT-frequent-1 (AC-3.24, ADR-0054 §3): the ten single-line inputs sent most
// often, from each program's own history file.

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
		fmt.Fprintf(&b, `{%q:%q,"project":"/p","timestamp":%d}`+"\n", field, e, 1000+i)
	}
	return b.String()
}

func TestClaude(t *testing.T) {
	home := t.TempDir()
	write(t, filepath.Join(home, ".claude", "history.jsonl"), jsonl("display",
		"/clear", "继续", "/clear", "fix the bug\nand add a test", "继续", "/clear", "/clear",
		"[Pasted text #1 +20 lines] explain", "[Image #1] what is this", "  继续  ",
		strings.Repeat("长", 81), "/compact",
	)+"not json\n")
	got := Items("claude", home, "bash")
	want := []string{"/clear", "继续", "/compact"}
	if !slices.Equal(got, want) {
		t.Fatalf("Items = %q, want %q", got, want)
	}
}

func TestCodex(t *testing.T) {
	home := t.TempDir()
	write(t, filepath.Join(home, ".codex", "history.jsonl"), jsonl("text", "ok", "run tests", "ok", ""))
	if got, want := Items("codex", home, "bash"), []string{"ok", "run tests"}; !slices.Equal(got, want) {
		t.Fatalf("Items = %q, want %q", got, want)
	}
}

func TestBash(t *testing.T) {
	home := t.TempDir()
	write(t, filepath.Join(home, ".bash_history"),
		"#1700000000\ngit status\nls\ngit status\n#1700000001\nmake test\ncd ..\ngit status\nmake test\n")
	got := Items("shell", home, "/bin/bash")
	want := []string{"git status", "make test", "cd .."}
	if !slices.Equal(got, want) {
		t.Fatalf("Items = %q, want %q (ls is shorter than 3 characters; # lines are timestamps)", got, want)
	}
}

func TestZsh(t *testing.T) {
	home := t.TempDir()
	write(t, filepath.Join(home, ".zsh_history"), ": 1700000000:0;git pull\n: 1700000001:0;npm test\n: 1700000002:0;git pull\nplain line\n")
	// npm test and plain line tie at one each: the more recent comes first
	if got, want := Items("shell", home, "zsh"), []string{"git pull", "plain line", "npm test"}; !slices.Equal(got, want) {
		t.Fatalf("Items = %q, want %q", got, want)
	}
}

func TestTiesGoToTheMostRecent(t *testing.T) {
	home := t.TempDir()
	write(t, filepath.Join(home, ".claude", "history.jsonl"), jsonl("display", "aaa", "bbb", "ccc"))
	if got, want := Items("claude", home, "bash"), []string{"ccc", "bbb", "aaa"}; !slices.Equal(got, want) {
		t.Fatalf("Items = %q, want %q", got, want)
	}
}

func TestAtMostTenFromTheLast1000(t *testing.T) {
	home := t.TempDir()
	var entries []string
	for range 50 {
		entries = append(entries, "old favourite") // pushed out of the window below
	}
	for i := range 1000 {
		entries = append(entries, fmt.Sprintf("cmd-%02d", i%20))
	}
	write(t, filepath.Join(home, ".claude", "history.jsonl"), jsonl("display", entries...))
	got := Items("claude", home, "bash")
	if len(got) != 10 {
		t.Fatalf("%d items, want 10: %q", len(got), got)
	}
	if slices.Contains(got, "old favourite") {
		t.Fatal("an entry older than the last 1000 was counted")
	}
}

func TestReadsOnlyTheTail(t *testing.T) {
	home := t.TempDir()
	// 2 MiB of one entry, then a few of another: only the last MiB is read, and a
	// cut first line is skipped rather than parsed half.
	big := strings.Repeat(`{"display":"ancient"}`+"\n", (2<<20)/22)
	write(t, filepath.Join(home, ".claude", "history.jsonl"), big+jsonl("display", "recent", "recent"))
	if got, want := Items("claude", home, "bash"), []string{"ancient", "recent"}; !slices.Equal(got, want) {
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
	write(t, filepath.Join(home, ".config", "fish", "x"), "")
	if got := Items("shell", home, "fish"); len(got) != 0 {
		t.Errorf("unsupported shell gave %q", got)
	}
}
