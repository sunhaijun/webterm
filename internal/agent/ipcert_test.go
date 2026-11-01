package agent_test

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/acmetest"
	"github.com/sunhaijun/webterm/internal/agent"
	"github.com/sunhaijun/webterm/internal/session"
	"github.com/sunhaijun/webterm/internal/store"
)

// IT-tls-4..6: IP mode (ADR-0044). Uses the local fake CA, like acme_test.go.

const testIP = "203.0.113.7"

type ipFixture struct {
	ca        *acmetest.Server
	report    *lockedBuffer
	certDir   string
	httpPort  int
	httpsPort int
	shutdown  func()
}

// startIP starts an IP-mode agent through the production path. certDir and
// ports can be reused across two starts to test restarts.
func startIP(t *testing.T, ca *acmetest.Server, certDir string, ports []int) *ipFixture {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	sessions := session.NewManager(session.Config{MaxSessions: 1, RingBytes: 1 << 16, Shell: "bash"})
	report := &lockedBuffer{}
	a := agent.New(agent.Config{
		Domain: testIP, Version: "test",
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		CertReport: report,
	}, st, sessions)
	servers, _, err := a.Listen(agent.ServeConfig{
		Domain: testIP, Bind: "127.0.0.1",
		HTTPPort: ports[0], HTTPSPort: ports[1],
		CertDir: certDir, ACMEDirectoryURL: ca.DirectoryURL(),
	}, a.Handler())
	if err != nil {
		t.Fatal(err)
	}
	f := &ipFixture{ca: ca, report: report, certDir: certDir, httpPort: ports[0], httpsPort: ports[1]}
	var once bool
	f.shutdown = func() {
		if once {
			return
		}
		once = true
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		servers.Shutdown(ctx)
		sessions.Shutdown()
		st.Close()
	}
	t.Cleanup(f.shutdown)
	return f
}

func newCA(t *testing.T) *acmetest.Server {
	t.Helper()
	ca, err := acmetest.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(ca.Close)
	ca.SetLogf(t.Logf)
	return ca
}

// dialNoSNI handshakes the way a browser connecting to an IP does: ServerName
// is an IP, which Go leaves out of SNI, and verification checks the
// certificate's IP SAN.
func dialNoSNI(t *testing.T, ca *acmetest.Server, port int) *tls.ConnectionState {
	t.Helper()
	cfg := ca.TLSClientConfig(testIP)
	conn, err := tls.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", port), cfg)
	if err != nil {
		t.Fatalf("handshake without SNI failed: %v", err)
	}
	defer conn.Close()
	st := conn.ConnectionState()
	return &st
}

// IT-tls-4: the order has an ip identifier and the shortlived profile, the
// certificate has an IP SAN, and a handshake without SNI verifies against the
// CA.
func TestIPModeIssuesShortlivedIPCertificate(t *testing.T) {
	ca := newCA(t)
	ca.SetCertLifetime(160 * time.Hour)
	ports := freePorts(t, 2)
	ca.ValidateAgainst(fmt.Sprintf("127.0.0.1:%d", ports[0]))
	f := startIP(t, ca, filepath.Join(t.TempDir(), "certs"), ports)

	waitFor(t, "certificate ready", func() bool { return strings.Contains(f.report.String(), "Certificate ready") })
	report := f.report.String()
	if !strings.Contains(report, "IP certificate") {
		t.Errorf("report doesn't say this is an IP certificate: %q", report)
	}
	// A 6-day certificate needs the expiry down to the hour; a date alone
	// doesn't say when on that day it expires.
	wantExp := time.Now().Add(160 * time.Hour).Local().Format("2006-01-02 15")
	if !strings.Contains(report, wantExp) {
		t.Errorf("report should give the expiry as %s:xx: %q", wantExp, report)
	}

	orders := ca.Orders()
	if len(orders) != 1 || orders[0].Type != "ip" || orders[0].Value != testIP || orders[0].Profile != "shortlived" {
		t.Fatalf("CA orders = %+v, want one with ip=%s and profile=shortlived", orders, testIP)
	}

	st := dialNoSNI(t, ca, f.httpsPort)
	leaf := st.PeerCertificates[0]
	if len(leaf.IPAddresses) != 1 || leaf.IPAddresses[0].String() != testIP {
		t.Errorf("certificate IP SAN = %v, want [%s]", leaf.IPAddresses, testIP)
	}

	// Cached on disk with mode 0600, in autocert's format (the status overview
	// reads certs/<ip>).
	info, err := os.Stat(filepath.Join(f.certDir, testIP))
	if err != nil {
		t.Fatalf("certificate not stored: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("certificate cache mode = %o, want 600 (it holds the private key)", perm)
	}
}

// IP mode does not advertise acme-tls/1: it uses HTTP-01 only (ADR-0044 §2).
// Advertising it would be useless to the CA and only suggest to scanners
// that TLS-ALPN-01 works here.
func TestIPModeDoesNotAdvertiseACMEALPN(t *testing.T) {
	ca := newCA(t)
	ports := freePorts(t, 2)
	ca.ValidateAgainst(fmt.Sprintf("127.0.0.1:%d", ports[0]))
	f := startIP(t, ca, filepath.Join(t.TempDir(), "certs"), ports)
	waitFor(t, "certificate ready", func() bool { return strings.Contains(f.report.String(), "Certificate ready") })

	cfg := ca.TLSClientConfig(testIP)
	cfg.NextProtos = []string{"acme-tls/1"}
	conn, err := tls.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", f.httpsPort), cfg)
	if err == nil {
		defer conn.Close()
		if got := conn.ConnectionState().NegotiatedProtocol; got == "acme-tls/1" {
			t.Error("IP mode negotiated acme-tls/1")
		}
	}
}

// IT-tls-5: a restart reads the cache and does not contact the CA (the "5 per
// week for the same names" limit can't afford an issuance per restart).
func TestIPModeRestartReusesCache(t *testing.T) {
	ca := newCA(t)
	ca.SetCertLifetime(160 * time.Hour)
	ports := freePorts(t, 2)
	ca.ValidateAgainst(fmt.Sprintf("127.0.0.1:%d", ports[0]))
	certDir := filepath.Join(t.TempDir(), "certs")

	first := startIP(t, ca, certDir, ports)
	waitFor(t, "first certificate ready", func() bool { return strings.Contains(first.report.String(), "Certificate ready") })
	first.shutdown()
	ordersBefore := len(ca.Orders())

	second := startIP(t, ca, certDir, ports)
	waitFor(t, "certificate ready after restart", func() bool { return strings.Contains(second.report.String(), "Certificate ready") })
	if n := len(ca.Orders()); n != ordersBefore {
		t.Errorf("restart placed %d new orders; it should use the cache", n-ordersBefore)
	}
	dialNoSNI(t, ca, second.httpsPort)
}

// IT-tls-6: at renewal time a new certificate replaces the old one, and
// handshakes get the new one.
//
// The fake CA backdates NotBefore by 1 minute, so a lifetime L gives a total
// span of L+60s and renewal at NotAfter - (L+60)/3. With L=33s renewal is due
// about 2 seconds after issuance.
func TestIPModeRenewsBeforeExpiry(t *testing.T) {
	ca := newCA(t)
	ca.SetCertLifetime(33 * time.Second)
	ports := freePorts(t, 2)
	ca.ValidateAgainst(fmt.Sprintf("127.0.0.1:%d", ports[0]))
	f := startIP(t, ca, filepath.Join(t.TempDir(), "certs"), ports)
	waitFor(t, "certificate ready", func() bool { return strings.Contains(f.report.String(), "Certificate ready") })
	firstSerial := dialNoSNI(t, ca, f.httpsPort).PeerCertificates[0].SerialNumber

	waitFor(t, "renewal issues a second certificate", func() bool { return len(ca.Issued()) >= 2 })
	waitFor(t, "handshake gets the new certificate", func() bool {
		return dialNoSNI(t, ca, f.httpsPort).PeerCertificates[0].SerialNumber.Cmp(firstSerial) != 0
	})
}

// When the challenge can't get in, IP mode gives the IP diagnosis (port 80
// only, no DNS).
func TestIPModeFailureIsDiagnosable(t *testing.T) {
	ca := newCA(t) // no ValidateAgainst: validation always fails, like a security group blocking 80
	f := startIP(t, ca, filepath.Join(t.TempDir(), "certs"), freePorts(t, 2))
	waitFor(t, "failure diagnosis", func() bool { return strings.Contains(f.report.String(), "security group") })
	got := f.report.String()
	if !strings.Contains(got, "port 80 only") || strings.Contains(got, "dig +short") {
		t.Errorf("wrong IP-mode failure diagnosis:\n%s", got)
	}
	// A handshake never triggers issuance: with no certificate the handshake
	// fails and the CA gets no new order.
	before := len(ca.Orders())
	if conn, err := tls.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", f.httpsPort), ca.TLSClientConfig(testIP)); err == nil {
		conn.Close()
		t.Error("handshake succeeded without a certificate")
	}
	time.Sleep(100 * time.Millisecond)
	if after := len(ca.Orders()); after != before {
		t.Errorf("handshake triggered issuance (orders %d → %d)", before, after)
	}
}

// A CA without profile support (no IP certificates) gets a clear message.
func TestIPModeCAWithoutProfiles(t *testing.T) {
	ca := newCA(t)
	ca.SetProfiles(nil)
	ports := freePorts(t, 2)
	ca.ValidateAgainst(fmt.Sprintf("127.0.0.1:%d", ports[0]))
	f := startIP(t, ca, filepath.Join(t.TempDir(), "certs"), ports)
	waitFor(t, "failure diagnosis", func() bool { return strings.Contains(f.report.String(), "does not issue IP certificates") })
}

// IT-doctor-acme-1..2: the issuance core of doctor --acme. Both modes issue,
// the certificate lands in the given cert dir (the service's certs/), and the
// ports are released on return. A second run uses the cache and the CA gets
// no new order: the certificate is kept for the service, nothing extra is
// issued.
func TestIssueCheck(t *testing.T) {
	for _, tc := range []struct{ name, addr string }{
		{"domain", "term.test"},
		{"IP", testIP},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ca := newCA(t)
			ports := freePorts(t, 2)
			ca.ValidateAgainst(fmt.Sprintf("127.0.0.1:%d", ports[0]))
			dir := filepath.Join(t.TempDir(), "certs")
			cfg := agent.ServeConfig{
				Domain: tc.addr, Bind: "127.0.0.1", HTTPPort: ports[0], HTTPSPort: ports[1],
				CertDir: dir, ACMEDirectoryURL: ca.DirectoryURL(),
			}
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			leaf, issued, err := agent.IssueCheck(ctx, cfg)
			if err != nil {
				t.Fatalf("issuance failed: %v", err)
			}
			if !issued {
				t.Error("first run should issue a new certificate")
			}
			if err := leaf.VerifyHostname(tc.addr); err != nil {
				t.Errorf("issued certificate is not valid for %s: %v", tc.addr, err)
			}
			if _, err := os.Stat(filepath.Join(dir, tc.addr)); err != nil {
				t.Errorf("certificate not in the cert dir (the service uses it directly): %v", err)
			}
			for _, p := range ports {
				ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
				if err != nil {
					t.Errorf("port %d still held after IssueCheck returned: %v", p, err)
					continue
				}
				ln.Close()
			}

			orders := len(ca.Orders())
			again, issued, err := agent.IssueCheck(ctx, cfg)
			if err != nil {
				t.Fatalf("second run failed: %v", err)
			}
			if issued || len(ca.Orders()) != orders {
				t.Errorf("issued again despite a valid cached certificate (issued=%v, orders %d → %d)", issued, orders, len(ca.Orders()))
			}
			if again.SerialNumber.Cmp(leaf.SerialNumber) != 0 {
				t.Error("second run did not return the cached certificate")
			}
		})
	}

	t.Run("challenge cannot get in", func(t *testing.T) {
		ca := newCA(t)
		ports := freePorts(t, 2)
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_, _, err := agent.IssueCheck(ctx, agent.ServeConfig{
			Domain: testIP, Bind: "127.0.0.1", HTTPPort: ports[0], HTTPSPort: ports[1],
			CertDir: t.TempDir(), ACMEDirectoryURL: ca.DirectoryURL(),
		})
		if err == nil {
			t.Fatal("issued even though the challenge could not get in")
		}
		// doctor prints this error verbatim, so it must itself say what
		// happened and how to fix it.
		if !strings.Contains(err.Error(), "security group") {
			t.Errorf("IssueCheck failure is not a readable diagnosis: %v", err)
		}
		// A guided install waits for the user only on reachability failures (ADR-0046).
		if !agent.IsUnreachable(err) {
			t.Errorf("a challenge that can't get in must count as unreachable: %v", err)
		}
	})

	t.Run("CA without IP support is not a reachability problem", func(t *testing.T) {
		ca := newCA(t)
		ca.SetProfiles(nil)
		ports := freePorts(t, 2)
		ca.ValidateAgainst(fmt.Sprintf("127.0.0.1:%d", ports[0]))
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_, _, err := agent.IssueCheck(ctx, agent.ServeConfig{
			Domain: testIP, Bind: "127.0.0.1", HTTPPort: ports[0], HTTPSPort: ports[1],
			CertDir: t.TempDir(), ACMEDirectoryURL: ca.DirectoryURL(),
		})
		if err == nil || agent.IsUnreachable(err) {
			t.Errorf("want a non-reachability failure, got %v", err)
		}
	})
}
