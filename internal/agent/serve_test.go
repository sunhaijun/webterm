package agent

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/acme"
)

// A failed certificate request explains what happened and how to fix it,
// rather than showing a raw Go error (US-7.2 / AC-1.13).
func TestDescribeACMEError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want []string
	}{
		{
			"challenge can't get in: check the security group first",
			errors.New(`acme: authorization error for term.example.com: Invalid response from http://...`),
			// The cloud security group is the step most often missed, so it comes first.
			[]string{"security group", "curl -sI http://term.example.com/", "dig +short", "Cloudflare"},
		},
		{
			// autocert tries every challenge type before failing, so this is
			// what users really see, not the underlying "Invalid response".
			// Missing it would drop the most common failure into the default
			// branch with a raw error. Found by IT-tls-3.
			"all challenge types exhausted (what autocert actually returns): same diagnosis",
			errors.New(`acme/autocert: unable to satisfy "https://acme-v02.api.letsencrypt.org/authz/123" for domain "term.example.com": no viable challenge type found`),
			[]string{"security group", "80", "443", "curl -sI http://term.example.com/", "dig +short", "Cloudflare"},
		},
		{
			"rate limited: say how long the windows are (failures hourly, issuance weekly)",
			errors.New("urn:ietf:params:acme:error:rateLimited: too many certificates"),
			[]string{"rate limit", "per hour", "per week"},
		},
		{
			"domain does not resolve",
			errors.New(`dial tcp: lookup term.example.com: no such host`),
			[]string{"does not resolve", "dig +short"},
		},
		{
			"name does not match --domain",
			errors.New(`acme/autocert: host "evil.com" not configured in HostWhitelist`),
			[]string{"does not match", "no wildcards"},
		},
		{
			"unrecognized errors still point to troubleshooting",
			errors.New("something entirely unexpected"),
			[]string{"something entirely unexpected", "troubleshooting.md"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := describeACMEError(tc.err, "term.example.com")
			for _, want := range tc.want {
				if !strings.Contains(got, want) {
					t.Errorf("diagnosis lacks %q:\n%s", want, got)
				}
			}
			// The raw Go error must not be the main content.
			if strings.HasPrefix(strings.TrimSpace(got), "acme:") {
				t.Errorf("diagnosis starts with a raw error:\n%s", got)
			}
		})
	}
}

// IP mode (ADR-0044): a challenge failure mentions only port 80 and "is this
// the machine's public IP", not DNS or the Cloudflare proxy, which are
// irrelevant for an IP and would only mislead.
func TestDescribeACMEErrorIPMode(t *testing.T) {
	got := describeACMEError(errors.New("acme: authorization error for 203.0.113.7: Invalid response"), "203.0.113.7")
	for _, want := range []string{"security group", "curl -sI http://203.0.113.7/", "port 80 only", "ifconfig.me"} {
		if !strings.Contains(got, want) {
			t.Errorf("IP-mode diagnosis lacks %q:\n%s", want, got)
		}
	}
	for _, bad := range []string{"dig +short", "Cloudflare", "TLS-ALPN-01"} {
		if strings.Contains(got, bad) {
			t.Errorf("IP-mode diagnosis should not mention %q:\n%s", bad, got)
		}
	}
}

// UT-ipcert-3: when the CA has no profiles or no shortlived profile, say
// plainly that it does not issue IP certificates.
func TestDescribeACMEErrorNoShortlivedProfile(t *testing.T) {
	for _, msg := range []string{
		"acme: certificate authority does not support profiles",
		"acme: certificate authority does not advertise a profile with name shortlived (supported profiles: classic)",
		"400 urn:ietf:params:acme:error:rejectedIdentifier: Error creating new order :: Default profile does not permit IP address identifiers.",
	} {
		got := describeACMEError(errors.New(msg), "203.0.113.7")
		if !strings.Contains(got, "does not issue IP certificates") || !strings.Contains(got, "shortlived") {
			t.Errorf("unclear diagnosis for %q:\n%s", msg, got)
		}
	}
}

// UT-ipcert-2: only IPv4 literals enter IP mode; IPv6 literals are rejected.
func TestAddressClassification(t *testing.T) {
	for addr, want := range map[string]bool{
		"203.0.113.7":      true,
		"term.example.com": false,
		"1.2.3.4.nip.io":   false,
		"2001:db8::1":      false,
		"":                 false,
	} {
		if got := IsIPAddress(addr); got != want {
			t.Errorf("IsIPAddress(%q) = %v, want %v", addr, got, want)
		}
	}
	for _, addr := range []string{"2001:db8::1", "[2001:db8::1]", "::ffff:1.2.3.4"} {
		if err := CheckAddress(addr); err == nil || !strings.Contains(err.Error(), "IPv4") {
			t.Errorf("CheckAddress(%q) should reject and say only IPv4 is supported, got %v", addr, err)
		}
	}
	for _, addr := range []string{"203.0.113.7", "term.example.com", ""} {
		if err := CheckAddress(addr); err != nil {
			t.Errorf("CheckAddress(%q) unexpected error: %v", addr, err)
		}
	}
}

// autocert's HostPolicy must allow exactly --domain.
//
// A wildcard would let anyone get certificates for any name (threat model
// T8): point a domain at this machine and borrow our ACME account.
func TestCertManagerHostPolicyIsStrict(t *testing.T) {
	m := newCertManager(ServeConfig{Domain: "term.example.com", CertDir: t.TempDir()})
	if m.HostPolicy == nil {
		t.Fatal("HostPolicy is nil, which allows any name")
	}
	ctx := context.Background()

	if err := m.HostPolicy(ctx, "term.example.com"); err != nil {
		t.Fatalf("configured domain rejected: %v", err)
	}
	for _, host := range []string{
		"evil.example.com",
		"example.com",
		"sub.term.example.com",
		"term.example.com.evil.com",
		"",
	} {
		if err := m.HostPolicy(ctx, host); err == nil {
			t.Errorf("HostPolicy allowed %q, which could get certificates on our account", host)
		}
	}
}

// RenewBefore is deliberately unset, relying on autocert's
// min(30 days, lifetime/3).
//
// A fixed 30 days would mean "renew immediately, every time" with short-lived
// certificates (LE now offers 6-day ones), which would hit rate limits.
func TestCertManagerRenewBeforeUsesLibraryDefault(t *testing.T) {
	m := newCertManager(ServeConfig{Domain: "x.example.com", CertDir: t.TempDir()})
	if m.RenewBefore != 0 {
		t.Fatalf("RenewBefore = %v; leave it unset so the library scales it with the lifetime (see \"Certificates\" in install.md)", m.RenewBefore)
	}
}

// The default is Let's Encrypt production (staging was removed, ADR-0044 §3);
// only a test-injected directory overrides it.
func TestCertManagerDirectory(t *testing.T) {
	prod := newCertManager(ServeConfig{Domain: "x.example.com", CertDir: t.TempDir()})
	if prod.Client != nil {
		t.Error("no ACME directory should be set by default (use the acme package's production default)")
	}
	fake := newCertManager(ServeConfig{Domain: "x.example.com", CertDir: t.TempDir(), ACMEDirectoryURL: "http://x/dir"})
	if fake.Client == nil || fake.Client.DirectoryURL != "http://x/dir" {
		t.Errorf("test-injected directory not applied: %+v", fake.Client)
	}
}

// External URL: omit 443, include any other port. cmd/webterm's pairing URL
// and status overview use it too.
func TestExternalURLIncludesNonDefaultPort(t *testing.T) {
	cases := []struct {
		port int
		want string
	}{
		{443, "https://term.example.com"},
		{0, "https://term.example.com"}, // unset means default; never :0
		{8443, "https://term.example.com:8443"},
		{8080, "https://term.example.com:8080"},
	}
	for _, tc := range cases {
		if got := ExternalURL("term.example.com", tc.port); got != tc.want {
			t.Errorf("ExternalURL(_, %d) = %q, want %q", tc.port, got, tc.want)
		}
	}
}

// The redirect on :80 must go to an address that actually opens, port
// included.
func TestRedirectToHTTPSCarriesPort(t *testing.T) {
	cases := []struct {
		port int
		want string
	}{
		{443, "https://term.example.com/a?b=1"},
		{8443, "https://term.example.com:8443/a?b=1"},
	}
	for _, tc := range cases {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "http://term.example.com/a?b=1", nil)
		redirectToHTTPS("term.example.com", tc.port).ServeHTTP(rec, req)
		if rec.Code != http.StatusMovedPermanently {
			t.Errorf("port %d: status = %d, want 301", tc.port, rec.Code)
		}
		if got := rec.Header().Get("Location"); got != tc.want {
			t.Errorf("port %d: Location = %q, want %q", tc.port, got, tc.want)
		}
	}
}

// Identical ports are reported up front, instead of hitting "address already
// in use" and sending the user to find who holds the port (webterm itself).
func TestListenRejectsIdenticalPorts(t *testing.T) {
	a := &Agent{cfg: Config{}, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	_, _, err := a.Listen(ServeConfig{
		Domain:    "term.example.com",
		Bind:      "127.0.0.1",
		HTTPPort:  8443,
		HTTPSPort: 8443,
		CertDir:   t.TempDir(),
	}, http.NotFoundHandler())
	if err == nil {
		t.Fatal("identical ports accepted")
	}
	for _, want := range []string{"must differ", "8443", "--http-port", "--https-port"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error lacks %q: %v", want, err)
		}
	}
}

// Handshake noise must not be logged at INFO: the ports face the internet and
// scanners produce these lines constantly, burying the ones that matter
// (certificate warm-up results, bind failures).
func TestHTTPErrorLogDemotesHandshakeNoise(t *testing.T) {
	cases := []struct {
		name      string
		line      string
		wantLevel string
	}{
		{
			"scanner connects by IP (no SNI)",
			"http: TLS handshake error from 1.2.3.4:5678: acme/autocert: missing server name",
			"DEBUG",
		},
		{
			"scanner sends plain HTTP",
			"http: TLS handshake error from 1.2.3.4:5678: client sent an HTTP request to an HTTPS server",
			"DEBUG",
		},
		{
			"client rejects our certificate",
			"http: TLS handshake error from 1.2.3.4:5678: remote error: tls: unknown certificate",
			"DEBUG",
		},
		{
			// Anything that isn't handshake noise stays at INFO; demotion is
			// not blanket.
			"other http errors stay visible",
			"http: panic serving 1.2.3.4:5678: something broke",
			"INFO",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var buf lockedBuf
			a := &Agent{log: slog.New(slog.NewTextHandler(&buf,
				&slog.HandlerOptions{Level: slog.LevelDebug}))}
			a.httpErrorLog().Print(tc.line)

			got := buf.String()
			if !strings.Contains(got, "level="+tc.wantLevel) {
				t.Errorf("want level=%s, got:\n%s", tc.wantLevel, got)
			}
			// The content must survive: demotion reduces noise, it doesn't hide.
			if !strings.Contains(got, "TLS handshake error") && !strings.Contains(got, "panic serving") {
				t.Errorf("message content lost:\n%s", got)
			}
		})
	}
}

type lockedBuf struct {
	mu sync.Mutex
	b  strings.Builder
}

func (l *lockedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

// UT-ipcert-1: renewal time = NotAfter - lifetime/3, the same rule as
// autocert.
func TestRenewAtIsOneThirdBeforeExpiry(t *testing.T) {
	nb := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		lifetime, before time.Duration
	}{
		{160 * time.Hour, 160 * time.Hour / 3}, // IP certificate: about 53 hours before
		{90 * 24 * time.Hour, 30 * 24 * time.Hour},
	} {
		leaf := &x509.Certificate{NotBefore: nb, NotAfter: nb.Add(tc.lifetime)}
		if got, want := renewAt(leaf), leaf.NotAfter.Add(-tc.before); !got.Equal(want) {
			t.Errorf("lifetime %v: renewAt = %v, want %v", tc.lifetime, got, want)
		}
	}
}

// A handshake never triggers issuance; the challenge handler answers only
// registered tokens and passes other requests to the fallback.
func TestIPCertManagerHandshakeAndChallenge(t *testing.T) {
	m := newIPCertManager(ServeConfig{Domain: "203.0.113.7", CertDir: t.TempDir()})
	if _, err := m.GetCertificate(&tls.ClientHelloInfo{}); err == nil {
		t.Error("GetCertificate without a certificate should fail, not issue")
	}

	m.tokens["tok"] = "tok.thumb"
	fallback := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusMovedPermanently) })
	h := m.HTTPHandler(fallback)
	for path, want := range map[string]int{
		"/.well-known/acme-challenge/tok":   http.StatusOK,
		"/.well-known/acme-challenge/other": http.StatusNotFound,
		"/":                                 http.StatusMovedPermanently,
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != want {
			t.Errorf("%s → %d, want %d", path, rec.Code, want)
		}
		if want == http.StatusOK && rec.Body.String() != "tok.thumb" {
			t.Errorf("challenge response = %q", rec.Body.String())
		}
	}
}

// IP mode defaults to the Let's Encrypt production directory; a
// test-injected directory wins.
func TestACMEDirectorySelection(t *testing.T) {
	if got := acmeDirectory(ServeConfig{}); !strings.Contains(got, "acme-v02.api.letsencrypt.org") {
		t.Errorf("default directory = %q", got)
	}
	if got := acmeDirectory(ServeConfig{ACMEDirectoryURL: "http://x/dir"}); got != "http://x/dir" {
		t.Errorf("test-injected directory was overridden: %q", got)
	}
}

// UT-issue-unreachable: only a failed validation means "the CA can't reach us";
// failing to reach the CA must not send the user to their inbound firewall.
func TestFailureClassification(t *testing.T) {
	outbound := &url.Error{Op: "Get", URL: "https://acme-v02.api.letsencrypt.org/directory",
		Err: &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("i/o timeout")}}
	authz := &acme.AuthorizationError{Identifier: "203.0.113.7",
		Errors: []error{errors.New("urn:ietf:params:acme:error:connection: Timeout during connect (likely firewall problem)")}}
	flattened := errors.New(`acme/autocert: unable to satisfy "https://example/authz/1" for domain "term.example.com": no viable challenge type found`)

	for _, tc := range []struct {
		name                  string
		err                   error
		validation, outbound_ bool
		advice                string
	}{
		{"outbound timeout to the CA", outbound, false, true, "can't reach Let's Encrypt"},
		{"CA timed out connecting to us", authz, true, false, "security group"},
		{"autocert's flattened challenge failure", flattened, true, false, "security group"},
		{"rate limit", errors.New("urn:ietf:params:acme:error:rateLimited: too many"), false, false, "rate limit"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := isValidationFailure(tc.err); got != tc.validation {
				t.Errorf("isValidationFailure = %v, want %v", got, tc.validation)
			}
			if got := isOutboundFailure(tc.err); got != tc.outbound_ {
				t.Errorf("isOutboundFailure = %v, want %v", got, tc.outbound_)
			}
			if got := newIssueError(tc.err, "203.0.113.7"); got.Unreachable != tc.validation {
				t.Errorf("IssueError.Unreachable = %v, want %v", got.Unreachable, tc.validation)
			}
			if d := describeACMEError(tc.err, "203.0.113.7"); !strings.Contains(d, tc.advice) {
				t.Errorf("diagnosis lacks %q:\n%s", tc.advice, d)
			}
		})
	}
}
