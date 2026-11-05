package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/sunhaijun/webterm/scripts"
)

// Behavior tests for install.sh (ADR-0045). No network, no sudo, no systemd:
// --print-unit only prints, and real runs use --no-service --no-setcap and a temp prefix.

const installScript = "../../scripts/install.sh"

// sandbox is a clean HOME, so install-state and config never touch the developer's.
type sandbox struct {
	home, config, prefix string
}

func newSandbox(t *testing.T) sandbox {
	t.Helper()
	if os.Geteuid() == 0 {
		t.Skip("install.sh refuses to run as root")
	}
	home := t.TempDir()
	return sandbox{home: home, config: filepath.Join(home, ".config", "webterm"), prefix: filepath.Join(home, "bin")}
}

func (sb sandbox) run(t *testing.T, env []string, args ...string) (string, error) {
	t.Helper()
	cmd := exec.Command("bash", append([]string{installScript}, args...)...)
	cmd.Env = append(os.Environ(), "HOME="+sb.home, "XDG_CONFIG_HOME="+filepath.Join(sb.home, ".config"))
	cmd.Env = append(cmd.Env, env...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func (sb sandbox) writeState(t *testing.T, lines ...string) {
	t.Helper()
	if err := os.MkdirAll(sb.config, 0o755); err != nil {
		t.Fatal(err)
	}
	body := "# written by a test\n" + strings.Join(lines, "\n") + "\n"
	if err := os.WriteFile(filepath.Join(sb.config, "install-state"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// execStart returns the ExecStart line from --print-unit output.
func execStart(t *testing.T, unit string) string {
	t.Helper()
	for _, l := range strings.Split(unit, "\n") {
		if strings.HasPrefix(l, "ExecStart=") {
			return l
		}
	}
	t.Fatalf("no ExecStart in unit:\n%s", unit)
	return ""
}

// fakeBinary writes a fake webterm: `version` prints a version, `install` records
// its arguments in $FAKE_LOG. withInstall=false mimics v0.1.0, which has no install.
func fakeBinary(t *testing.T, path string, withInstall bool) {
	t.Helper()
	install := `shift; printf '%s\n' "$@" > "$FAKE_LOG"; exit 0`
	if !withInstall {
		install = `echo "unknown command \"install\"" >&2; exit 2`
	}
	script := "#!/bin/bash\ncase \"$1\" in\n" +
		"  version) echo 'webterm fake-1' ;;\n" +
		"  install) " + install + " ;;\n" +
		"  *) exit 0 ;;\n" +
		"esac\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
}

// UT-install-embed: the binary embeds scripts/install.sh byte for byte.
func TestInstallScriptIsEmbedded(t *testing.T) {
	disk, err := os.ReadFile(installScript)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(disk, scripts.InstallSH) {
		t.Fatal("embedded install.sh differs from the file on disk")
	}
	if got := withSelfBinary("/x/webterm", []string{"--domain", "a"}); strings.Join(got, " ") != "--binary /x/webterm --domain a" {
		t.Errorf("webterm install should pass itself as --binary: %v", got)
	}
	if got := withSelfBinary("/x/webterm", []string{"--binary", "/y"}); strings.Join(got, " ") != "--binary /y" {
		t.Errorf("an explicit --binary must not get a second one: %v", got)
	}
}

// UT-install-default-addr: without --domain, reuse install-state if present, else the public IP.
func TestInstallScriptDefaultAddress(t *testing.T) {
	t.Run("fresh machine uses the public IP", func(t *testing.T) {
		sb := newSandbox(t)
		out, err := sb.run(t, []string{"WEBTERM_PUBLIC_IP=203.0.113.9"}, "--print-unit")
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		if got := execStart(t, out); got != "ExecStart=/usr/local/bin/webterm serve --domain 203.0.113.9" {
			t.Errorf("ExecStart = %q", got)
		}
	})

	t.Run("previous install is reused; the command line wins", func(t *testing.T) {
		sb := newSandbox(t)
		sb.writeState(t, "--domain", "term.example.com", "--https-port", "8443")
		out, err := sb.run(t, []string{"WEBTERM_PUBLIC_IP=203.0.113.9"}, "--print-unit")
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		if got := execStart(t, out); got != "ExecStart=/usr/local/bin/webterm serve --domain term.example.com --https-port 8443" {
			t.Errorf("install-state not reused: %q", got)
		}

		out, err = sb.run(t, nil, "--print-unit", "--https-port", "9443")
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		if got := execStart(t, out); got != "ExecStart=/usr/local/bin/webterm serve --domain term.example.com --https-port 9443" {
			t.Errorf("command line did not override install-state: %q", got)
		}
	})

	t.Run("explicit --domain ignores install-state", func(t *testing.T) {
		sb := newSandbox(t)
		sb.writeState(t, "--domain", "old.example.com", "--https-port", "8443")
		out, err := sb.run(t, nil, "--print-unit", "--domain", "203.0.113.5")
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		if got := execStart(t, out); got != "ExecStart=/usr/local/bin/webterm serve --domain 203.0.113.5" {
			t.Errorf("ExecStart = %q", got)
		}
	})

	// Host names are case-insensitive; browsers send the Origin host in
	// lowercase, so the unit must carry it that way (ADR-0047 §1).
	t.Run("domain is lowercased", func(t *testing.T) {
		sb := newSandbox(t)
		out, err := sb.run(t, nil, "--print-unit", "--domain", "Term.Example.COM.")
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		if got := execStart(t, out); got != "ExecStart=/usr/local/bin/webterm serve --domain term.example.com" {
			t.Errorf("ExecStart = %q", got)
		}
	})

	t.Run("IPv6 is rejected", func(t *testing.T) {
		sb := newSandbox(t)
		out, err := sb.run(t, nil, "--print-unit", "--domain", "2001:db8::1")
		if err == nil || !strings.Contains(out, "IPv4") {
			t.Fatalf("IPv6 should be rejected with a reason, err=%v\n%s", err, out)
		}
	})
}

// UT-install-config-sync: reinstalling syncs address and ports into the config and keeps other keys.
func TestInstallScriptSyncsConfig(t *testing.T) {
	sb := newSandbox(t)
	bin := filepath.Join(sb.home, "webterm-new")
	fakeBinary(t, bin, true)
	if err := os.MkdirAll(sb.config, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := filepath.Join(sb.config, "config")
	old := "# my config\ndomain = 203.0.113.9\nhttps-port = 8443\nsession-env = FOO=1\n"
	if err := os.WriteFile(cfg, []byte(old), 0o644); err != nil {
		t.Fatal(err)
	}

	out, err := sb.run(t, nil, "--binary", bin, "--no-service", "--no-setcap",
		"--prefix", sb.prefix, "--domain", "term.example.com", "--http-port", "8080")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	got, err := os.ReadFile(cfg)
	if err != nil {
		t.Fatal(err)
	}
	s := string(got)
	for _, want := range []string{"# my config", "domain = term.example.com", "http-port = 8080", "session-env = FOO=1"} {
		if !strings.Contains(s, want) {
			t.Errorf("config lacks %q:\n%s", want, s)
		}
	}
	for _, bad := range []string{"203.0.113.9", "https-port"} {
		if strings.Contains(s, bad) {
			t.Errorf("config still has %q (address changed, port back to default):\n%s", bad, s)
		}
	}
	if _, err := os.Stat(filepath.Join(sb.prefix, "webterm")); err != nil {
		t.Errorf("--binary was not installed to --prefix: %v", err)
	}
	if strings.Contains(out, "Downloading") || strings.Contains(out, "From:") {
		t.Errorf("--binary must not download:\n%s", out)
	}
}

// UT-install-handover: a downloaded script verifies the binary, then hands over to
// its `install` with the original arguments; binaries without install are refused.
func TestInstallScriptHandsOverToDownloadedBinary(t *testing.T) {
	arch := map[string]string{"amd64": "amd64", "arm64": "arm64"}[runtime.GOARCH]
	if arch == "" {
		t.Skip("install.sh supports amd64 and arm64 only")
	}
	setup := func(t *testing.T, withInstall bool) (sandbox, string, string) {
		sb := newSandbox(t)
		dl := filepath.Join(sb.home, "dl")
		if err := os.MkdirAll(dl, 0o755); err != nil {
			t.Fatal(err)
		}
		name := "webterm-linux-" + arch
		fakeBinary(t, filepath.Join(dl, name), withInstall)
		raw, err := os.ReadFile(filepath.Join(dl, name))
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(raw)
		if err := os.WriteFile(filepath.Join(dl, "SHA256SUMS"),
			[]byte(hex.EncodeToString(sum[:])+"  "+name+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		return sb, dl, filepath.Join(sb.home, "fake.log")
	}

	t.Run("hands over to the downloaded binary", func(t *testing.T) {
		sb, dl, log := setup(t, true)
		args := []string{"--base-url", "file://" + dl, "--no-service", "--no-setcap",
			"--prefix", sb.prefix, "--domain", "term.example.com"}
		out, err := sb.run(t, []string{"FAKE_LOG=" + log}, args...)
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		if !strings.Contains(out, "Checksum OK") || !strings.Contains(out, "Handing over to webterm fake-1") {
			t.Errorf("no verification or no handover:\n%s", out)
		}
		got, err := os.ReadFile(log)
		if err != nil {
			t.Fatalf("the downloaded binary's install was not called: %v\n%s", err, out)
		}
		if strings.TrimSpace(string(got)) != strings.Join(args, "\n") {
			t.Errorf("handed-over args = %q, want them unchanged: %q", got, args)
		}
		if _, err := os.Stat(filepath.Join(sb.prefix, "webterm")); err == nil {
			t.Error("the outer script installed the binary itself; after handover it must do nothing")
		}
	})

	t.Run("old binary without install is refused", func(t *testing.T) {
		sb, dl, log := setup(t, false)
		out, err := sb.run(t, []string{"FAKE_LOG=" + log}, "--base-url", "file://"+dl, "--no-service", "--no-setcap",
			"--prefix", sb.prefix, "--domain", "term.example.com")
		if err == nil {
			t.Fatalf("old binary should be refused:\n%s", out)
		}
		if !strings.Contains(out, "predates this installer") || !strings.Contains(out, "v0.2.0") {
			t.Errorf("refusal doesn't say why:\n%s", out)
		}
		if _, err := os.Stat(filepath.Join(sb.prefix, "webterm")); err == nil {
			t.Error("nothing should be installed after a refusal")
		}
	})

	t.Run("bad checksum aborts before handover", func(t *testing.T) {
		sb, dl, log := setup(t, true)
		if err := os.WriteFile(filepath.Join(dl, "SHA256SUMS"),
			[]byte(strings.Repeat("0", 64)+"  webterm-linux-"+arch+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		out, err := sb.run(t, []string{"FAKE_LOG=" + log}, "--base-url", "file://"+dl, "--no-service", "--no-setcap",
			"--prefix", sb.prefix, "--domain", "term.example.com")
		if err == nil || !strings.Contains(out, "Checksum mismatch") {
			t.Fatalf("a bad checksum should abort, err=%v\n%s", err, out)
		}
		if _, err := os.Stat(log); err == nil {
			t.Error("handed over despite a failed checksum")
		}
	})
}
