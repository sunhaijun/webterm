package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// installed lays out a service install in the fake system: binary, unit, config,
// install-state, data directory and sent files.
func installed(t *testing.T, fs fakeSystem) {
	t.Helper()
	fakeBinary(t, filepath.Join(fs.prefix, "webterm"), true)
	fs.writeUnit(t, filepath.Join(fs.prefix, "webterm"))
	fs.writeState(t, "--domain", "t.example.com", "--https-port", "8443", "--prefix", fs.prefix)
	mustWrite(t, filepath.Join(fs.config, "config"), "domain = t.example.com\nhttps-port = 8443\n", 0o644)
	mustWrite(t, filepath.Join(fs.config, "commands.json"), "{}\n", 0o644)
	mustWrite(t, filepath.Join(fs.data, "webterm.db"), "db", 0o600)
	mustWrite(t, filepath.Join(fs.data, "certs", "t.example.com"), "cert", 0o600)
	mustWrite(t, filepath.Join(fs.sentFiles(), "shot.png"), "png", 0o600)
}

func (fs fakeSystem) sentFiles() string {
	return filepath.Join(fs.tmp, "webterm-"+strconv.Itoa(os.Getuid()))
}

// UT-uninstall (AC-1.26, ADR-0065)
func TestUninstall(t *testing.T) {
	t.Run("removes everything; over SSH the service stops before the files go", func(t *testing.T) {
		fs := newFakeSystem(t)
		installed(t, fs)
		out, err := fs.run(t, []string{"FAKE_ACTIVE=webterm", "FAKE_WATCH=" + fs.data}, "--uninstall", "--yes")
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		for _, p := range []string{filepath.Join(fs.prefix, "webterm"), fs.unit, fs.config, fs.data, fs.sentFiles()} {
			if exists(p) {
				t.Errorf("%s is still there\n%s", p, out)
			}
		}
		calls := fs.calls(t)
		disable, stop := indexOf(calls, "sudo systemctl disable webterm"), indexOf(calls, "sudo systemctl stop webterm")
		if disable < 0 || stop < 0 || indexOf(calls, "sudo systemctl daemon-reload") < 0 {
			t.Fatalf("service not disabled, reloaded and stopped: %q", calls)
		}
		if !strings.Contains(calls[stop], "[data present]") {
			t.Errorf("outside a session the service must stop before the files are removed: %q", calls[stop])
		}
		for _, c := range calls {
			if strings.Contains(c, "ufw") || strings.Contains(c, "firewall-cmd") || strings.Contains(c, "loginctl") {
				t.Errorf("firewall and lingering must be left alone, ran %q", c)
			}
		}
	})

	t.Run("inside a webterm session the service stops last", func(t *testing.T) {
		fs := newFakeSystem(t)
		installed(t, fs)
		fs.setInside(t, true)
		out, err := fs.run(t, []string{"FAKE_ACTIVE=webterm", "FAKE_WATCH=" + fs.data}, "--uninstall", "--yes")
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		calls := fs.calls(t)
		stop := indexOf(calls, "sudo systemctl stop webterm")
		if stop != len(calls)-1 {
			t.Fatalf("stop must be the last call: %q", calls)
		}
		if !strings.Contains(calls[stop], "[data gone]") {
			t.Errorf("inside a session everything must be removed before the stop: %q", calls[stop])
		}
		if indexOf(calls, "sudo systemctl disable webterm") > stop || indexOf(calls, "daemon-reload") > stop {
			t.Errorf("the unit must be disabled and removed before the stop: %q", calls)
		}
		if !strings.Contains(out, "session") || !strings.Contains(out, "close") {
			t.Errorf("it should say this session closes:\n%s", out)
		}
		for _, p := range []string{filepath.Join(fs.prefix, "webterm"), fs.unit, fs.config, fs.data} {
			if exists(p) {
				t.Errorf("%s is still there", p)
			}
		}
	})

	t.Run("--keep-data keeps config and data", func(t *testing.T) {
		fs := newFakeSystem(t)
		installed(t, fs)
		out, err := fs.run(t, []string{"FAKE_ACTIVE=webterm"}, "--uninstall", "--yes", "--keep-data")
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		for _, p := range []string{filepath.Join(fs.config, "install-state"), filepath.Join(fs.config, "config"), filepath.Join(fs.data, "webterm.db"), filepath.Join(fs.data, "certs")} {
			if !exists(p) {
				t.Errorf("--keep-data removed %s", p)
			}
		}
		for _, p := range []string{filepath.Join(fs.prefix, "webterm"), fs.unit, fs.sentFiles()} {
			if exists(p) {
				t.Errorf("%s is still there", p)
			}
		}
	})

	t.Run("a unit that runs another binary is left alone", func(t *testing.T) {
		fs := newFakeSystem(t)
		installed(t, fs)
		fs.writeUnit(t, "/usr/local/bin/webterm")
		out, err := fs.run(t, []string{"FAKE_ACTIVE=webterm"}, "--uninstall", "--yes")
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		if !exists(fs.unit) {
			t.Error("removed a unit that runs /usr/local/bin/webterm, not this install's binary")
		}
		for _, c := range fs.calls(t) {
			if strings.HasPrefix(c, "sudo systemctl") {
				t.Errorf("touched a service that isn't this install's: %q", c)
			}
		}
		if !strings.Contains(out, "/usr/local/bin/webterm") {
			t.Errorf("it should say which service it left alone:\n%s", out)
		}
		if exists(filepath.Join(fs.prefix, "webterm")) {
			t.Error("this install's binary should still be removed")
		}
	})

	t.Run("an old user service", func(t *testing.T) {
		fs := newFakeSystem(t)
		installed(t, fs)
		if err := os.Remove(fs.unit); err != nil {
			t.Fatal(err)
		}
		userUnit := filepath.Join(fs.home, ".config", "systemd", "user", "webterm.service")
		mustWrite(t, userUnit, "[Service]\n", 0o644)
		out, err := fs.run(t, []string{"FAKE_ACTIVE=user:webterm"}, "--uninstall", "--yes")
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		if exists(userUnit) {
			t.Error("the user unit is still there")
		}
		calls := fs.calls(t)
		if indexOf(calls, "systemctl --user disable webterm") < 0 || indexOf(calls, "systemctl --user stop webterm") < 0 {
			t.Errorf("user service not disabled and stopped: %q", calls)
		}
		if indexOf(calls, "sudo systemctl") >= 0 {
			t.Errorf("no system unit, so no sudo systemctl: %q", calls)
		}
	})

	t.Run("a data-dir from the config is removed only if it holds webterm.db", func(t *testing.T) {
		fs := newFakeSystem(t)
		installed(t, fs)
		custom := filepath.Join(fs.home, "srv", "wt")
		mustWrite(t, filepath.Join(custom, "webterm.db"), "db", 0o600)
		cfg := filepath.Join(fs.config, "config")
		mustWrite(t, cfg, "domain = t.example.com\ndata-dir = "+custom+"\n", 0o644)
		if out, err := fs.run(t, nil, "--uninstall", "--yes"); err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		if exists(custom) {
			t.Error("the config's data-dir holding webterm.db is still there")
		}

		fs = newFakeSystem(t)
		installed(t, fs)
		other := filepath.Join(fs.home, "projects")
		mustWrite(t, filepath.Join(other, "keep.txt"), "mine", 0o644)
		mustWrite(t, filepath.Join(fs.config, "config"), "data-dir = "+other+"\n", 0o644)
		out, err := fs.run(t, nil, "--uninstall", "--yes")
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		if !exists(filepath.Join(other, "keep.txt")) {
			t.Fatal("removed a data-dir without webterm.db")
		}
	})

	t.Run("names what it leaves alone", func(t *testing.T) {
		fs := newFakeSystem(t)
		installed(t, fs)
		mustWrite(t, fs.ufwConf, "ENABLED=yes\n", 0o644)
		me, _ := exec.Command("id", "-un").Output()
		mustWrite(t, filepath.Join(fs.linger, strings.TrimSpace(string(me))), "", 0o644)
		mustWrite(t, filepath.Join(fs.home, ".claude", "settings.json"), `{"preferredNotifChannel": "terminal_bell"}`, 0o644)
		out, err := fs.run(t, []string{"FAKE_ACTIVE=webterm firewalld"}, "--uninstall", "--yes")
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		for _, want := range []string{
			"sudo ufw delete allow 80/tcp", "sudo ufw delete allow 8443/tcp",
			"sudo firewall-cmd --permanent --remove-port=8443/tcp",
			"loginctl disable-linger",
			"webterm setup",
		} {
			if !strings.Contains(out, want) {
				t.Errorf("output lacks %q:\n%s", want, out)
			}
		}
	})

	t.Run("without a terminal it needs --yes", func(t *testing.T) {
		fs := newFakeSystem(t)
		installed(t, fs)
		out, err := fs.run(t, []string{"FAKE_ACTIVE=webterm"}, "--uninstall")
		if err == nil {
			t.Fatalf("should refuse without a terminal and without --yes:\n%s", out)
		}
		if !strings.Contains(out, "--yes") {
			t.Errorf("the refusal should name --yes:\n%s", out)
		}
		if !exists(filepath.Join(fs.prefix, "webterm")) || !exists(fs.data) || !exists(fs.unit) {
			t.Error("removed something without confirmation")
		}
		if indexOf(fs.calls(t), "sudo") >= 0 {
			t.Errorf("ran sudo without confirmation: %q", fs.calls(t))
		}
	})

	t.Run("--dry-run changes nothing", func(t *testing.T) {
		fs := newFakeSystem(t)
		installed(t, fs)
		out, err := fs.run(t, []string{"FAKE_ACTIVE=webterm"}, "--uninstall", "--dry-run")
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		for _, p := range []string{filepath.Join(fs.prefix, "webterm"), fs.unit, fs.config, fs.data, fs.sentFiles()} {
			if !exists(p) {
				t.Errorf("--dry-run removed %s", p)
			}
		}
		if indexOf(fs.calls(t), "sudo") >= 0 {
			t.Errorf("--dry-run ran sudo: %q", fs.calls(t))
		}
		for _, want := range []string{fs.data, fs.config, "systemctl stop webterm"} {
			if !strings.Contains(out, want) {
				t.Errorf("the plan lacks %q:\n%s", want, out)
			}
		}
	})

	t.Run("nothing installed", func(t *testing.T) {
		fs := newFakeSystem(t)
		out, err := fs.run(t, nil, "--uninstall", "--yes")
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		if !strings.Contains(out, "Nothing to remove") {
			t.Errorf("should say there's nothing to remove:\n%s", out)
		}
	})

	t.Run("not as root", func(t *testing.T) {
		fs := newFakeSystem(t)
		installed(t, fs)
		out, err := fs.run(t, []string{"FAKE_ROOT=1"}, "--uninstall", "--yes")
		if err == nil || !strings.Contains(out, "root") {
			t.Fatalf("root should be refused, err=%v\n%s", err, out)
		}
		if !exists(fs.data) {
			t.Error("removed data as root")
		}
	})
}

// `webterm uninstall` runs the embedded script with --uninstall and without --binary.
func TestUninstallArgs(t *testing.T) {
	if got := strings.Join(uninstallArgs([]string{"--keep-data", "--yes"}), " "); got != "--uninstall --keep-data --yes" {
		t.Errorf("uninstallArgs = %q", got)
	}
}
