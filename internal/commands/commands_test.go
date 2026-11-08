package commands

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func write(t *testing.T, path, content string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil {
		t.Fatal(err)
	}
}

func ids(items []Item) []string {
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = it.ID
	}
	return out
}

func byID(items []Item, id string) (Item, bool) {
	for _, it := range items {
		if it.ID == id {
			return it, true
		}
	}
	return Item{}, false
}

const initLine = `{"type":"system","subtype":"init","claude_code_version":"9.9.9","slash_commands":["deep-research","clear","compact","model","__remote-workflow","hello"],"skills":["deep-research"]}`

// fakeClaude writes a script that prints an init line when run with -p (and
// records its arguments), else sleeps. It stands in for claude's executable.
// uiLine is what claude 2.1.319 prints before its init message.
const uiLine = `{"type":"system","subtype":"ui_invalidate","event":"ui.render"}`

func fakeClaude(t *testing.T, dir string, lines ...string) string {
	t.Helper()
	path := filepath.Join(dir, "claude")
	log := filepath.Join(dir, "args.log")
	script := "#!/bin/bash\nprintf '%s\\n' \"$*\" >> " + log + "\n"
	for _, l := range lines {
		script += "echo '" + l + "'\n"
	}
	write(t, path, script+"sleep 30\n", 0o755)
	return path
}

// UT-catalog-claude (AC-3.25, ADR-0057 §4): keys first (rebinds followed),
// built-ins from the init line without skills or __ names, /copy and /resume,
// custom commands from both directories, skills hidden by default.
func TestClaudeCatalog(t *testing.T) {
	home, cwd, bin := t.TempDir(), t.TempDir(), t.TempDir()
	write(t, filepath.Join(home, ".claude", "commands", "hello.md"), "say hi\n", 0o644)        // also reported by init: once
	write(t, filepath.Join(home, ".claude", "commands", "git", "ship.md"), "ship it\n", 0o644) // nested
	write(t, filepath.Join(cwd, ".claude", "commands", "deploy.md"), "deploy\n", 0o644)
	write(t, filepath.Join(home, ".claude", "keybindings.json"),
		`{"bindings":[{"context":"Global","bindings":{"ctrl+y":"app:toggleTranscript","ctrl+o":null}}]}`, 0o644)
	exe := fakeClaude(t, bin, uiLine, initLine) // other system messages may come first

	p := NewProber(t.TempDir())
	items, warning := Catalog(context.Background(), Input{Program: "claude", Home: home, Cwd: cwd, Command: []string{exe}}, p)
	if warning != "" {
		t.Fatalf("warning = %q", warning)
	}
	got := ids(items)
	keys := 0
	for _, id := range got {
		if strings.HasPrefix(id, "key:") {
			keys++
		}
	}
	if keys == 0 || !strings.HasPrefix(got[0], "key:") {
		t.Fatalf("keys should come first: %v", got)
	}
	for _, want := range []string{"/clear", "/compact", "/model", "/hello", "/copy", "/resume", "/ship", "/deploy", "/deep-research"} {
		if !slices.Contains(got, want) {
			t.Errorf("missing %s in %v", want, got)
		}
	}
	if slices.Contains(got, "/__remote-workflow") {
		t.Error("an internal __ command is listed")
	}
	if n := strings.Count(strings.Join(got, " "), "/hello "); n > 1 {
		t.Errorf("/hello listed %d times", n)
	}
	if it, _ := byID(items, "/deep-research"); !it.Hidden || it.Origin != OriginSkill {
		t.Errorf("a skill should start hidden: %+v", it)
	}
	if it, _ := byID(items, "/deploy"); it.Origin != OriginCustom || it.Hidden || !it.Enter || it.Kind != KindText || !slices.Equal(it.Send, []string{"/deploy"}) {
		t.Errorf("custom command: %+v", it)
	}
	if it, _ := byID(items, "key:ctrl-o"); !slices.Equal(it.Send, []string{"\x19"}) {
		t.Errorf("transcript was rebound to ctrl+y: %+v", it)
	}
	if it, _ := byID(items, "key:shift-tab"); !slices.Equal(it.Send, []string{"\x1b[Z"}) {
		t.Errorf("shift-tab: %+v", it)
	}
	if it, _ := byID(items, "key:esc-esc"); !slices.Equal(it.Send, []string{"\x1b", "\x1b"}) {
		t.Errorf("esc esc: %+v", it)
	}

	// The probe ran once, with the safe flags; a second catalog uses the cache
	args, _ := os.ReadFile(filepath.Join(bin, "args.log"))
	for _, f := range []string{"-p", "--bare", "--strict-mcp-config", "--no-session-persistence", "--output-format stream-json", "--verbose"} {
		if !strings.Contains(string(args), f) {
			t.Errorf("probe args %q lack %s", args, f)
		}
	}
	Catalog(context.Background(), Input{Program: "claude", Home: home, Cwd: cwd, Command: []string{exe}}, p)
	if again, _ := os.ReadFile(filepath.Join(bin, "args.log")); strings.Count(string(again), "\n") != 1 {
		t.Errorf("the cached probe ran again:\n%s", again)
	}
	// refresh asks again
	p.Forget()
	Catalog(context.Background(), Input{Program: "claude", Home: home, Cwd: cwd, Command: []string{exe}}, p)
	if again, _ := os.ReadFile(filepath.Join(bin, "args.log")); strings.Count(string(again), "\n") != 2 {
		t.Errorf("Forget didn't make it probe again:\n%s", again)
	}
}

// The probe is stopped as soon as the init line is in: the fake sleeps 30 s.
func TestProbeDoesNotWait(t *testing.T) {
	exe := fakeClaude(t, t.TempDir(), initLine)
	start := time.Now()
	r, err := NewProber(t.TempDir()).Get(context.Background(), []string{exe})
	if err != nil {
		t.Fatal(err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatalf("probe took %v", time.Since(start))
	}
	if !slices.Contains(r.Commands, "compact") || !slices.Equal(r.Skills, []string{"deep-research"}) {
		t.Fatalf("probe = %+v", r)
	}
}

// A probe that fails still gives a list (keys, supplement, custom) and says why.
func TestProbeFailureKeepsTheRest(t *testing.T) {
	bin := t.TempDir()
	exe := filepath.Join(bin, "claude")
	// Lines but no init message before the reply starts: give up there, don't wait for the timeout
	write(t, exe, "#!/bin/bash\necho 'not json'\necho '"+uiLine+"'\necho '{\"type\":\"assistant\"}'\nsleep 30\n", 0o755)
	start := time.Now()
	items, warning := Catalog(context.Background(), Input{Program: "claude", Home: t.TempDir(), Cwd: t.TempDir(), Command: []string{exe}}, NewProber(t.TempDir()))
	if warning == "" {
		t.Fatal("no warning for a failed probe")
	}
	if time.Since(start) > 3*time.Second {
		t.Errorf("waited %v for an init message that was never coming", time.Since(start))
	}
	got := ids(items)
	if !slices.Contains(got, "key:shift-tab") || !slices.Contains(got, "/copy") {
		t.Fatalf("items = %v", got)
	}
}

// UT-catalog-codex (AC-3.25, ADR-0057 §4): webterm's list plus custom prompts.
func TestCodexCatalog(t *testing.T) {
	home := t.TempDir()
	write(t, filepath.Join(home, ".codex", "prompts", "draftpr.md"), "Draft a PR\n", 0o644)
	items, warning := Catalog(context.Background(), Input{Program: "codex", Home: home, Cwd: t.TempDir()}, nil)
	if warning != "" {
		t.Fatalf("warning = %q", warning)
	}
	got := ids(items)
	for _, want := range []string{"key:esc-esc", "/model", "/review", "/compact", "/prompts:draftpr"} {
		if !slices.Contains(got, want) {
			t.Errorf("missing %s in %v", want, got)
		}
	}
	if items, _ := Catalog(context.Background(), Input{Program: "shell"}, nil); len(items) != 0 {
		t.Errorf("shell has no command strip: %v", ids(items))
	}
}

// UT-arrange-1 (AC-3.25, ADR-0057 §5): your order first, the rest after it in
// the source's order; visibility overrides; edits; added items.
func TestArrange(t *testing.T) {
	catalog := []Item{
		{ID: "key:a", Label: "A", Kind: KindKeys, Send: []string{"a"}, Origin: OriginKey},
		{ID: "/b", Label: "/b", Kind: KindText, Send: []string{"/b"}, Enter: true, Origin: OriginBuiltin},
		{ID: "/c", Label: "/c", Kind: KindText, Send: []string{"/c"}, Enter: true, Origin: OriginBuiltin},
		{ID: "/s", Label: "/s", Kind: KindText, Send: []string{"/s"}, Enter: true, Origin: OriginSkill, Hidden: true},
		{ID: "/new", Label: "/new", Kind: KindText, Send: []string{"/new"}, Enter: true, Origin: OriginBuiltin},
	}
	no, yes := false, true
	label := "清空"
	arr := Arrangement{
		Order:   []string{"/c", "add:1", "key:a", "/gone"},
		Visible: map[string]bool{"/s": true, "/b": false},
		Edits:   map[string]Edit{"/c": {Label: &label, Enter: &no}, "key:a": {Label: &label, Send: strPtr("ignored for keys")}},
		Added:   []Added{{ID: "add:1", Label: "继续", Send: "继续", Enter: true}},
	}
	got := Arrange(catalog, arr)
	if want := []string{"/c", "add:1", "key:a", "/b", "/s", "/new"}; !slices.Equal(ids(got), want) {
		t.Fatalf("order = %v, want %v (a new /new goes last; /gone is dropped)", ids(got), want)
	}
	c, _ := byID(got, "/c")
	if c.Label != "清空" || c.Enter || !slices.Equal(c.Send, []string{"/c"}) {
		t.Errorf("/c = %+v", c)
	}
	if a, _ := byID(got, "key:a"); a.Label != "清空" || !slices.Equal(a.Send, []string{"a"}) {
		t.Errorf("a key's label can change, its bytes can't: %+v", a)
	}
	if b, _ := byID(got, "/b"); !b.Hidden {
		t.Error("/b was hidden by you")
	}
	if s, _ := byID(got, "/s"); s.Hidden {
		t.Error("/s was shown by you")
	}
	if a, _ := byID(got, "add:1"); a.Origin != OriginAdded || !slices.Equal(a.Send, []string{"继续"}) || !a.Enter {
		t.Errorf("added = %+v", a)
	}
	_ = yes
}

func strPtr(s string) *string { return &s }

// The store keeps one arrangement per program in one file, 0600, and Reset
// removes one program's.
func TestStore(t *testing.T) {
	path := filepath.Join(t.TempDir(), "webterm", "commands.json")
	s := Store{Path: path}
	if a := s.Load("claude"); len(a.Order) != 0 {
		t.Fatalf("empty store: %+v", a)
	}
	if err := s.Save("claude", Arrangement{Order: []string{"/compact"}}); err != nil {
		t.Fatal(err)
	}
	if err := s.Save("codex", Arrangement{Order: []string{"/review"}}); err != nil {
		t.Fatal(err)
	}
	if a := s.Load("claude"); !slices.Equal(a.Order, []string{"/compact"}) {
		t.Fatalf("claude = %+v", a)
	}
	if fi, err := os.Stat(path); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v, %v", fi.Mode().Perm(), err)
	}
	if err := s.Reset("claude"); err != nil {
		t.Fatal(err)
	}
	if a := s.Load("claude"); len(a.Order) != 0 {
		t.Fatal("reset left claude's arrangement")
	}
	if a := s.Load("codex"); !slices.Equal(a.Order, []string{"/review"}) {
		t.Fatal("reset removed codex's arrangement too")
	}
}

func TestKeyBytes(t *testing.T) {
	cases := map[string][]string{
		"ctrl+o":        {"\x0f"},
		"shift+tab":     {"\x1b[Z"},
		"meta+p":        {"\x1bp"},
		"alt+t":         {"\x1bt"},
		"escape":        {"\x1b"},
		"enter":         {"\r"},
		"ctrl+x ctrl+k": {"\x18", "\x0b"},
	}
	for in, want := range cases {
		if got, ok := keyBytes(in); !ok || !slices.Equal(got, want) {
			t.Errorf("keyBytes(%q) = %q, %v; want %q", in, got, ok, want)
		}
	}
	if _, ok := keyBytes("ctrl+shift+f12"); ok {
		t.Error("an unknown key should not parse")
	}
}
