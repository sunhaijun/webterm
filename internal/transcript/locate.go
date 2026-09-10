package transcript

import (
	"bufio"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Roots 是两个 CLI 的会话文件根目录。
type Roots struct {
	Claude string // ~/.claude/projects
	Codex  string // ~/.codex/sessions
}

// DefaultRoots 按 home 推出默认根目录。
func DefaultRoots(home string) Roots {
	return Roots{
		Claude: filepath.Join(home, ".claude", "projects"),
		Codex:  filepath.Join(home, ".codex", "sessions"),
	}
}

// claudeSlug 是 Claude Code 给项目目录起的名：cwd 里非字母数字全换成 -。
// 例：/home/sun/github/qqu/.claude/worktrees/x → -home-sun-github-qqu--claude-worktrees-x
func claudeSlug(cwd string) string {
	var b strings.Builder
	for _, r := range cwd {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		} else {
			b.WriteByte('-')
		}
	}
	return b.String()
}

type candidate struct {
	path  string
	mtime time.Time
	match bool // cwd 对得上
}

// pickNewest 在候选里选：cwd 对得上的优先，其次最新。
func pickNewest(cands []candidate) string {
	best := -1
	for i, c := range cands {
		if best < 0 {
			best = i
			continue
		}
		b := cands[best]
		if c.match != b.match {
			if c.match {
				best = i
			}
			continue
		}
		if c.mtime.After(b.mtime) {
			best = i
		}
	}
	if best < 0 {
		return ""
	}
	return cands[best].path
}

// locateClaude 找命令开始之后被写过的会话文件：<root>/<slug>/<id>.jsonl。
// 用户可能在别处同时开着别的 claude，所以 cwd 目录对得上的优先。
func locateClaude(root, cwd string, since time.Time) string {
	dirs, err := os.ReadDir(root)
	if err != nil {
		return ""
	}
	slug := claudeSlug(cwd)
	var cands []candidate
	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}
		files, err := os.ReadDir(filepath.Join(root, d.Name()))
		if err != nil {
			continue
		}
		for _, f := range files {
			if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
				continue
			}
			info, err := f.Info()
			if err != nil || info.ModTime().Before(since) {
				continue
			}
			cands = append(cands, candidate{path: filepath.Join(root, d.Name(), f.Name()), mtime: info.ModTime(), match: d.Name() == slug})
		}
	}
	return pickNewest(cands)
}

// locateCodex 找命令开始之后被写过的 rollout-*.jsonl；首行 session_meta.cwd 对得上的优先。
func locateCodex(root, cwd string, since time.Time) string {
	var cands []candidate
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		name := d.Name()
		if !strings.HasPrefix(name, "rollout-") || !strings.HasSuffix(name, ".jsonl") {
			return nil
		}
		info, err := d.Info()
		if err != nil || info.ModTime().Before(since) {
			return nil
		}
		cands = append(cands, candidate{path: p, mtime: info.ModTime(), match: firstLineCWD(p) == cwd})
		return nil
	})
	return pickNewest(cands)
}

func firstLineCWD(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	if sc.Scan() {
		return codexMetaCWD(sc.Bytes())
	}
	return ""
}
