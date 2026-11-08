// Package history lists what a program was sent recently, newest first, read
// on request from that program's own history file (ADR-0057 §1,
// docs/30-protocol/http-api.md#history).
//
// Nothing here is stored or logged: the files belong to claude, codex and the
// shell, and webterm keeps no history of its own (privacy-history.md).
package history

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	// MaxItems is how many entries Items returns at most.
	MaxItems = 30
	// MaxEntryBytes skips anything longer: a pasted log is not something to resend.
	MaxEntryBytes = 32 << 10
	// tailBytes is how much of the end of a history file is read.
	tailBytes = 1 << 20
)

// placeholder matches what claude writes in place of pasted text and images;
// sending it back would send the placeholder, not the content.
var placeholder = regexp.MustCompile(`\[(Pasted text|Image) #\d+`)

// Items returns at most MaxItems entries for program ("claude", "codex",
// "shell"), newest first, each distinct entry once at its newest position.
// home is the user's home directory and shell the session shell (a path or a
// name). A missing or unreadable file, or another program, gives none.
func Items(program, home, shell string) []string {
	var entries []string
	switch program {
	case "claude":
		entries = jsonField(filepath.Join(home, ".claude", "history.jsonl"), "display")
	case "codex":
		entries = jsonField(filepath.Join(home, ".codex", "history.jsonl"), "text")
	case "shell":
		switch filepath.Base(shell) {
		case "bash":
			entries = bashHistory(filepath.Join(home, ".bash_history"))
		case "zsh":
			entries = zshHistory(filepath.Join(home, ".zsh_history"))
		}
	}
	return newest(entries)
}

// newest walks from the end: blank, oversized and placeholder entries are
// skipped, repeats keep only their newest position.
func newest(entries []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for i := len(entries) - 1; i >= 0 && len(out) < MaxItems; i-- {
		e := strings.TrimSpace(entries[i])
		if e == "" || len(e) > MaxEntryBytes || placeholder.MatchString(e) || seen[e] {
			continue
		}
		seen[e] = true
		out = append(out, e)
	}
	return out
}

// tailLines returns the complete lines in the last tailBytes of path. When the
// read starts mid-file, the first (partial) line is dropped.
func tailLines(path string) []string {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() {
		return nil
	}
	start := max(fi.Size()-tailBytes, 0)
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return nil
	}
	data, err := io.ReadAll(io.LimitReader(f, tailBytes))
	if err != nil {
		return nil
	}
	if start > 0 {
		if i := bytes.IndexByte(data, '\n'); i >= 0 {
			data = data[i+1:]
		} else {
			return nil
		}
	}
	var lines []string
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 0, 64<<10), tailBytes)
	for sc.Scan() {
		lines = append(lines, sc.Text())
	}
	return lines
}

// jsonField reads one string field from each JSON line; other lines are skipped.
func jsonField(path, field string) []string {
	var out []string
	for _, l := range tailLines(path) {
		var m map[string]json.RawMessage
		if json.Unmarshal([]byte(l), &m) != nil {
			continue
		}
		var s string
		if raw, ok := m[field]; ok && json.Unmarshal(raw, &s) == nil {
			out = append(out, s)
		}
	}
	return out
}

var bashStamp = regexp.MustCompile(`^#\d+$`)

// bashHistory reads ~/.bash_history; with HISTTIMEFORMAT set, bash writes
// "#<epoch>" lines before entries.
func bashHistory(path string) []string {
	var out []string
	for _, l := range tailLines(path) {
		if !bashStamp.MatchString(l) {
			out = append(out, l)
		}
	}
	return out
}

var zshPrefix = regexp.MustCompile(`^: \d+:\d+;`)

// zshHistory reads ~/.zsh_history, removing EXTENDED_HISTORY's ": <time>:<n>;"
// prefix.
func zshHistory(path string) []string {
	var out []string
	for _, l := range tailLines(path) {
		out = append(out, zshPrefix.ReplaceAllString(l, ""))
	}
	return out
}
