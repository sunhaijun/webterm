package main

import (
	"os"
	"os/exec"
	"os/user"
	"strings"
	"testing"
)

// UT-install-unit (ADR-0034): install.sh --print-unit prints the system unit
// without network or sudo. Every asserted line matters: without the OOM lines the
// migration is pointless, and %U instead of the literal UID would be 0 (PID 1's)
// and break systemctl --user inside sessions.
func TestInstallScriptPrintUnit(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("install.sh refuses to run as root")
	}
	u, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	g, err := user.LookupGroupId(u.Gid)
	if err != nil {
		t.Fatal(err)
	}

	out, err := exec.Command("bash", "../../scripts/install.sh", "--print-unit",
		"--domain", "term.example.com", "--https-port", "8443").CombinedOutput()
	if err != nil {
		t.Fatalf("install.sh --print-unit: %v\n%s", err, out)
	}
	unit := string(out)

	// Only effective lines: the comments mention %U to explain why it is not used.
	lines := map[string]bool{}
	var body strings.Builder
	for _, l := range strings.Split(unit, "\n") {
		l = strings.TrimSpace(l)
		if strings.HasPrefix(l, "#") {
			continue
		}
		lines[l] = true
		body.WriteString(l + "\n")
	}
	for _, want := range []string{
		"[Service]",
		"User=" + u.Username,
		"Group=" + g.Name,
		"ExecStart=/usr/local/bin/webterm serve --domain term.example.com --https-port 8443",
		"OOMScoreAdjust=-900",
		"OOMPolicy=continue",
		"Environment=XDG_RUNTIME_DIR=/run/user/" + u.Uid,
		"Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/" + u.Uid + "/bus",
		"Wants=network-online.target user@" + u.Uid + ".service",
		"After=network-online.target user@" + u.Uid + ".service",
		"ExecReload=/bin/kill -USR2 $MAINPID",
		"KillMode=mixed",
		"WantedBy=multi-user.target",
	} {
		if !lines[want] {
			t.Errorf("unit lacks line: %s", want)
		}
	}
	for _, bad := range []string{"%U", "%u", "default.target"} {
		if strings.Contains(body.String(), bad) {
			t.Errorf("unit must not contain %q", bad)
		}
	}
	// Only the unit: no output from install steps.
	if strings.Contains(unit, "Checking this machine") || strings.Contains(unit, "Downloading") {
		t.Errorf("--print-unit ran install steps:\n%s", unit)
	}
}
