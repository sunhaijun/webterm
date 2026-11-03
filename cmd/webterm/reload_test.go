package main

import (
	"errors"
	"flag"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/agent"
)

// fakeAgent answers on a control socket like a running agent. onReexec
// decides what the "new process" looks like; it runs after a short delay, as
// an exec would.
type fakeAgent struct {
	mu       sync.Mutex
	st       agent.ControlStatus
	requests [][]string
	onReexec func(st *agent.ControlStatus, args []string)
}

func startFakeAgent(t *testing.T, st agent.ControlStatus, onReexec func(*agent.ControlStatus, []string)) (dataDir string, f *fakeAgent) {
	t.Helper()
	dataDir = t.TempDir()
	if err := os.MkdirAll(filepath.Join(dataDir, "run"), 0o700); err != nil {
		t.Fatal(err)
	}
	f = &fakeAgent{st: st, onReexec: onReexec}
	cs, err := agent.ServeControl(controlSocketPath(dataDir), agent.ControlDeps{
		Status: func() agent.ControlStatus {
			f.mu.Lock()
			defer f.mu.Unlock()
			return f.st
		},
		Reexec: func(args []string) error {
			f.mu.Lock()
			f.requests = append(f.requests, args)
			f.mu.Unlock()
			time.AfterFunc(100*time.Millisecond, func() {
				f.mu.Lock()
				f.onReexec(&f.st, args)
				f.mu.Unlock()
			})
			return nil
		},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	return dataDir, f
}

func takeOver(st *agent.ControlStatus, args []string) {
	st.Generation++
	st.ExecArgs = true
	if args != nil {
		st.Args = args
	}
}

// A changed address reaches the running agent (ADR-0047 §1): reload hands it
// the new command line instead of letting it re-exec with its old one.
func TestReloadPassesNewCommandLine(t *testing.T) {
	dir, f := startFakeAgent(t, agent.ControlStatus{Handoff: true, ExecArgs: true, InstanceID: "i", PID: 1,
		Args: []string{"serve", "--domain", "old.example.com"}}, takeOver)
	newArgs := []string{"serve", "--domain", "new.example.com", "--https-port", "8443"}
	if err := runReload(append([]string{"--config", filepath.Join(dir, "none"), "--data-dir", dir, "--"}, newArgs...)); err != nil {
		t.Fatal(err)
	}
	if len(f.requests) != 1 || !slices.Equal(f.requests[0], newArgs) {
		t.Fatalf("reexec requests = %v, want one with %v", f.requests, newArgs)
	}
}

// An agent that predates command-line handoff re-execs with its old command
// line; the new binary it now runs takes the new one in a second hot upgrade.
func TestReloadUpgradesOldAgentInTwoSteps(t *testing.T) {
	dir, f := startFakeAgent(t, agent.ControlStatus{Handoff: true, InstanceID: "i", PID: 1}, takeOver)
	newArgs := []string{"serve", "--domain", "new.example.com"}
	if err := runReload(append([]string{"--config", filepath.Join(dir, "none"), "--data-dir", dir, "--"}, newArgs...)); err != nil {
		t.Fatal(err)
	}
	if len(f.requests) != 2 || f.requests[0] != nil || !slices.Equal(f.requests[1], newArgs) {
		t.Fatalf("reexec requests = %v, want [nil %v]", f.requests, newArgs)
	}
	if f.st.Generation != 2 || !slices.Equal(f.st.Args, newArgs) {
		t.Fatalf("final status = %+v", f.st)
	}
}

// A new binary that crashes after exec gets restarted by systemd with a new
// instance id: the sessions are gone, and reload must say so rather than
// "sessions are intact" (ADR-0047 §1).
func TestReloadReportsRestartAsLostSessions(t *testing.T) {
	dir, _ := startFakeAgent(t, agent.ControlStatus{Handoff: true, ExecArgs: true, InstanceID: "before", PID: 1},
		func(st *agent.ControlStatus, _ []string) {
			st.InstanceID, st.PID, st.Generation = "after", 2, 0
		})
	err := runReload([]string{"--config", filepath.Join(dir, "none"), "--data-dir", dir})
	if err == nil || !strings.Contains(err.Error(), "sessions were lost") {
		t.Fatalf("err = %v, want it to report lost sessions", err)
	}
}

// A failed hot upgrade's reason is cleared by the next request; otherwise
// reload reports the old failure as the new attempt's straight away.
func TestUpgradeRequestClearsLastError(t *testing.T) {
	u := newUpgrades()
	u.failed(errors.New("preflight failed"))
	if u.lastError() == "" {
		t.Fatal("failure not recorded")
	}
	if err := u.request(nil); err != nil {
		t.Fatal(err)
	}
	if got := u.lastError(); got != "" {
		t.Fatalf("lastError = %q after a new request, want empty", got)
	}
	if err := u.request(nil); err == nil {
		t.Fatal("a second request while one is pending must be refused")
	}
	if err := newUpgrades().request([]string{"pair"}); err == nil {
		t.Fatal("a command line that isn't serve must be refused")
	}
}

// handoff-check parses the new process's command line and the config file
// like serve would, so a key the new binary rejects fails the preflight
// instead of crash-looping after exec (ADR-0047 §1).
func TestServeArgsCheckedBeforeExec(t *testing.T) {
	bad := filepath.Join(t.TempDir(), "config")
	if err := os.WriteFile(bad, []byte("acme-staging = true\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := parseServe([]string{"--config", bad, "--domain", "x.example.com"}, flag.ContinueOnError); err == nil {
		t.Fatal("a removed config key passed the check")
	}
	empty := filepath.Join(t.TempDir(), "none")
	if _, _, err := parseServe([]string{"--config", empty}, flag.ContinueOnError); err == nil {
		t.Fatal("production without --domain passed the check")
	}
	if _, _, err := parseServe([]string{"--config", empty, "--domain", "x.example.com", "--bogus"}, flag.ContinueOnError); err == nil {
		t.Fatal("an unknown flag passed the check")
	}
	if _, _, err := parseServe([]string{"--config", empty, "--domain", "x.example.com"}, flag.ContinueOnError); err != nil {
		t.Fatalf("a good command line failed: %v", err)
	}
}

// --domain is case-insensitive: browsers send the Origin host in lowercase,
// so a domain typed with capitals would refuse every WebSocket.
func TestDomainIsNormalized(t *testing.T) {
	empty := filepath.Join(t.TempDir(), "none")
	c, _, err := parseServe([]string{"--config", empty, "--domain", "Term.Example.COM."}, flag.ContinueOnError)
	if err != nil {
		t.Fatal(err)
	}
	if c.domain != "term.example.com" {
		t.Fatalf("domain = %q, want term.example.com", c.domain)
	}
}
