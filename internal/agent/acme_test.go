package agent_test

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
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

// IT-tls-1..3 (docs/70-testing/strategy.md): automated evidence that the
// ACME path works.
//
// Uses the local fake CA in internal/acmetest rather than pebble; that
// package's doc comment explains why and what it does and doesn't prove.

const testDomain = "term.test"

// acmeFixture is a fake CA plus an agent listening through the real
// production path.
type acmeFixture struct {
	ca        *acmetest.Server
	report    *lockedBuffer
	certDir   string
	httpPort  int
	httpsPort int
}

// fixtureOpts tunes the fixture.
type fixtureOpts struct {
	// failChallenge makes the fake CA's validation always fail (simulating a
	// security group that blocks 80).
	failChallenge bool
	// certLifetime is the issued certificate lifetime, used to check that the
	// reported expiry date is real.
	certLifetime time.Duration
	tune         func(*agent.ServeConfig)
}

// newACMEFixture starts listening with a ServeConfig.
func newACMEFixture(t *testing.T, o fixtureOpts) *acmeFixture {
	t.Helper()

	ca, err := acmetest.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(ca.Close)
	ca.SetLogf(t.Logf)
	if o.certLifetime > 0 {
		ca.SetCertLifetime(o.certLifetime)
	}

	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	sessions := session.NewManager(session.Config{MaxSessions: 1, RingBytes: 1 << 16, Shell: "bash"})
	t.Cleanup(sessions.Shutdown)

	report := &lockedBuffer{}
	a := agent.New(agent.Config{
		Domain:     testDomain,
		Version:    "test",
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		CertReport: report,
	}, st, sessions)

	ports := freePorts(t, 2)
	f := &acmeFixture{
		ca:        ca,
		report:    report,
		certDir:   filepath.Join(dir, "certs"),
		httpPort:  ports[0],
		httpsPort: ports[1],
	}

	cfg := agent.ServeConfig{
		Domain:           testDomain,
		Bind:             "127.0.0.1",
		HTTPPort:         f.httpPort,
		HTTPSPort:        f.httpsPort,
		CertDir:          f.certDir,
		ACMEDirectoryURL: ca.DirectoryURL(),
	}
	if o.tune != nil {
		o.tune(&cfg)
	}

	// The fake CA validates by connecting straight to the local :80, so
	// term.test never has to resolve; that is the main reason for not using
	// pebble.
	//
	// Set this before Listen: the warm-up is asynchronous, so setting it
	// later races.
	if !o.failChallenge {
		ca.ValidateAgainst(fmt.Sprintf("127.0.0.1:%d", f.httpPort))
	}

	servers, _, err := a.Listen(cfg, a.Handler())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		servers.Shutdown(ctx)
	})
	return f
}

// waitReport waits for the warm-up result to reach CertReport (the warm-up
// is asynchronous).
func (f *acmeFixture) waitReport(t *testing.T, want string) string {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if got := f.report.String(); strings.Contains(got, want) {
			return got
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %q; CertReport has only:\n%s", want, f.report.String())
	return ""
}

// freePort returns one free port. Use freePorts when you need more than one.
func freePort(t *testing.T) int {
	t.Helper()
	return freePorts(t, 1)[0]
}

// freePorts allocates n distinct free ports at once.
//
// Calling freePort twice can return the same port: each Listen(:0) is closed
// right away and the kernel may hand the port out again, so http and https
// would occasionally collide and serve would reject them. Holding every
// listener until all ports are allocated avoids that.
func freePorts(t *testing.T, n int) []int {
	t.Helper()
	lns := make([]net.Listener, 0, n)
	defer func() {
		for _, ln := range lns {
			ln.Close()
		}
	}()
	ports := make([]int, 0, n)
	for len(ports) < n {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		lns = append(lns, ln)
		ports = append(ports, ln.Addr().(*net.TCPAddr).Port)
	}
	return ports
}

// IT-tls-1: the full ACME flow really obtains a certificate, stores it,
// serves handshakes with it and reports its expiry.
func TestACMEIssuesRealCertificate(t *testing.T) {
	const lifetime = 47 * 24 * time.Hour // not 90 days, to prove the date isn't hard-coded
	f := newACMEFixture(t, fixtureOpts{certLifetime: lifetime})

	report := f.waitReport(t, "Certificate ready")
	// The reported expiry must be the certificate's real expiry, not a
	// placeholder: it is the user's only proof that it worked.
	wantDate := time.Now().Add(lifetime).Local().Format("2006-01-02")
	if !strings.Contains(report, wantDate) {
		t.Errorf("warm-up report should give expiry %s: %q", wantDate, report)
	}
	if !strings.Contains(report, "renews automatically") {
		t.Errorf("warm-up report doesn't mention renewal: %q", report)
	}

	// On the CA side, the issued name is --domain. The count is checked only
	// after the handshake; see the regression test at the end of this file.
	if issued := f.ca.Issued(); len(issued) == 0 || issued[0] != testDomain {
		t.Errorf("issued names = %v, want [%s]", issued, testDomain)
	}

	// The certificate is in CertDir, and the dir is 0700 (it holds the
	// private key).
	info, err := os.Stat(f.certDir)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o700 {
		t.Errorf("cert dir mode = %o, want 700", perm)
	}
	entries, err := os.ReadDir(f.certDir)
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, e := range entries {
		if strings.Contains(e.Name(), testDomain) {
			found = true
		}
	}
	if !found {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("no certificate stored for %s; dir has only %v", testDomain, names)
	}

	// A real handshake is the evidence that the certificate works; a file
	// alone is not.
	conn, err := tls.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", f.httpsPort),
		f.ca.TLSClientConfig(testDomain))
	if err != nil {
		t.Fatalf("TLS handshake failed: %v", err)
	}
	defer conn.Close()
	leaf := conn.ConnectionState().PeerCertificates[0]
	if err := leaf.VerifyHostname(testDomain); err != nil {
		t.Errorf("certificate doesn't cover %s: %v", testDomain, err)
	}
	if got := leaf.NotAfter.Local().Format("2006-01-02"); got != wantDate {
		t.Errorf("handshake certificate expires %s but the report says %s; they must match", got, wantDate)
	}

	// Non-challenge requests on :80 get a 301 to HTTPS (which also shows the
	// challenge handler doesn't swallow every route).
	noRedirect := &http.Client{
		Timeout:       5 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := noRedirect.Get(fmt.Sprintf("http://127.0.0.1:%d/", f.httpPort))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMovedPermanently {
		t.Errorf(":80 status = %d, want 301", resp.StatusCode)
	}
	if loc := resp.Header.Get("Location"); !strings.HasPrefix(loc, "https://"+testDomain) {
		t.Errorf("Location = %q, want prefix https://%s", loc, testDomain)
	}
}

// IT-tls-2: --dev never contacts the CA.
//
// "Nothing was issued" is too weak: a started-but-failed issuance passes it
// too. This asserts the fake CA received zero requests.
func TestDevModeNeverTouchesACME(t *testing.T) {
	f := newACMEFixture(t, fixtureOpts{tune: func(c *agent.ServeConfig) {
		c.Dev = true
	}})

	// Give a would-be certificate request enough time to start.
	time.Sleep(500 * time.Millisecond)

	if n := f.ca.Requests(); n != 0 {
		t.Errorf("--dev: CA received %d requests, want 0; dev mode must not request certificates", n)
	}
	if got := f.report.String(); got != "" {
		t.Errorf("--dev: unexpected certificate report: %q", got)
	}
	if _, err := os.Stat(f.certDir); !os.IsNotExist(err) {
		t.Errorf("--dev: cert dir %s should not be created (err=%v)", f.certDir, err)
	}

	// And it does serve plain HTTP.
	resp, err := (&http.Client{Timeout: 5 * time.Second}).
		Get(fmt.Sprintf("http://127.0.0.1:%d/healthz", f.httpPort))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("--dev /healthz = %d, want 200", resp.StatusCode)
	}
}

// IT-tls-3: when the challenge can't get in, the user gets a readable
// diagnosis (AC-1.13), not a raw Go error.
func TestACMEFailureIsDiagnosable(t *testing.T) {
	// Validation always fails, simulating a security group that blocks 80.
	f := newACMEFixture(t, fixtureOpts{failChallenge: true})

	report := f.waitReport(t, "The CA could not reach this machine to validate the domain")

	// The cloud security group is the step most often missed, so it must
	// come first.
	sgAt := strings.Index(report, "security group")
	dnsAt := strings.Index(report, "Does DNS point to this machine")
	if sgAt < 0 || dnsAt < 0 || sgAt > dnsAt {
		t.Errorf("security group should come before DNS; report:\n%s", report)
	}
	for _, want := range []string{
		"curl -sI http://" + testDomain, // copy-pasteable
		"dig +short " + testDomain,
		"Cloudflare", // the Cloudflare proxy is the second most common trap
	} {
		if !strings.Contains(report, want) {
			t.Errorf("diagnosis lacks %q; got:\n%s", want, report)
		}
	}
	// Must not be a single raw error line.
	if strings.Contains(report, "acme: authorization error") && !strings.Contains(report, "1.") {
		t.Errorf("diagnosis degraded to a raw error:\n%s", report)
	}

	// A failure must not leave a certificate on disk (half a certificate is
	// worse than none).
	entries, err := os.ReadDir(f.certDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), testDomain) {
			t.Errorf("issuance failed but certificate file %s was written", e.Name())
		}
	}
}

// The warm-up must hit the cache slot that real clients use.
//
// autocert's cache key includes isRSA = !supportsECDSA(hello), and
// supportsECDSA returns false for an empty ClientHelloInfo. Warming up with an
// empty hello would store an RSA certificate under "<domain>+rsa"; real
// browsers advertise ECDSA and use the key "<domain>", miss, and trigger
// another issuance inside the TLS handshake. Consequences:
//
//   - every restart issues an extra certificate, quickly hitting LE's
//     duplicate certificate limit (5 per week)
//   - handshakes wait for ACME, so any ACME hiccup fails the handshake
//   - "Certificate ready" reports a certificate real clients never use: a
//     false success
//
// So this asserts that the issued count is still 1 after a handshake.
func TestWarmupHitsTheCacheSlotRealClientsUse(t *testing.T) {
	f := newACMEFixture(t, fixtureOpts{})
	f.waitReport(t, "Certificate ready")

	if n := len(f.ca.Issued()); n != 1 {
		t.Fatalf("warm-up issued %d certificates, want 1", n)
	}

	// A real client: Go's TLS client advertises ECDSA, like browsers.
	conn, err := tls.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", f.httpsPort),
		f.ca.TLSClientConfig(testDomain))
	if err != nil {
		t.Fatalf("TLS handshake failed: %v", err)
	}
	defer conn.Close()

	// The regression: the handshake must not trigger a second issuance.
	if issued := f.ca.Issued(); len(issued) != 1 {
		t.Errorf("%d certificates issued after the handshake (%v): the warm-up used the wrong "+
			"cache slot and the real client triggered another issuance", len(issued), issued)
	}
}
