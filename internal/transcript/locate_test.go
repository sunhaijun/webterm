package transcript

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func touch(t *testing.T, p string, mtime time.Time, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(p, mtime, mtime); err != nil {
		t.Fatal(err)
	}
}

// UT-transcript-4：定位会话文件 —— 命令开始之后写过的才算，cwd 对得上的优先，其次最新。
func TestLocate(t *testing.T) {
	if got := claudeSlug("/home/sun/github/qqu/.claude/worktrees/x"); got != "-home-sun-github-qqu--claude-worktrees-x" {
		t.Fatalf("slug = %q", got)
	}
	root := t.TempDir()
	since := time.Now().Add(-time.Minute)
	old := since.Add(-time.Hour)
	// 旧文件（命令开始前）不算；别的 cwd 的新文件次之；本 cwd 的新文件优先
	touch(t, filepath.Join(root, "-home-sun", "old.jsonl"), old, "{}\n")
	touch(t, filepath.Join(root, "-home-other", "other.jsonl"), since.Add(30*time.Second), "{}\n")
	if got := locateClaude(root, "/home/sun", since); got != filepath.Join(root, "-home-other", "other.jsonl") {
		t.Fatalf("没有本 cwd 的文件时取最新的别处文件，得 %q", got)
	}
	touch(t, filepath.Join(root, "-home-sun", "mine.jsonl"), since.Add(10*time.Second), "{}\n")
	if got := locateClaude(root, "/home/sun", since); got != filepath.Join(root, "-home-sun", "mine.jsonl") {
		t.Fatalf("本 cwd 的文件优先（哪怕更旧），得 %q", got)
	}
	if got := locateClaude(filepath.Join(root, "nope"), "/home/sun", since); got != "" {
		t.Fatalf("根目录不存在 → 空，得 %q", got)
	}

	croot := t.TempDir()
	meta := func(cwd string) string { return `{"type":"session_meta","payload":{"cwd":"` + cwd + `"}}` + "\n" }
	touch(t, filepath.Join(croot, "2026", "09", "09", "rollout-a.jsonl"), since.Add(40*time.Second), meta("/elsewhere"))
	touch(t, filepath.Join(croot, "2026", "09", "09", "rollout-b.jsonl"), since.Add(20*time.Second), meta("/home/sun"))
	touch(t, filepath.Join(croot, "2026", "09", "08", "rollout-old.jsonl"), old, meta("/home/sun"))
	if got := locateCodex(croot, "/home/sun", since); got != filepath.Join(croot, "2026", "09", "09", "rollout-b.jsonl") {
		t.Fatalf("codex：cwd 对得上的优先，得 %q", got)
	}
}
