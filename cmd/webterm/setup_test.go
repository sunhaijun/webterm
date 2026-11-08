package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// runSetupCmd runs `webterm setup args...` as a child with home as HOME and no
// controlling terminal (setsid), so /dev/tty can't be opened.
func runSetupCmd(t *testing.T, home string, args ...string) (string, int) {
	t.Helper()
	cmd := exec.Command(os.Args[0], append([]string{"setup"}, args...)...)
	cmd.Env = append(os.Environ(), "WEBTERM_TEST_MAIN=1", "HOME="+home, "XDG_CONFIG_HOME="+filepath.Join(home, ".config"))
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	out, err := cmd.CombinedOutput()
	code := 0
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatal(err)
	}
	return string(out), code
}

// IT-setup-1 (AC-1.24, ADR-0055 §1, ADR-0058 §4): --check reports and exits
// 1 while something is missing; without a terminal and without --yes nothing
// changes; --yes adds; afterwards --check exits 0 and another --yes changes
// nothing. The shell's files are never touched.
func TestITSetup1(t *testing.T) {
	home := t.TempDir()
	for _, d := range []string{".claude", ".codex"} {
		if err := os.MkdirAll(filepath.Join(home, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	codexFile := filepath.Join(home, ".codex", "config.toml")
	if err := os.WriteFile(codexFile, []byte("model = \"x\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	bashrc := filepath.Join(home, ".bashrc")
	if err := os.WriteFile(bashrc, []byte("# mine\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	out, code := runSetupCmd(t, home, "--check")
	if code != 1 || !strings.Contains(out, "2 to add") {
		t.Fatalf("--check with everything missing: exit %d\n%s", code, out)
	}
	for _, want := range []string{"claude notifications (~/.claude/settings.json)", "codex notifications (~/.codex/config.toml)"} {
		if !strings.Contains(out, want) {
			t.Errorf("--check output lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "shell") {
		t.Errorf("no shell item any more:\n%s", out)
	}

	out, code = runSetupCmd(t, home)
	if code != 0 || !strings.Contains(out, "No terminal to ask on; nothing changed") {
		t.Fatalf("no terminal, no --yes: exit %d\n%s", code, out)
	}
	if _, err := os.Stat(filepath.Join(home, ".claude", "settings.json")); !os.IsNotExist(err) {
		t.Fatal("something was written without consent")
	}

	out, code = runSetupCmd(t, home, "--yes")
	if code != 0 || !strings.Contains(out, "Done.") {
		t.Fatalf("--yes: exit %d\n%s", code, out)
	}
	if !strings.Contains(out, "was saved as "+codexFile+".webterm-bak") {
		t.Errorf("--yes should say where config.toml was saved:\n%s", out)
	}
	settings, _ := os.ReadFile(filepath.Join(home, ".claude", "settings.json"))
	codex, _ := os.ReadFile(codexFile)
	rc, _ := os.ReadFile(bashrc)
	if !strings.Contains(string(settings), `"preferredNotifChannel": "terminal_bell"`) ||
		!strings.HasPrefix(string(codex), "model = \"x\"\n") || !strings.Contains(string(codex), "notification_condition = \"always\"") ||
		string(rc) != "# mine\n" {
		t.Fatalf("files after --yes:\n%s\n%s\n%s", settings, codex, rc)
	}

	out, code = runSetupCmd(t, home, "--check")
	if code != 0 || !strings.Contains(out, "Nothing to add.") {
		t.Fatalf("--check after --yes: exit %d\n%s", code, out)
	}
	before, _ := os.Stat(codexFile)
	out, code = runSetupCmd(t, home, "--yes")
	after, _ := os.Stat(codexFile)
	if code != 0 || !strings.Contains(out, "Nothing to add.") || !after.ModTime().Equal(before.ModTime()) {
		t.Fatalf("a second --yes changed something: exit %d\n%s", code, out)
	}
}

// A config file naming a shell (as serve uses) is still fine for setup, which
// no longer looks at the shell.
func TestSetupIgnoresTheShell(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, ".config", "webterm"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".config", "webterm", "config"), []byte("shell = /bin/zsh\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	out, code := runSetupCmd(t, home, "--check")
	if code != 0 || !strings.Contains(out, "Nothing to add.") {
		t.Fatalf("exit %d\n%s", code, out)
	}
	if _, err := os.Stat(filepath.Join(home, ".zshrc")); !os.IsNotExist(err) {
		t.Fatal("~/.zshrc was created")
	}
}
