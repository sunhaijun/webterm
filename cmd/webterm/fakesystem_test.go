package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// fakeSystem runs install.sh against a sandbox where nothing reaches the real
// machine, so service installs and uninstalls can run for real in tests:
//
//   - sudo, systemctl, loginctl, ufw and firewall-cmd are fakes on PATH. sudo runs
//     the command unprivileged; the others only log to $FAKE_LOG. `systemctl
//     is-active` answers from $FAKE_ACTIVE ("webterm", "user:webterm", "firewalld").
//   - The environment is built from scratch: HOME, XDG_*, TMPDIR and the default
//     prefix (WEBTERM_PREFIX) all point into the sandbox, and WEBTERM_SYSROOT
//     puts the system's files there too (the unit, ufw.conf, lingering, and the
//     cgroup that says whether we're "inside" a webterm session).
//
// On a developer machine that runs webterm itself, a test that inherited the real
// environment could stop that service or delete its data; this one can't.
type fakeSystem struct {
	sandbox
	fakebin, log, root, unit, dataHome, data, tmp, cgroup, ufwConf, linger string
}

// fakeSudo runs the command unprivileged, and only on paths inside the sandbox:
// a test that forgot to point a path into the sandbox fails here instead of
// reaching the real file.
const fakeSudo = `#!/bin/bash
[ "$1" = -n ] && shift
[ "$1" = -v ] && exit 0
for a in "${@:2}"; do
    case "$a" in
        /*) case "$a" in "$FAKE_SANDBOX"/*) ;; *) echo "fake sudo: refusing $a, outside the sandbox" >&2; exit 1 ;; esac ;;
    esac
done
export FAKE_SUDO=1
exec "$@"
`

// fakeTool logs its command line; systemctl is-active answers from $FAKE_ACTIVE,
// and a command line containing $FAKE_FAIL fails. `systemctl stop` also records
// whether $FAKE_WATCH still exists at that moment.
const fakeTool = `#!/bin/bash
name=$(basename "$0")
line="${FAKE_SUDO:+sudo }$name $*"
if [ "$name" = systemctl ] && [ "${*: -1}" = webterm ] && [[ " $* " == *" stop "* ]] && [ -n "${FAKE_WATCH:-}" ]; then
    if [ -e "$FAKE_WATCH" ]; then line="$line [data present]"; else line="$line [data gone]"; fi
fi
echo "$line" >> "$FAKE_LOG"
if [ -n "${FAKE_FAIL:-}" ] && [[ "$*" == *"$FAKE_FAIL"* ]]; then exit 1; fi
if [ "$name" = systemctl ] && [[ " $* " == *" is-active "* ]]; then
    unit="${*: -1}"
    [[ " $* " == *" --user "* ]] && unit="user:$unit"
    [[ " ${FAKE_ACTIVE:-} " == *" $unit "* ]]
    exit
fi
exit 0
`

// fakeID reports root when $FAKE_ROOT=1, otherwise the real id.
const fakeID = `#!/bin/bash
if [ "${FAKE_ROOT:-}" = 1 ] && [ "$1" = -u ]; then echo 0; exit 0; fi
exec /usr/bin/id "$@"
`

func newFakeSystem(t *testing.T) fakeSystem {
	t.Helper()
	fs := fakeSystem{sandbox: newSandbox(t)}
	h := fs.home
	fs.fakebin = filepath.Join(h, "fakebin")
	fs.log = filepath.Join(h, "fake.log")
	fs.root = filepath.Join(h, "root")
	fs.unit = filepath.Join(fs.root, "etc", "systemd", "system", "webterm.service")
	fs.cgroup = filepath.Join(fs.root, "proc", "self", "cgroup")
	fs.ufwConf = filepath.Join(fs.root, "etc", "ufw", "ufw.conf")
	fs.linger = filepath.Join(fs.root, "var", "lib", "systemd", "linger")
	fs.dataHome = filepath.Join(h, "data-home")
	fs.data = filepath.Join(fs.dataHome, "webterm")
	fs.tmp = filepath.Join(h, "tmp")
	for _, d := range []string{fs.fakebin, filepath.Dir(fs.unit), fs.tmp, fs.prefix} {
		mustMkdir(t, d)
	}
	mustWrite(t, filepath.Join(fs.fakebin, "sudo"), fakeSudo, 0o755)
	for _, n := range []string{"systemctl", "loginctl", "ufw", "firewall-cmd"} {
		mustWrite(t, filepath.Join(fs.fakebin, n), fakeTool, 0o755)
	}
	mustWrite(t, filepath.Join(fs.fakebin, "id"), fakeID, 0o755)
	fs.setInside(t, false)
	return fs
}

// setInside writes the cgroup the script sees for itself.
func (fs fakeSystem) setInside(t *testing.T, inside bool) {
	t.Helper()
	cg := "0::/user.slice/user-1000.slice/session-1.scope\n"
	if inside {
		cg = "0::/system.slice/webterm.service\n"
	}
	mustWrite(t, fs.cgroup, cg, 0o644)
}

// run runs install.sh with a clean environment plus extra (KEY=value), detached
// from any controlling terminal.
func (fs fakeSystem) run(t *testing.T, extra []string, args ...string) (string, error) {
	t.Helper()
	cmd := exec.Command("bash", append([]string{installScript}, args...)...)
	cmd.Env = append([]string{
		"PATH=" + fs.fakebin + ":/usr/bin:/bin",
		"HOME=" + fs.home,
		"XDG_CONFIG_HOME=" + filepath.Join(fs.home, ".config"),
		"XDG_DATA_HOME=" + fs.dataHome,
		"TMPDIR=" + fs.tmp,
		"LANG=C",
		"FAKE_LOG=" + fs.log,
		"FAKE_SANDBOX=" + fs.home,
		"WEBTERM_PREFIX=" + fs.prefix,
		"WEBTERM_SYSROOT=" + fs.root,
		"WEBTERM_PUBLIC_IP=203.0.113.9",
	}, extra...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// calls returns the fake tools' log, one command line per entry.
func (fs fakeSystem) calls(t *testing.T) []string {
	t.Helper()
	b, err := os.ReadFile(fs.log)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSpace(string(b)), "\n")
}

// writeUnit writes a system unit that runs execPath as this user.
func (fs fakeSystem) writeUnit(t *testing.T, execPath string) {
	t.Helper()
	me, err := exec.Command("id", "-un").Output()
	if err != nil {
		t.Fatal(err)
	}
	mustWrite(t, fs.unit, fmt.Sprintf("[Service]\nUser=%s\nExecStart=%s serve --domain t.example.com --https-port 8443\n",
		strings.TrimSpace(string(me)), execPath), 0o644)
}

func mustMkdir(t *testing.T, d string) {
	t.Helper()
	if err := os.MkdirAll(d, 0o755); err != nil {
		t.Fatal(err)
	}
}

func mustWrite(t *testing.T, p, body string, mode os.FileMode) {
	t.Helper()
	mustMkdir(t, filepath.Dir(p))
	if err := os.WriteFile(p, []byte(body), mode); err != nil {
		t.Fatal(err)
	}
}

func exists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

// indexOf returns the index of the first call containing s, or -1.
func indexOf(calls []string, s string) int {
	for i, c := range calls {
		if strings.Contains(c, s) {
			return i
		}
	}
	return -1
}
