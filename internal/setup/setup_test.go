package setup

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// UT-setup-claude (AC-1.24, ADR-0055 §2): preferredNotifChannel in
// ~/.claude/settings.json, added by inserting one line.
func TestClaudeSettings(t *testing.T) {
	cases := []struct {
		name, in string
		exists   bool
		state    State
		want     string // exact output when State == Add
	}{
		{"no file", "", false, Add, "{\n  \"preferredNotifChannel\": \"terminal_bell\"\n}\n"},
		{"empty object", "{}\n", true, Add, "{\n  \"preferredNotifChannel\": \"terminal_bell\"\n}\n"},
		{"multiline, two spaces", "{\n  \"theme\": \"dark\",\n  \"model\": \"opus\"\n}\n", true, Add,
			"{\n  \"preferredNotifChannel\": \"terminal_bell\",\n  \"theme\": \"dark\",\n  \"model\": \"opus\"\n}\n"},
		{"multiline, four spaces", "{\n    \"theme\": \"dark\"\n}", true, Add,
			"{\n    \"preferredNotifChannel\": \"terminal_bell\",\n    \"theme\": \"dark\"\n}"},
		{"one line", `{"theme":"dark"}`, true, Add, `{"preferredNotifChannel": "terminal_bell", "theme":"dark"}`},
		{"auto is replaced", "{\n  \"preferredNotifChannel\" : \"auto\",\n  \"x\": 1\n}\n", true, Add,
			"{\n  \"preferredNotifChannel\" : \"terminal_bell\",\n  \"x\": 1\n}\n"},
		{"already terminal_bell", `{"preferredNotifChannel": "terminal_bell"}`, true, OK, ""},
		{"another channel is the user's", `{"preferredNotifChannel": "iterm2"}`, true, Kept, ""},
		{"disabled is the user's", `{"preferredNotifChannel": "notifications_disabled"}`, true, Kept, ""},
		{"broken JSON", `{"theme": "dark",}`, true, Broken, ""},
		{"not an object", `["x"]`, true, Broken, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out, state, detail := claudeSettings([]byte(c.in), c.exists)
			if state != c.state {
				t.Fatalf("state = %v (%s), want %v", state, detail, c.state)
			}
			if detail == "" {
				t.Error("every state explains itself")
			}
			if state != Add {
				return
			}
			if string(out) != c.want {
				t.Fatalf("out =\n%s\nwant\n%s", out, c.want)
			}
			var m map[string]any
			if err := json.Unmarshal(out, &m); err != nil || m["preferredNotifChannel"] != "terminal_bell" {
				t.Fatalf("result doesn't parse to the setting: %v %v", err, m)
			}
		})
	}
}

// UT-setup-codex (AC-1.24, ADR-0055 §2): notifications under [tui] in
// ~/.codex/config.toml; only missing keys are added, right under the header.
func TestCodexConfig(t *testing.T) {
	cases := []struct {
		name, in string
		exists   bool
		state    State
		want     string
	}{
		{"no file", "", false, Add, "[tui]\nnotifications = true\nnotification_condition = \"always\"\n"},
		{"no tui table", "model = \"gpt\"\n\n[projects.\"/x\"]\ntrust_level = \"trusted\"\n", true, Add,
			"model = \"gpt\"\n\n[projects.\"/x\"]\ntrust_level = \"trusted\"\n\n[tui]\nnotifications = true\nnotification_condition = \"always\"\n"},
		{"no trailing newline", "model = \"gpt\"", true, Add, "model = \"gpt\"\n\n[tui]\nnotifications = true\nnotification_condition = \"always\"\n"},
		{"tui without the keys, subtable after", "[tui]\nscreen_reader_detection_done = true\n\n[tui.model_availability_nux]\n\"gpt-6\" = 4\n", true, Add,
			"[tui]\nnotifications = true\nnotification_condition = \"always\"\nscreen_reader_detection_done = true\n\n[tui.model_availability_nux]\n\"gpt-6\" = 4\n"},
		{"header with a comment", "[tui]  # display\nx = 1\n", true, Add, "[tui]  # display\nnotifications = true\nnotification_condition = \"always\"\nx = 1\n"},
		{"one key there keeps its value", "[tui]\nnotification_condition = \"unfocused\"\n", true, Add,
			"[tui]\nnotifications = true\nnotification_condition = \"unfocused\"\n"},
		{"both there", "[tui]\nnotifications = [\"agent-turn-complete\"]\nnotification_condition = \"always\"\n", true, OK, ""},
		{"turned off", "[tui]\nnotifications = false # quiet\n", true, Kept, ""},
		{"keys in another table don't count", "[other]\nnotifications = true\n[tui]\nx = 1\n", true, Add,
			"[other]\nnotifications = true\n[tui]\nnotifications = true\nnotification_condition = \"always\"\nx = 1\n"},
		{"inline table", "tui = { notifications = true }\n", true, Kept, ""},
		{"dotted keys", "tui.notifications = true\ntui.notification_condition = \"always\"\n", true, OK, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out, state, detail := codexConfig([]byte(c.in), c.exists)
			if state != c.state {
				t.Fatalf("state = %v (%s), want %v", state, detail, c.state)
			}
			if detail == "" {
				t.Error("every state explains itself")
			}
			if state == Add && string(out) != c.want {
				t.Fatalf("out =\n%s\nwant\n%s", out, c.want)
			}
		})
	}
}

// UT-setup-shell (AC-1.24, ADR-0055 §2): history as you go, for bash and zsh.
func TestShellHistory(t *testing.T) {
	cases := []struct {
		name, shell, in string
		exists          bool
		state           State
		contains        string
	}{
		{"bash, nothing yet", "bash", "alias ll='ls -l'\n", true, Add, "PROMPT_COMMAND=\"history -a${PROMPT_COMMAND:+;$PROMPT_COMMAND}\""},
		{"bash path", "/usr/bin/bash", "", false, Add, "# >>> webterm >>>"},
		{"bash, already", "bash", "export PROMPT_COMMAND='history -a; history -n'\n", true, OK, ""},
		{"zsh, nothing yet", "zsh", "autoload -U compinit\n", true, Add, "setopt INC_APPEND_HISTORY"},
		{"zsh, share history", "/bin/zsh", "setopt share_history\n", true, OK, ""},
		{"zsh, lower case", "zsh", "setopt incappendhistory\n", true, OK, ""},
		{"fish", "fish", "", false, Skipped, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out, state, detail := shellHistory(c.shell, []byte(c.in), c.exists)
			if state != c.state {
				t.Fatalf("state = %v (%s), want %v", state, detail, c.state)
			}
			if detail == "" {
				t.Error("every state explains itself")
			}
			if state != Add {
				return
			}
			s := string(out)
			if !strings.HasPrefix(s, c.in) {
				t.Fatalf("the existing content changed:\n%s", s)
			}
			if !strings.Contains(s, c.contains) || !strings.Contains(s, "# <<< webterm <<<\n") {
				t.Fatalf("block missing:\n%s", s)
			}
			if c.exists && c.in != "" && !strings.Contains(s, c.in+"\n# >>> webterm >>>") {
				t.Fatalf("block should follow a blank line:\n%s", s)
			}
		})
	}
}

func write(t *testing.T, path, content string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, mode); err != nil { // past the umask
		t.Fatal(err)
	}
}

func states(items []Item) map[string]State {
	m := map[string]State{}
	for _, it := range items {
		m[it.Name] = it.State
	}
	return m
}

// Plan + Apply on a home directory: what's installed decides what's planned;
// applying backs up, keeps modes, writes through symlinks, and a second plan
// finds nothing to add.
func TestPlanAndApply(t *testing.T) {
	home := t.TempDir()
	write(t, filepath.Join(home, ".claude", "settings.json"), "{\n  \"theme\": \"dark\"\n}\n", 0o664)
	write(t, filepath.Join(home, ".codex", "config.toml"), "[tui]\nx = 1\n", 0o600)
	// ~/.bashrc is a symlink into a dotfiles directory
	real := filepath.Join(home, "dotfiles", "bashrc")
	write(t, real, "# mine\n", 0o644)
	if err := os.Symlink(real, filepath.Join(home, ".bashrc")); err != nil {
		t.Fatal(err)
	}

	items := Plan(home, "bash")
	if got := states(items); got[ItemClaude] != Add || got[ItemCodex] != Add || got[ItemShell] != Add {
		t.Fatalf("plan = %v, want three adds", got)
	}
	now := time.Date(2026, 11, 7, 18, 0, 0, 0, time.UTC)
	if err := Apply(items, now); err != nil {
		t.Fatal(err)
	}

	for _, c := range []struct {
		path string
		mode os.FileMode
		was  string
	}{
		{filepath.Join(home, ".claude", "settings.json"), 0o664, "{\n  \"theme\": \"dark\"\n}\n"},
		{filepath.Join(home, ".codex", "config.toml"), 0o600, "[tui]\nx = 1\n"},
		{real, 0o644, "# mine\n"},
	} {
		fi, err := os.Stat(c.path)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != c.mode {
			t.Errorf("%s mode = %v, want %v", c.path, fi.Mode().Perm(), c.mode)
		}
		bak, err := os.ReadFile(c.path + ".webterm-bak")
		if err != nil || string(bak) != c.was {
			t.Errorf("%s backup = %q, %v; want %q", c.path, bak, err, c.was)
		}
	}
	if fi, err := os.Lstat(filepath.Join(home, ".bashrc")); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("~/.bashrc is no longer a symlink: %v %v", fi.Mode(), err)
	}
	if b, _ := os.ReadFile(real); !strings.Contains(string(b), "history -a") {
		t.Fatalf("the symlink's target wasn't written:\n%s", b)
	}

	again := Plan(home, "bash")
	for _, it := range again {
		if it.State != OK {
			t.Errorf("second plan: %s is %v (%s), want OK", it.Name, it.State, it.Detail)
		}
	}

	// A later change to the same file keeps the first backup and adds a dated one
	write(t, filepath.Join(home, ".claude", "settings.json"), "{\"preferredNotifChannel\": \"auto\"}\n", 0o664)
	if err := Apply(Plan(home, "bash"), now); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, ".claude", "settings.json.webterm-bak-20261107-180000")); err != nil {
		t.Fatalf("no dated backup: %v", err)
	}
}

func TestPlanSkipsWhatIsNotInstalled(t *testing.T) {
	home := t.TempDir()
	got := states(Plan(home, "fish"))
	if got[ItemClaude] != Skipped || got[ItemCodex] != Skipped || got[ItemShell] != Skipped {
		t.Fatalf("plan = %v, want all skipped", got)
	}
	// claude installed but no settings file yet: it's created
	if err := os.MkdirAll(filepath.Join(home, ".claude"), 0o755); err != nil {
		t.Fatal(err)
	}
	items := Plan(home, "fish")
	if states(items)[ItemClaude] != Add {
		t.Fatalf("claude without settings.json should be added: %v", states(items))
	}
	if err := Apply(items, time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, ".claude", "settings.json.webterm-bak")); !os.IsNotExist(err) {
		t.Fatal("a new file has nothing to back up")
	}
}

// A file that doesn't parse is reported and never written.
func TestBrokenFilesAreLeftAlone(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, ".claude", "settings.json")
	write(t, path, "{ broken", 0o644)
	items := Plan(home, "fish")
	if states(items)[ItemClaude] != Broken {
		t.Fatalf("plan = %v", states(items))
	}
	if err := Apply(items, time.Now()); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(path); string(b) != "{ broken" {
		t.Fatalf("a broken file was written: %q", b)
	}
}
