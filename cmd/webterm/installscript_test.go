package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/creack/pty"

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
		"  setup) shift; printf '%s\\n' \"$@\" >> \"${FAKE_SETUP_LOG:-/dev/null}\"; echo FAKE-SETUP ;;\n" +
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
		if got := execStart(t, out); got != "ExecStart=/usr/local/bin/webterm serve --domain 203.0.113.9 --https-port 8443" {
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

	// ADR-0064: switching IP → domain keeps the port, channel and prefix.
	t.Run("a new --domain keeps the rest of install-state", func(t *testing.T) {
		sb := newSandbox(t)
		sb.writeState(t, "--domain", "203.0.113.5", "--https-port", "8443", "--prefix", "/opt/wt", "--channel", "dev")
		out, err := sb.run(t, nil, "--print-unit", "--domain", "term.example.com")
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		if got := execStart(t, out); got != "ExecStart=/opt/wt/webterm serve --domain term.example.com --https-port 8443" {
			t.Errorf("ExecStart = %q", got)
		}

		out, err = sb.run(t, nil, "--print-unit", "--domain", "term.example.com", "--https-port", "443")
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		if got := execStart(t, out); got != "ExecStart=/opt/wt/webterm serve --domain term.example.com" {
			t.Errorf("an explicit --https-port 443 should win: %q", got)
		}
	})

	t.Run("a trial without an address isn't carried over to --domain", func(t *testing.T) {
		sb := newSandbox(t)
		sb.writeState(t, "--no-service", "--no-setcap")
		out, err := sb.run(t, nil, "--print-unit", "--domain", "term.example.com")
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		if got := execStart(t, out); got != "ExecStart=/usr/local/bin/webterm serve --domain term.example.com --https-port 8443" {
			t.Errorf("a first install after a trial should get the first-install port: %q", got)
		}
	})

	t.Run("a new --domain keeps the channel in a real install", func(t *testing.T) {
		sb := newSandbox(t)
		bin := filepath.Join(sb.home, "webterm-new")
		fakeBinary(t, bin, true)
		sb.writeState(t, "--domain", "203.0.113.5", "--https-port", "8443", "--channel", "dev",
			"--prefix", sb.prefix, "--no-service", "--no-setcap")
		out, err := sb.run(t, nil, "--binary", bin, "--domain", "term.example.com")
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		got, err := os.ReadFile(filepath.Join(sb.config, "install-state"))
		if err != nil {
			t.Fatal(err)
		}
		want := strings.Join([]string{"--domain", "term.example.com", "--https-port", "8443",
			"--prefix", sb.prefix, "--channel", "dev", "--no-service", "--no-setcap"}, "\n")
		if !strings.Contains(string(got), want) {
			t.Errorf("install-state =\n%s\nwant it to contain\n%s", got, want)
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
		if got := execStart(t, out); got != "ExecStart=/usr/local/bin/webterm serve --domain term.example.com --https-port 8443" {
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

// UT-install-setup (AC-1.25, ADR-0055 §3): --setup runs `webterm setup --yes`
// without asking; --no-setup, or an install that isn't a first one, doesn't run
// it; --dry-run only says it would; install-state keeps neither flag.
func TestInstallScriptSetup(t *testing.T) {
	cases := []struct {
		name     string
		args     []string
		ran      bool
		inOut    string
		notInOut string
	}{
		{"--setup", []string{"--setup"}, true, "Setting up claude and codex", ""},
		{"--no-setup", []string{"--setup", "--no-setup"}, false, "", "Setting up claude"},
		{"not a first install, no flag", nil, false, "", "Setting up claude"},
		{"--setup --dry-run", []string{"--setup", "--dry-run"}, false, "Would run: webterm setup --yes", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			sb := newSandbox(t)
			bin := filepath.Join(sb.home, "webterm-new")
			fakeBinary(t, bin, true)
			log := filepath.Join(sb.home, "setup.log")
			args := append([]string{"--binary", bin, "--no-service", "--no-setcap", "--prefix", sb.prefix}, c.args...)
			out, err := sb.run(t, []string{"FAKE_SETUP_LOG=" + log}, args...)
			if err != nil {
				t.Fatalf("%v\n%s", err, out)
			}
			got, _ := os.ReadFile(log)
			if c.ran != (string(got) == "--yes\n") {
				t.Fatalf("webterm setup ran with %q, want ran=%v\n%s", got, c.ran, out)
			}
			if c.inOut != "" && !strings.Contains(out, c.inOut) {
				t.Errorf("output lacks %q:\n%s", c.inOut, out)
			}
			if c.notInOut != "" && strings.Contains(out, c.notInOut) {
				t.Errorf("output has %q:\n%s", c.notInOut, out)
			}
			if state, err := os.ReadFile(filepath.Join(sb.config, "install-state")); err == nil {
				for _, l := range strings.Split(string(state), "\n") {
					if l == "--setup" || l == "--no-setup" {
						t.Errorf("install-state keeps %s:\n%s", l, state)
					}
				}
			}
		})
	}
}

// UT-install-port (AC-1.21, ADR-0063): a first install serves HTTPS on 8443
// unless another port is chosen; a previous install keeps its port, 443
// included (install-state leaves 443 out); --https-port wins.
func TestInstallScriptDefaultPort(t *testing.T) {
	cases := []struct {
		name  string
		state []string
		args  []string
		want  string
	}{
		{"first install", nil, []string{"--domain", "term.example.com"}, " --https-port 8443"},
		{"first install, --https-port 443", nil, []string{"--domain", "term.example.com", "--https-port", "443"}, ""},
		{"first install, --https-port 9443", nil, []string{"--domain", "term.example.com", "--https-port", "9443"}, " --https-port 9443"},
		{"previous install on 443", []string{"--domain", "term.example.com"}, nil, ""},
		{"previous install on 8443", []string{"--domain", "term.example.com", "--https-port", "8443"}, nil, " --https-port 8443"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			sb := newSandbox(t)
			if c.state != nil {
				sb.writeState(t, c.state...)
			}
			out, err := sb.run(t, nil, append([]string{"--print-unit"}, c.args...)...)
			if err != nil {
				t.Fatalf("%v\n%s", err, out)
			}
			if got, want := execStart(t, out), "ExecStart=/usr/local/bin/webterm serve --domain term.example.com"+c.want; got != want {
				t.Errorf("ExecStart = %q, want %q", got, want)
			}
		})
	}
}

// UT-install-port (AC-1.21, ADR-0063): the address and port questions, run on
// a terminal as the installer runs them (they read /dev/tty).
func TestInstallScriptAsksPort(t *testing.T) {
	cases := []struct {
		name, call, input string
		want              string
		says              string
	}{
		{"Enter is 8443", "ask_port", "\n", "domain= port=8443 given=0", "Which HTTPS port?"},
		{"another port", "ask_port", "9443\n", "domain= port=9443 given=0", ""},
		{"443", "ask_port", "443\n", "domain= port=443 given=0", ""},
		{"asked again until valid", "ask_port", "abc\n70000\n80\n09443\n", "domain= port=9443 given=0", "choose another"},
		{"host:port at the address", "ask_address 203.0.113.9", "term.example.com:9443\n", "domain=term.example.com port=9443 given=1", ""},
		{"a pasted URL with a port", "ask_address 203.0.113.9", "https://term.example.com:8443/pair\n", "domain=term.example.com port=8443 given=1", ""},
		{"Enter at the address", "ask_address 203.0.113.9", "\n", "domain=203.0.113.9 port=443 given=0", ""},
		{"a bad port at the address is asked again", "ask_address 203.0.113.9", "term.example.com:80\nterm.example.com\n", "domain=term.example.com port=443 given=0", "choose another"},
	}
	// Only the functions: the script's top level would install.
	const prelude = `set -euo pipefail
eval "$(sed -n '/^die()/p; /^info()/p; /^port_ok()/,/^}/p; /^ask_port()/,/^}/p; /^ask_address()/,/^}/p' "$0")"
HTTP_PORT=80 HTTPS_PORT=443 DEFAULT_HTTPS_PORT=8443 PORT_GIVEN=0 DOMAIN="" ADDR_SOURCE=""
`
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cmd := exec.Command("bash", "-c", prelude+c.call+"\necho \"RESULT domain=$DOMAIN port=$HTTPS_PORT given=$PORT_GIVEN\"", installScript)
			ptmx, err := pty.Start(cmd)
			if err != nil {
				t.Fatal(err)
			}
			defer ptmx.Close()
			if _, err := ptmx.Write([]byte(c.input)); err != nil {
				t.Fatal(err)
			}
			var out bytes.Buffer
			_, _ = io.Copy(&out, ptmx) // ends with EIO once bash exits
			if err := cmd.Wait(); err != nil {
				t.Fatalf("%v\n%s", err, out.String())
			}
			if !strings.Contains(out.String(), "RESULT "+c.want+"\r\n") {
				t.Errorf("want %q in:\n%s", c.want, out.String())
			}
			if c.says != "" && !strings.Contains(out.String(), c.says) {
				t.Errorf("want %q in:\n%s", c.says, out.String())
			}
		})
	}
}

// UT-install-saved-after (AC-1.19, ADR-0064 §3): config and install-state are
// written only once the service runs, so a failed service step leaves both as
// they were and `webterm update` keeps replaying the install that worked.
func TestInstallScriptSavesSettingsAfterTheService(t *testing.T) {
	setup := func(t *testing.T) (fakeSystem, string, string, string) {
		fs := newFakeSystem(t)
		bin := filepath.Join(fs.home, "webterm-new")
		fakeBinary(t, bin, true)
		fs.writeState(t, "--domain", "203.0.113.5", "--https-port", "8443", "--prefix", fs.prefix)
		state := filepath.Join(fs.config, "install-state")
		cfg := filepath.Join(fs.config, "config")
		mustWrite(t, cfg, "domain = 203.0.113.5\nhttps-port = 8443\n", 0o644)
		return fs, bin, state, cfg
	}
	read := func(t *testing.T, p string) string {
		t.Helper()
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}

	t.Run("a failed service step changes neither", func(t *testing.T) {
		fs, bin, state, cfg := setup(t)
		oldState, oldCfg := read(t, state), read(t, cfg)
		out, err := fs.run(t, []string{"FAKE_FAIL=restart webterm"},
			"--binary", bin, "--no-setcap", "--no-setup", "--domain", "term.example.com", "--https-port", "443")
		if err == nil {
			t.Fatalf("the install should fail at the service step:\n%s", out)
		}
		if indexOf(fs.calls(t), "sudo systemctl restart webterm") < 0 {
			t.Fatalf("didn't get as far as the service step: %q\n%s", fs.calls(t), out)
		}
		if got := read(t, state); got != oldState {
			t.Errorf("install-state changed by a failed install:\n%s", got)
		}
		if got := read(t, cfg); got != oldCfg {
			t.Errorf("config changed by a failed install:\n%s", got)
		}
	})

	t.Run("a working install saves them", func(t *testing.T) {
		fs, bin, state, cfg := setup(t)
		out, err := fs.run(t, nil, "--binary", bin, "--no-setcap", "--no-setup", "--domain", "term.example.com")
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		if got := read(t, state); !strings.Contains(got, "--domain\nterm.example.com\n--https-port\n8443\n") {
			t.Errorf("install-state not saved with the new address and the kept port:\n%s", got)
		}
		if got := read(t, cfg); !strings.Contains(got, "domain = term.example.com") || !strings.Contains(got, "https-port = 8443") {
			t.Errorf("config not synced:\n%s", got)
		}
		if !strings.Contains(read(t, fs.unit), "--domain term.example.com --https-port 8443") {
			t.Errorf("unit:\n%s", read(t, fs.unit))
		}
	})
}
