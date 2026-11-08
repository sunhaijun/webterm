// Package setup checks and adds the settings claude and codex need for
// webterm's "waiting for you" (ADR-0055; the shell item went with the history
// list, ADR-0058 §4).
//
// Every edit is a minimal text insertion: the rest of each file keeps its
// bytes, order and comments. Nothing here runs unless the user asks for it
// (`webterm setup`, or yes to the installer's question).
package setup

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// State is what an item needs.
type State int

const (
	// OK: already set.
	OK State = iota
	// Add: missing; Apply adds it.
	Add
	// Kept: the user chose another value, which stays.
	Kept
	// Skipped: the program isn't installed.
	Skipped
	// Broken: the file doesn't parse; it's left alone.
	Broken
)

func (s State) String() string {
	switch s {
	case OK:
		return "ok"
	case Add:
		return "add"
	case Kept:
		return "left as is"
	case Skipped:
		return "skipped"
	}
	return "can't read"
}

// Item names, in the order Plan returns them.
const (
	ItemClaude = "claude notifications"
	ItemCodex  = "codex notifications"
)

// Item is one setting: where it lives, what it needs, and (for Add) the new
// file content.
type Item struct {
	Name   string
	File   string // as shown, ~/…
	State  State
	Detail string
	// Backup is where Apply copied the old file, if it did.
	Backup string

	path    string
	exists  bool
	orig    []byte
	content []byte
	mode    fs.FileMode
}

// Plan checks the items under home.
func Plan(home string) []Item {
	return []Item{
		planFile(home, ItemClaude, ".claude", filepath.Join(".claude", "settings.json"), 0o644, "claude isn't installed (no ~/.claude)",
			func(in []byte, exists bool) ([]byte, State, string) { return claudeSettings(in, exists) }),
		planFile(home, ItemCodex, ".codex", filepath.Join(".codex", "config.toml"), 0o600, "codex isn't installed (no ~/.codex)",
			func(in []byte, exists bool) ([]byte, State, string) { return codexConfig(in, exists) }),
	}
}

// planFile reads home/rel and asks edit what it needs. With needDir set, a
// missing home/needDir means the program isn't installed.
func planFile(home, name, needDir, rel string, newMode fs.FileMode, missing string, edit func([]byte, bool) ([]byte, State, string)) Item {
	it := Item{Name: name, File: "~/" + filepath.ToSlash(rel), path: filepath.Join(home, rel), mode: newMode}
	if needDir != "" {
		if fi, err := os.Stat(filepath.Join(home, needDir)); err != nil || !fi.IsDir() {
			it.State, it.Detail = Skipped, missing
			return it
		}
	}
	data, err := os.ReadFile(it.path)
	switch {
	case err == nil:
		it.exists = true
		it.orig = data
		if fi, err := os.Stat(it.path); err == nil {
			it.mode = fi.Mode().Perm()
		}
	case !errors.Is(err, fs.ErrNotExist):
		it.State, it.Detail = Broken, err.Error()
		return it
	}
	it.content, it.State, it.Detail = edit(it.orig, it.exists)
	return it
}

// Apply writes every Add item: the old file is copied to <file>.webterm-bak
// (or .webterm-bak-<time> when that exists) and the new content replaces it
// atomically, keeping its mode. A symlinked file is written through to its
// target. A file that changed since Plan read it is left alone.
func Apply(items []Item, now time.Time) error {
	var errs []error
	for i := range items {
		it := &items[i]
		if it.State != Add {
			continue
		}
		if err := apply(it, now); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", it.File, err))
		}
	}
	return errors.Join(errs...)
}

func apply(it *Item, now time.Time) error {
	target := it.path
	if fi, err := os.Lstat(target); err == nil && fi.Mode()&fs.ModeSymlink != 0 {
		resolved, err := filepath.EvalSymlinks(target)
		if err != nil {
			return err
		}
		target = resolved
	}
	if it.exists {
		cur, err := os.ReadFile(target)
		if err != nil {
			return err
		}
		if !bytes.Equal(cur, it.orig) {
			return errors.New("changed since it was checked; run webterm setup again")
		}
		bak := target + ".webterm-bak"
		if _, err := os.Lstat(bak); err == nil {
			bak = target + ".webterm-bak-" + now.Format("20060102-150405")
		}
		if err := os.WriteFile(bak, it.orig, it.mode); err != nil {
			return err
		}
		it.Backup = bak
	} else if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(target), ".webterm-setup-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(it.content); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(it.mode); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), target)
}

// ---------- claude ----------

const (
	claudeKey   = "preferredNotifChannel"
	claudeValue = "terminal_bell"
)

var claudeAuto = regexp.MustCompile(`("preferredNotifChannel"\s*:\s*)"auto"`)

// claudeSettings adds "preferredNotifChannel": "terminal_bell" to
// ~/.claude/settings.json, replacing "auto"; any other value is the user's.
func claudeSettings(in []byte, exists bool) ([]byte, State, string) {
	addDetail := fmt.Sprintf("add %q: %q", claudeKey, claudeValue)
	line := fmt.Sprintf("%q: %q", claudeKey, claudeValue)
	if !exists || len(bytes.TrimSpace(in)) == 0 {
		return []byte("{\n  " + line + "\n}\n"), Add, addDetail
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(in, &m); err != nil {
		return nil, Broken, "doesn't parse as a JSON object, so it's left alone: " + err.Error()
	}
	var out []byte
	if raw, ok := m[claudeKey]; ok {
		var v string
		if json.Unmarshal(raw, &v) != nil {
			return nil, Kept, fmt.Sprintf("%s is set to %s", claudeKey, raw)
		}
		switch v {
		case claudeValue:
			return nil, OK, "claude rings the bell for its notifications"
		case "auto":
			out = claudeAuto.ReplaceAll(in, []byte(`${1}"`+claudeValue+`"`))
			addDetail = fmt.Sprintf("change %q from %q to %q", claudeKey, "auto", claudeValue)
		default:
			return nil, Kept, fmt.Sprintf("%s is %q, which you chose", claudeKey, v)
		}
	} else {
		i := bytes.IndexByte(in, '{')
		after := in[i+1:]
		rest := bytes.TrimLeft(after, " \t\r\n")
		ws := after[:len(after)-len(rest)]
		switch {
		case len(rest) > 0 && rest[0] == '}':
			out = concat(in[:i], []byte("{\n  "+line+"\n"), rest)
		case bytes.ContainsRune(ws, '\n'):
			indent := ws[bytes.LastIndexByte(ws, '\n')+1:]
			out = concat(in[:i+1], []byte("\n"), indent, []byte(line+","), after)
		default:
			out = concat(in[:i+1], []byte(line+", "), after)
		}
	}
	var check map[string]any
	if json.Unmarshal(out, &check) != nil || check[claudeKey] != claudeValue {
		return nil, Broken, "couldn't add the line safely, so it's left alone"
	}
	return out, Add, addDetail
}

func concat(parts ...[]byte) []byte {
	var b bytes.Buffer
	for _, p := range parts {
		b.Write(p)
	}
	return b.Bytes()
}

// ---------- codex ----------

var (
	tomlHeader  = regexp.MustCompile(`^\s*\[`)
	tuiHeader   = regexp.MustCompile(`^\s*\[tui\]\s*(#.*)?$`)
	tuiInline   = regexp.MustCompile(`^\s*tui\s*=`)
	tuiDotted   = regexp.MustCompile(`^\s*tui\.(notifications|notification_condition)\s*=\s*(.*)$`)
	tuiKey      = regexp.MustCompile(`^\s*(notifications|notification_condition)\s*=\s*(.*)$`)
	codexWanted = []struct{ key, line string }{
		{"notifications", "notifications = true"},
		{"notification_condition", `notification_condition = "always"`},
	}
)

// codexConfig adds the missing ones of notifications = true and
// notification_condition = "always" under [tui] in ~/.codex/config.toml.
func codexConfig(in []byte, _ bool) ([]byte, State, string) {
	text := string(in)
	lines := strings.SplitAfter(text, "\n")
	have := map[string]string{}
	tuiLine, dotted := -1, false
	inRoot, inTui := true, false
	for i, raw := range lines {
		l := strings.TrimRight(raw, "\r\n")
		if tomlHeader.MatchString(l) {
			inRoot = false
			inTui = tuiHeader.MatchString(l)
			if inTui && tuiLine < 0 {
				tuiLine = i
			}
			continue
		}
		switch {
		case inRoot && tuiInline.MatchString(l):
			return nil, Kept, "tui is an inline table; add notifications to it yourself"
		case inRoot:
			if m := tuiDotted.FindStringSubmatch(l); m != nil {
				have[m[1]], dotted = m[2], true
			}
		case inTui:
			if m := tuiKey.FindStringSubmatch(l); m != nil {
				have[m[1]] = m[2]
			}
		}
	}
	if v, ok := have["notifications"]; ok && tomlValue(v) == "false" {
		return nil, Kept, "notifications = false, which you chose"
	}
	var add []string
	for _, w := range codexWanted {
		if _, ok := have[w.key]; !ok {
			add = append(add, w.line)
		}
	}
	if len(add) == 0 {
		return nil, OK, "codex sends its notifications"
	}
	detail := "add " + strings.Join(add, ", ") + " under [tui]"
	block := strings.Join(add, "\n") + "\n"
	switch {
	case tuiLine >= 0:
		if !strings.HasSuffix(lines[tuiLine], "\n") {
			lines[tuiLine] += "\n"
		}
		lines[tuiLine] += block
		return []byte(strings.Join(lines, "")), Add, detail
	case dotted:
		// Root keys come before any table header, so the top of the file is safe.
		var b strings.Builder
		for _, l := range add {
			b.WriteString("tui." + l + "\n")
		}
		return []byte(b.String() + text), Add, detail
	}
	var b strings.Builder
	b.WriteString(text)
	if text != "" {
		if !strings.HasSuffix(text, "\n") {
			b.WriteString("\n")
		}
		b.WriteString("\n")
	}
	b.WriteString("[tui]\n" + block)
	return []byte(b.String()), Add, detail
}

// tomlValue strips a trailing comment and spaces from a simple value.
func tomlValue(v string) string {
	if i := strings.IndexByte(v, '#'); i >= 0 {
		v = v[:i]
	}
	return strings.TrimSpace(v)
}
