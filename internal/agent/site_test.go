package agent

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// UT-site-1: which origins are on the agent's site (ADR-0062 §1, §4). A site
// is the scheme plus the registrable domain from the Public Suffix List; an IP
// address is a site of its own.
func TestOnSite(t *testing.T) {
	prod := func(domain string, port int) *Agent {
		return &Agent{cfg: Config{Domain: domain, HTTPSPort: port}}
	}
	cases := []struct {
		name   string
		agent  *Agent
		origin string
		want   bool
	}{
		{"sibling subdomain, same port", prod("tokyo.example.com", 8443), "https://la.example.com:8443", true},
		{"sibling subdomain, another port", prod("tokyo.example.com", 8443), "https://la.example.com", true},
		{"the apex", prod("tokyo.example.com", 8443), "https://example.com", true},
		{"deeper subdomain", prod("tokyo.example.com", 8443), "https://a.b.example.com:1", true},
		{"its own origin", prod("tokyo.example.com", 8443), "https://tokyo.example.com:8443", true},
		{"plain http", prod("tokyo.example.com", 8443), "http://la.example.com:8443", false},
		{"another domain", prod("tokyo.example.com", 8443), "https://la.example.org:8443", false},
		{"suffix trick", prod("tokyo.example.com", 8443), "https://example.com.evil.org", false},
		{"public suffix co.uk", prod("tokyo.co.uk", 443), "https://la.co.uk", false},
		{"under a public suffix", prod("tokyo.example.co.uk", 443), "https://la.example.co.uk", true},
		{"private suffix (dynamic DNS)", prod("a.duckdns.org", 443), "https://b.duckdns.org", false},
		{"IP mode: another IP", prod("203.0.113.5", 443), "https://203.0.113.6", false},
		{"IP mode: a domain", prod("203.0.113.5", 443), "https://x.example.com", false},
		{"IP mode: its own origin", prod("203.0.113.5", 8443), "https://203.0.113.5:8443", true},
		{"IP origin to a domain agent", prod("tokyo.example.com", 443), "https://203.0.113.6", false},
		{"null origin", prod("tokyo.example.com", 443), "null", false},
		{"empty", prod("tokyo.example.com", 443), "", false},
		{"garbage", prod("tokyo.example.com", 443), "::not a url", false},
		{"origin with a path", prod("tokyo.example.com", 443), "https://la.example.com/x", false},
		{"no domain configured", &Agent{cfg: Config{}}, "https://la.example.com", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.agent.onSite(tc.origin); got != tc.want {
				t.Errorf("onSite(%q) with domain %q = %v, want %v", tc.origin, tc.agent.cfg.Domain, got, tc.want)
			}
		})
	}
}

// Under --dev every loopback origin is the agent's own, *.localhost included:
// Chromium resolves those to the loopback address, which is how E2E-56 runs
// two machines on one site (ADR-0062 §14).
func TestDevLocalOrigins(t *testing.T) {
	a := &Agent{cfg: Config{Dev: true}}
	for origin, want := range map[string]bool{
		"http://localhost:8080":          true,
		"http://127.0.0.1:8080":          true,
		"http://[::1]:8080":              true,
		"http://a.test.localhost:9000":   true,
		"http://localhost":               true,
		"https://localhost:8080":         false,
		"http://localhost.evil.com:8080": false,
		"http://evil.localhost.com":      false,
		"http://127.0.0.2:8080":          false,
		"https://la.example.com":         false,
		"":                               false,
	} {
		if got := a.isOwnOrigin(origin); got != want {
			t.Errorf("--dev isOwnOrigin(%q) = %v, want %v", origin, got, want)
		}
		if got := a.onSite(origin); got != want {
			t.Errorf("--dev onSite(%q) = %v, want %v", origin, got, want)
		}
	}
}

// UT-csp-1: the page may reach the other machines on its site, on any port
// (ADR-0062 §6); scripts still come only from 'self'.
func TestCSPSiteSources(t *testing.T) {
	csp := func(cfg Config) map[string]string {
		a := &Agent{cfg: cfg}
		rec := httptest.NewRecorder()
		a.securityHeaders(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
		out := map[string]string{}
		for _, d := range strings.Split(rec.Header().Get("Content-Security-Policy"), ";") {
			d = strings.TrimSpace(d)
			name, value, _ := strings.Cut(d, " ")
			out[name] = value
		}
		return out
	}
	has := func(t *testing.T, dirs map[string]string, name string, want ...string) {
		t.Helper()
		fields := strings.Fields(dirs[name])
		for _, w := range want {
			found := false
			for _, f := range fields {
				if f == w {
					found = true
				}
			}
			if !found {
				t.Errorf("%s = %q, missing %s", name, dirs[name], w)
			}
		}
	}
	lacks := func(t *testing.T, dirs map[string]string, name, sub string) {
		t.Helper()
		if strings.Contains(dirs[name], sub) {
			t.Errorf("%s = %q, must not contain %s", name, dirs[name], sub)
		}
	}

	t.Run("domain", func(t *testing.T) {
		d := csp(Config{Domain: "la.example.com", HTTPSPort: 8443})
		has(t, d, "connect-src", "'self'", "https://*.example.com:*", "wss://*.example.com:*", "https://example.com:*", "wss://example.com:*")
		has(t, d, "img-src", "'self'", "data:", "https://*.example.com:*", "https://example.com:*")
		has(t, d, "media-src", "'self'", "https://*.example.com:*", "https://example.com:*")
		if d["script-src"] != "'self'" {
			t.Errorf("script-src = %q, want 'self' only", d["script-src"])
		}
	})
	t.Run("IP mode", func(t *testing.T) {
		d := csp(Config{Domain: "203.0.113.5"})
		lacks(t, d, "connect-src", "*")
		lacks(t, d, "img-src", "*")
		has(t, d, "media-src", "'self'")
		lacks(t, d, "media-src", "*")
	})
	t.Run("dev", func(t *testing.T) {
		d := csp(Config{Dev: true})
		has(t, d, "connect-src", "'self'", "http://*.localhost:*", "ws://*.localhost:*")
		has(t, d, "img-src", "http://*.localhost:*")
		has(t, d, "media-src", "http://*.localhost:*")
	})
}
