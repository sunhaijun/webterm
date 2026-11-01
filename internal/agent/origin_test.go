package agent

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// The Origin check must account for a non-default port.
//
// With --https-port 8443, a paired phone got 403 on /ws forever: the browser
// sent https://domain:8443 but the check compared against https://domain. The
// client just kept retrying and the server logged nothing.
func TestCheckOriginPort(t *testing.T) {
	const domain = "term.example.com"
	cases := []struct {
		name      string
		httpsPort int
		origin    string
		want      bool
	}{
		{"non-default port, browser sends port: allow", 8443, "https://" + domain + ":8443", true},
		{"non-default port, no port: reject", 8443, "https://" + domain, false},
		{"non-default port, wrong port: reject", 8443, "https://" + domain + ":9443", false},
		{"443, no port: allow", 443, "https://" + domain, true},
		{"443, explicit :443: reject (browsers never send it)", 443, "https://" + domain + ":443", false},
		{"unset port means 443", 0, "https://" + domain, true},
		{"cross-site: reject", 8443, "https://evil.example.com:8443", false},
		{"same host over http: reject", 8443, "http://" + domain + ":8443", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := &Agent{cfg: Config{Domain: domain, HTTPSPort: tc.httpsPort}}
			r := httptest.NewRequest(http.MethodGet, "/ws", nil)
			r.Header.Set("Origin", tc.origin)
			if got := a.checkOrigin(r); got != tc.want {
				t.Errorf("checkOrigin(%q) with --https-port %d = %v, want %v (expected Origin %q)",
					tc.origin, tc.httpsPort, got, tc.want, a.allowedOrigin())
			}
		})
	}
}

// Non-browser clients without an Origin are allowed; they still need cookie
// auth.
func TestCheckOriginAbsent(t *testing.T) {
	a := &Agent{cfg: Config{Domain: "term.example.com", HTTPSPort: 8443}}
	r := httptest.NewRequest(http.MethodGet, "/ws", nil)
	if !a.checkOrigin(r) {
		t.Error("client without an Origin header should pass the Origin check")
	}
}

// allowedOrigin must be the same URL the pairing QR code and the 301
// redirect use, or they drift apart again.
func TestAllowedOriginMatchesExternalURL(t *testing.T) {
	for _, port := range []int{0, 443, 8443} {
		a := &Agent{cfg: Config{Domain: "term.example.com", HTTPSPort: port}}
		if got, want := a.allowedOrigin(), ExternalURL("term.example.com", port); got != want {
			t.Errorf("port %d: allowedOrigin=%q, ExternalURL=%q", port, got, want)
		}
	}
}
