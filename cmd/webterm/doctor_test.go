package main

import (
	"bytes"
	"context"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/agent"
)

// No permission is not the same as busy: a fresh binary without setcap always gets
// EACCES on port 80, and that must not block an install.
func TestClassifyPortErr(t *testing.T) {
	eacces := &net.OpError{Op: "listen", Err: os.NewSyscallError("bind", syscall.EACCES)}
	eaddrinuse := &net.OpError{Op: "listen", Err: os.NewSyscallError("bind", syscall.EADDRINUSE)}
	free := func(int) bool { return false }
	taken := func(int) bool { return true }

	t.Run("no permission, port free: warning only", func(t *testing.T) {
		_, err := classifyPortErr(80, eacces, free)
		var w warning
		if !errors.As(err, &w) {
			t.Fatalf("want a warning, got %T: %v", err, err)
		}
		if !strings.Contains(w.msg, "setcap") {
			t.Errorf("warning should mention setcap: %s", w.msg)
		}
	})
	t.Run("no permission, port taken: failure", func(t *testing.T) {
		_, err := classifyPortErr(80, eacces, taken)
		var w warning
		if errors.As(err, &w) || err == nil || !strings.Contains(err.Error(), "in use") {
			t.Errorf("want an in-use failure, got %v", err)
		}
	})
	t.Run("EADDRINUSE: failure without probing", func(t *testing.T) {
		_, err := classifyPortErr(8443, eaddrinuse, free)
		var w warning
		if errors.As(err, &w) || err == nil || !strings.Contains(err.Error(), "in use") {
			t.Errorf("want an in-use failure, got %v", err)
		}
	})
}

func TestPortBusy(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	if !portBusy(port) {
		t.Errorf("port %d is listening but reported free", port)
	}
	ln.Close()
	if portBusy(port) {
		t.Errorf("port %d is closed but reported busy", port)
	}
}

type issueFunc func(context.Context, agent.ServeConfig) (*x509.Certificate, bool, error)

// doctorRun configures one doctor run with fakes for everything external.
type doctorRun struct {
	dataDir string
	public  string
	issue   issueFunc
	hosts   func(string) ([]string, error)
	tty     string // input typed at the terminal; "" with noTTY=false means an empty terminal
	noTTY   bool
}

func (r doctorRun) run(t *testing.T, args ...string) (string, error) {
	t.Helper()
	var buf bytes.Buffer
	oldOut, oldIP, oldIssue, oldHost, oldTTY, oldVendor, oldInterval := doctorOut, lookupPublicIP, issueCheck, lookupHost, openTTY, cloudVendor, dnsPollInterval
	t.Cleanup(func() {
		doctorOut, lookupPublicIP, issueCheck, lookupHost, openTTY, cloudVendor, dnsPollInterval = oldOut, oldIP, oldIssue, oldHost, oldTTY, oldVendor, oldInterval
	})

	doctorOut = &buf
	lookupPublicIP = func() (string, error) { return r.public, nil }
	if r.issue != nil {
		issueCheck = r.issue
	}
	lookupHost = func(h string) ([]string, error) { return nil, errors.New("no such host") }
	if r.hosts != nil {
		lookupHost = r.hosts
	}
	openTTY = func() (io.ReadCloser, error) {
		if r.noTTY {
			return nil, errors.New("no tty")
		}
		return io.NopCloser(strings.NewReader(r.tty)), nil
	}
	cloudVendor = func() string { return "" }
	dnsPollInterval = time.Millisecond

	t.Setenv("XDG_CONFIG_HOME", t.TempDir()) // don't read the developer's real config
	dataDir := r.dataDir
	if dataDir == "" {
		dataDir = t.TempDir()
	}
	ports := freeTCPPorts(t, 2)
	base := []string{"--data-dir", dataDir,
		"--http-port", strconv.Itoa(ports[0]), "--https-port", strconv.Itoa(ports[1])}
	err := runDoctor(append(base, args...))
	return buf.String(), err
}

func freeTCPPorts(t *testing.T, n int) []int {
	t.Helper()
	var lns []net.Listener
	defer func() {
		for _, l := range lns {
			l.Close()
		}
	}()
	var ports []int
	for range n {
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		lns = append(lns, l)
		ports = append(ports, l.Addr().(*net.TCPAddr).Port)
	}
	return ports
}

var unreachable = &agent.IssueError{Diagnosis: "the CA couldn't connect (security group?)", Unreachable: true}

// UT-doctor-ip: IP mode checks "--domain == public IP" instead of DNS.
func TestDoctorIPMode(t *testing.T) {
	out, err := doctorRun{public: "203.0.113.7", noTTY: true}.run(t, "--domain", "203.0.113.7")
	if err != nil {
		t.Fatalf("matching IP should pass: %v\n%s", err, out)
	}
	if strings.Contains(out, "DNS") || !strings.Contains(out, "✓ Public IP") {
		t.Errorf("IP mode output:\n%s", out)
	}

	out, err = doctorRun{public: "198.51.100.9", noTTY: true}.run(t, "--domain", "203.0.113.7")
	if err == nil {
		t.Fatalf("a different public IP should fail:\n%s", out)
	}
	for _, want := range []string{"198.51.100.9", "pair again", "NAT"} {
		if !strings.Contains(out, want) {
			t.Errorf("mismatch explanation lacks %q:\n%s", want, out)
		}
	}
}

func TestDoctorRejectsIPv6(t *testing.T) {
	out, err := doctorRun{noTTY: true}.run(t, "--domain", "2001:db8::1")
	if err == nil || !strings.Contains(out, "IPv4") {
		t.Fatalf("IPv6 should be rejected with a reason, err=%v\n%s", err, out)
	}
}

// --acme obtains the real certificate into the service's certs/ (not a temp dir,
// not staging); a cached certificate is reported honestly; without --acme the
// summary says the cloud firewall can't be checked from inside.
func TestDoctorACME(t *testing.T) {
	var called agent.ServeConfig
	issued := true
	issue := func(_ context.Context, cfg agent.ServeConfig) (*x509.Certificate, bool, error) {
		called = cfg
		return &x509.Certificate{NotAfter: time.Now().Add(160 * time.Hour)}, issued, nil
	}
	data := t.TempDir()
	out, err := doctorRun{dataDir: data, public: "203.0.113.7", issue: issue, noTTY: true}.run(t, "--domain", "203.0.113.7", "--acme")
	if err != nil {
		t.Fatalf("issued but failed: %v\n%s", err, out)
	}
	if want := filepath.Join(data, "certs"); called.CertDir != want {
		t.Errorf("cert dir = %q, want the service's %q", called.CertDir, want)
	}
	if called.ACMEDirectoryURL != "" {
		t.Errorf("production request went to %q", called.ACMEDirectoryURL)
	}
	if !strings.Contains(out, "✓ Certificate") || !strings.Contains(out, "the service will use it") {
		t.Errorf("missing certificate line:\n%s", out)
	}

	issued = false
	out, _ = doctorRun{dataDir: data, public: "203.0.113.7", issue: issue, noTTY: true}.run(t, "--domain", "203.0.113.7", "--acme")
	if !strings.Contains(out, "reachability wasn't tested") {
		t.Errorf("a cached certificate must say reachability wasn't tested:\n%s", out)
	}

	fail := func(context.Context, agent.ServeConfig) (*x509.Certificate, bool, error) {
		return nil, false, unreachable
	}
	out, err = doctorRun{public: "203.0.113.7", issue: fail, noTTY: true}.run(t, "--domain", "203.0.113.7", "--acme")
	if err == nil || !strings.Contains(out, "✗ Certificate") || !strings.Contains(out, "security group") {
		t.Fatalf("an unreachable CA should fail with the diagnosis, err=%v\n%s", err, out)
	}

	called = agent.ServeConfig{}
	out, _ = doctorRun{public: "198.51.100.9", issue: issue, noTTY: true}.run(t, "--domain", "203.0.113.7", "--acme")
	if called.Domain != "" || !strings.Contains(out, "skipped") {
		t.Errorf("must not request a certificate while other checks fail:\n%s", out)
	}

	out, _ = doctorRun{public: "203.0.113.7", noTTY: true}.run(t, "--domain", "203.0.113.7")
	if !strings.Contains(out, "--acme") || !strings.Contains(out, "firewall") {
		t.Errorf("without --acme the summary should explain the firewall can't be checked:\n%s", out)
	}
}

// ADR-0046: guided, an unreachable CA leads to firewall instructions, a wait for
// Enter, a staging re-check in a temp dir, and only then the real request.
func TestDoctorGuidedFirewall(t *testing.T) {
	var calls []agent.ServeConfig
	probes := 0
	issue := func(_ context.Context, cfg agent.ServeConfig) (*x509.Certificate, bool, error) {
		calls = append(calls, cfg)
		switch {
		case cfg.ACMEDirectoryURL == "" && len(calls) == 1:
			return nil, false, unreachable // first real attempt: firewall closed
		case cfg.ACMEDirectoryURL != "":
			probes++
			if probes == 1 {
				return nil, false, unreachable // user pressed Enter too early
			}
			return &x509.Certificate{NotAfter: time.Now().Add(time.Hour)}, true, nil
		}
		return &x509.Certificate{NotAfter: time.Now().Add(160 * time.Hour)}, true, nil
	}
	data := t.TempDir()
	out, err := doctorRun{dataDir: data, public: "203.0.113.7", issue: issue, tty: "\n\n"}.run(t,
		"--domain", "203.0.113.7", "--acme", "--guide")
	if err != nil {
		t.Fatalf("guided flow should end in success: %v\n%s", err, out)
	}
	for _, want := range []string{"Allow inbound TCP", "Press Enter", "Still can't reach", "Reachable", "✓ Certificate"} {
		if !strings.Contains(out, want) {
			t.Errorf("guided output lacks %q:\n%s", want, out)
		}
	}
	if len(calls) != 4 {
		t.Fatalf("want real, probe, probe, real; got %d calls", len(calls))
	}
	for _, i := range []int{1, 2} {
		if calls[i].ACMEDirectoryURL != letsEncryptStaging || calls[i].CertDir == filepath.Join(data, "certs") {
			t.Errorf("probe %d must use staging and a temp dir: %+v", i, calls[i])
		}
	}
	if last := calls[3]; last.ACMEDirectoryURL != "" || last.CertDir != filepath.Join(data, "certs") {
		t.Errorf("the final request must be production into certs/: %+v", last)
	}
}

// Guided but the terminal closes (EOF): give up with the original diagnosis.
func TestDoctorGuidedGivesUpOnEOF(t *testing.T) {
	fail := func(context.Context, agent.ServeConfig) (*x509.Certificate, bool, error) {
		return nil, false, unreachable
	}
	out, err := doctorRun{public: "203.0.113.7", issue: fail, tty: ""}.run(t, "--domain", "203.0.113.7", "--acme", "--guide")
	if err == nil || !strings.Contains(out, "✗ Certificate") {
		t.Fatalf("EOF on the terminal should fail, err=%v\n%s", err, out)
	}
}

// --guide without a terminal behaves like a plain check.
func TestDoctorGuideWithoutTTY(t *testing.T) {
	fail := func(context.Context, agent.ServeConfig) (*x509.Certificate, bool, error) {
		return nil, false, unreachable
	}
	out, err := doctorRun{public: "203.0.113.7", issue: fail, noTTY: true}.run(t, "--domain", "203.0.113.7", "--acme", "--guide")
	if err == nil || strings.Contains(out, "Press Enter") {
		t.Fatalf("no terminal: fail once, don't prompt; err=%v\n%s", err, out)
	}
}

// Guided DNS: show the exact record, then poll until it resolves here.
func TestDoctorGuidedDNS(t *testing.T) {
	lookups := 0
	hosts := func(string) ([]string, error) {
		lookups++
		if lookups < 3 {
			return []string{"198.51.100.1"}, nil
		}
		return []string{"203.0.113.7"}, nil
	}
	out, err := doctorRun{public: "203.0.113.7", hosts: hosts, tty: ""}.run(t, "--domain", "term.example.com", "--guide")
	if err != nil {
		t.Fatalf("DNS eventually points here: %v\n%s", err, out)
	}
	for _, want := range []string{"points to 198.51.100.1", "Type   A", "Value  203.0.113.7", "Waiting for the record", "✓ DNS (term.example.com → 203.0.113.7)"} {
		if !strings.Contains(out, want) {
			t.Errorf("guided DNS output lacks %q:\n%s", want, out)
		}
	}

	out, err = doctorRun{public: "203.0.113.7", hosts: func(string) ([]string, error) { return nil, errors.New("no such host") }, noTTY: true}.run(t, "--domain", "term.example.com")
	if err == nil || !strings.Contains(out, "Add this record") || strings.Contains(out, "Waiting") {
		t.Errorf("unguided: fail once with the record to add, err=%v\n%s", err, out)
	}
}

func TestFirewallAdvice(t *testing.T) {
	got := firewallAdvice("203.0.113.7", 80, 443, "Alibaba Cloud: ECS console → Security Groups → Inbound rules")
	for _, want := range []string{"http://203.0.113.7/", "TCP 80 and 443", "Alibaba Cloud"} {
		if !strings.Contains(got, want) {
			t.Errorf("advice lacks %q:\n%s", want, got)
		}
	}
	if got := firewallAdvice("term.example.com", 8080, 8443, ""); !strings.Contains(got, "term.example.com:8080") || !strings.Contains(got, "Security groups") {
		t.Errorf("generic advice with a custom port:\n%s", got)
	}
}
