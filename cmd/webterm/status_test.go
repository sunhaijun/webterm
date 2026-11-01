package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// Bare webterm must answer "is it working?" at a glance. Rendering is a pure
// function, so every state can be pinned down.
func TestRenderStatus(t *testing.T) {
	now := time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name string
		st   status
		want []string
		deny []string
	}{
		{
			"all healthy",
			status{
				running: true, runningVia: "systemd",
				url:    "https://term.example.com:8443",
				certOK: true, certExpiry: now.AddDate(0, 0, 89),
				devices: 2, configPath: "/home/u/.config/webterm/config",
			},
			[]string{"Running", "systemd", "https://term.example.com:8443",
				"2026-12-06", "89 days", "2 authorized", "webterm pair"},
			nil,
		},
		{
			// The most common first run: the service is up but nothing is paired.
			"no authorized devices points to the next step",
			status{running: true, url: "https://x.example.com", certOK: true,
				certExpiry: now.AddDate(0, 0, 89), devices: 0},
			[]string{"None authorized yet", "webterm pair", "next step"},
			nil,
		},
		{
			"service not running",
			status{running: false, url: "https://x.example.com"},
			[]string{"Not running", "webterm serve"},
			nil,
		},
		{
			"certificate not issued yet",
			status{running: true, url: "https://x.example.com", certOK: false},
			[]string{"Not issued yet"},
			[]string{"until", "left"},
		},
		{
			// Imminent expiry must stand out: it is the one thing that silently
			// turns into an outage.
			"certificate expiring soon",
			status{running: true, url: "https://x.example.com", certOK: true,
				certExpiry: now.AddDate(0, 0, 5), devices: 1},
			[]string{"Only 5 days left", "renewal"},
			nil,
		},
		{
			"certificate expired",
			status{running: true, url: "https://x.example.com", certOK: true,
				certExpiry: now.AddDate(0, 0, -1), devices: 1},
			[]string{"Expired"},
			nil,
		},
		{
			// ADR-0034: starting a system service needs sudo.
			"system service not running",
			status{running: false, unit: unitSystem, url: "https://x.example.com"},
			[]string{"Not running", "sudo systemctl start webterm"},
			[]string{"--user", "Migrate"},
		},
		{
			// ADR-0034: still a user service. Explain the cost and give the
			// migration command; only suggest it, never run it.
			"still a user service",
			status{running: true, runningVia: "systemd", unit: unitUser,
				url: "https://x.example.com", certOK: true, certExpiry: now.AddDate(0, 0, 89), devices: 1},
			[]string{"user service", "killed before", "webterm update --force-restart", "over SSH"},
			nil,
		},
		{
			"system service healthy",
			status{running: true, runningVia: "systemd", unit: unitSystem,
				url: "https://x.example.com", certOK: true, certExpiry: now.AddDate(0, 0, 89), devices: 1},
			[]string{"Running (systemd)"},
			[]string{"user service", "Migrate"},
		},
		{
			"no URL configured (never even ran --dev)",
			status{running: false},
			[]string{"Not configured", "webterm install"},
			nil,
		},
		{
			// UT-status-cert: a freshly issued 6-day IP certificate is not
			// flagged (ADR-0044 §4).
			"fresh IP certificate",
			status{running: true, url: "https://203.0.113.7", ipMode: true, certOK: true,
				certStart: now.Add(-time.Hour), certExpiry: now.Add(159 * time.Hour), devices: 1},
			[]string{"Valid", "6 days", "renews automatically"},
			[]string{"Only"},
		},
		{
			"IP certificate unrenewed with 30 hours left",
			status{running: true, url: "https://203.0.113.7", ipMode: true, certOK: true,
				certStart: now.Add(-130 * time.Hour), certExpiry: now.Add(30 * time.Hour), devices: 1},
			[]string{"Only 30 hours left", "port 80 reachable", "journalctl"},
			[]string{"80 or 443"},
		},
		{
			"90-day certificate with 11 days left is not flagged",
			status{running: true, url: "https://x.example.com", certOK: true,
				certStart: now.AddDate(0, 0, -79), certExpiry: now.AddDate(0, 0, 11), devices: 1},
			[]string{"Valid", "11 days"},
			[]string{"Only"},
		},
		{
			"90-day certificate with 9 days left is flagged",
			status{running: true, url: "https://x.example.com", certOK: true,
				certStart: now.AddDate(0, 0, -81), certExpiry: now.AddDate(0, 0, 9), devices: 1},
			[]string{"Only 9 days left", "80 or 443"},
			nil,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := renderStatus(tc.st, "v0.1.0", now, false)
			for _, w := range tc.want {
				if !strings.Contains(got, w) {
					t.Errorf("missing %q:\n%s", w, got)
				}
			}
			for _, d := range tc.deny {
				if strings.Contains(got, d) {
					t.Errorf("unexpected %q:\n%s", d, got)
				}
			}
			// The command list is always shown.
			if !strings.Contains(got, "webterm doctor") {
				t.Errorf("command list is missing:\n%s", got)
			}
		})
	}
}

// Hint commands line up in one column even when one is longer than the rest.
func TestRenderStatusHintsAligned(t *testing.T) {
	now := time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)
	got := renderStatus(status{running: false, unit: unitUser, url: "https://x.example.com"}, "v0.1.0", now, false)
	col := -1
	for _, line := range strings.Split(got, "\n") {
		for _, cmd := range []string{"webterm pair", "webterm devices", "webterm doctor", "webterm update --force-restart", "systemctl --user start webterm"} {
			if !strings.HasPrefix(line, "  "+cmd+" ") {
				continue
			}
			rest := strings.TrimLeft(line[2+len(cmd):], " ")
			c := len(line) - len(rest)
			if col == -1 {
				col = c
			} else if c != col {
				t.Errorf("hint descriptions are not aligned (column %d vs %d):\n%s", c, col, got)
			}
		}
	}
	if col == -1 {
		t.Fatalf("no hints found:\n%s", got)
	}
}

// Days left are whole days, so "-0 days" never shows up.
func TestDaysLeft(t *testing.T) {
	now := time.Date(2026, 9, 8, 23, 30, 0, 0, time.UTC)
	cases := []struct {
		expiry time.Time
		want   int
	}{
		{now.Add(30 * time.Minute), 0}, // expires in half an hour: today
		{now.Add(25 * time.Hour), 1},
		{now.AddDate(0, 0, 89), 89},
		{now.Add(-time.Hour), -1}, // already expired
	}
	for _, tc := range cases {
		if got := daysLeft(tc.expiry, now); got != tc.want {
			t.Errorf("daysLeft(+%v) = %d, want %d", tc.expiry.Sub(now), got, tc.want)
		}
	}
}

func TestRemainingIsSingularForOne(t *testing.T) {
	now := time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)
	if got := remaining(now.Add(90*time.Minute), now); got != "1 hour" {
		t.Errorf("remaining(+90m) = %q, want %q", got, "1 hour")
	}
	if got := remaining(now.Add(72*time.Hour), now); got != "3 days" {
		t.Errorf("remaining(+72h) = %q, want %q", got, "3 days")
	}
}

// Color appears only on a terminal; a redirected file must not contain escape
// sequences.
func TestRenderStatusColor(t *testing.T) {
	now := time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)
	// Expiring soon and expired are the only two colored states.
	for _, st := range []status{
		{running: true, url: "https://x.example.com", certOK: true, certExpiry: now.AddDate(0, 0, 5)},
		{running: true, url: "https://x.example.com", certOK: true, certExpiry: now.AddDate(0, 0, -1)},
	} {
		plain := renderStatus(st, "v0.1.0", now, false)
		if strings.Contains(plain, "\033[") {
			t.Errorf("escape sequences with color off:\n%q", plain)
		}
		colored := renderStatus(st, "v0.1.0", now, true)
		if !strings.Contains(colored, "\033[") {
			t.Errorf("no color with color on:\n%q", colored)
		}
		// Turning color off must not lose information.
		if stripANSI(colored) != plain {
			t.Errorf("color changed the text:\n%q\n%q", stripANSI(colored), plain)
		}
	}
}

func stripANSI(s string) string {
	for {
		i := strings.Index(s, "\033[")
		if i < 0 {
			return s
		}
		j := strings.Index(s[i:], "m")
		if j < 0 {
			return s
		}
		s = s[:i] + s[i+j+1:]
	}
}

// Any NO_COLOR value, even empty, disables color; so does TERM=dumb.
func TestColorEnabled(t *testing.T) {
	// A regular file is never colored.
	f, err := os.CreateTemp(t.TempDir(), "out")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	t.Setenv("TERM", "xterm-256color")
	os.Unsetenv("NO_COLOR")
	if colorEnabled(f) {
		t.Error("output redirected to a file should not be colored")
	}
	t.Setenv("NO_COLOR", "")
	if colorEnabled(os.Stdin) {
		t.Error("NO_COLOR is set (even empty), so there should be no color")
	}
}

// The liveness probe must send SNI.
//
// autocert's HostPolicy accepts only the --domain name. Connecting by IP
// without SNI gets no certificate and the handshake fails; that is a
// server-side refusal InsecureSkipVerify cannot fix. Without SNI the probe
// reports a live service as not running.
//
// httptest.StartTLS is unusable here: it always puts a localhost certificate in
// Certificates, and Go does not call GetCertificate when len(Certificates) > 0
// and ServerName is empty. The handshake would succeed with that fallback, and
// the test would pass even with the fix reverted (it did). So this starts a
// server with only GetCertificate and no fallback certificate.
func TestHealthzOKSendsSNI(t *testing.T) {
	const domain = "t.example.com"
	cert := selfSigned(t, domain)

	var sawSNI []string
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			io.WriteString(w, "ok")
		}),
		TLSConfig: &tls.Config{
			GetCertificate: func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
				sawSNI = append(sawSNI, hello.ServerName)
				if hello.ServerName != domain {
					// this is how autocert refuses a host outside HostPolicy
					return nil, fmt.Errorf("acme/autocert: host %q not configured in HostWhitelist", hello.ServerName)
				}
				return &cert, nil
			},
		},
	}
	go srv.ServeTLS(ln, "", "") //nolint:errcheck // always ErrServerClosed on shutdown
	defer srv.Close()

	url := "https://" + ln.Addr().String() + "/healthz"
	if !healthzOK(url, domain) {
		t.Errorf("probe with SNI should succeed (server saw SNI %q)", sawSNI)
	}
	if healthzOK(url, "") {
		t.Error("this server rejects handshakes without SNI; the probe should not succeed")
	}
	if len(sawSNI) == 0 || sawSNI[0] != domain {
		t.Errorf("server did not receive the expected SNI: %q", sawSNI)
	}
}

// A body other than "ok" does not count as alive; this is how another service
// on the port is told apart.
func TestHealthzOKChecksBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "<html>nginx</html>")
	}))
	defer srv.Close()
	if healthzOK(srv.URL+"/healthz", "") {
		t.Error("body is not ok; should not be taken for webterm")
	}
}

func selfSigned(t *testing.T, domain string) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: domain},
		DNSNames:     []string{domain},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

// The probe does not follow redirects; following one lets another host answer
// for this machine.
//
// In production, :80 only has ACME challenges and redirects, so /healthz there
// returns a 301 to the public domain. Following it leaves the machine and comes
// back, making correctness depend on DNS and NAT hairpinning; with
// --bind 127.0.0.1 it points at an address this process does not even serve.
func TestHealthzOKDoesNotFollowRedirect(t *testing.T) {
	real := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "ok")
	}))
	defer real.Close()

	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, real.URL+"/healthz", http.StatusMovedPermanently)
	}))
	defer redirector.Close()

	if healthzOK(redirector.URL+"/healthz", "") {
		t.Error("ok obtained by following a 301 elsewhere should not count as this machine being alive")
	}
	// Control: a server that answers ok directly is alive.
	if !healthzOK(real.URL+"/healthz", "") {
		t.Error("a direct ok should count as alive")
	}
}
