package agent

import (
	"net"
	"net/http"
	"net/url"
	"strings"

	"golang.org/x/net/publicsuffix"

	"github.com/sunhaijun/webterm/internal/store"
)

// Several machines in one page (ADR-0062). Machines on subdomains of one
// registrable domain are one site to the browser, so a page served by one can
// talk to the others with their own SameSite=Strict cookies. This file decides
// which origins are on the agent's site, which may act for a device, and what
// CORS and the CSP allow.

// siteOf returns host's site in the browser's sense, without the scheme: its
// registrable domain (eTLD+1) from the Public Suffix List. An IP address, or a
// name with no registrable domain (a public suffix itself), is a site of its
// own.
func siteOf(host string) string {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if net.ParseIP(host) != nil {
		return host
	}
	site, err := publicsuffix.EffectiveTLDPlusOne(host)
	if err != nil {
		return host
	}
	return site
}

// parseOrigin splits an Origin header into its scheme and host (without the
// port). An Origin is only ever scheme://host[:port]; anything else, including
// "null", is not one.
func parseOrigin(origin string) (scheme, host string, ok bool) {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme == "" || u.Host == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return "", "", false
	}
	return u.Scheme, strings.ToLower(u.Hostname()), true
}

// isLocalOrigin reports whether origin is a loopback origin over plain HTTP:
// localhost, 127.0.0.1, [::1] or any *.localhost (allowed only under --dev).
// Chromium resolves every *.localhost to the loopback address, which lets two
// dev agents be two machines on one site (ADR-0062 §14).
func isLocalOrigin(origin string) bool {
	scheme, host, ok := parseOrigin(origin)
	if !ok || scheme != "http" {
		return false
	}
	return host == "localhost" || host == "127.0.0.1" || host == "::1" || strings.HasSuffix(host, ".localhost")
}

// isOwnOrigin reports whether origin is the agent's own: the configured domain
// with any non-default port, or under --dev any local origin.
func (a *Agent) isOwnOrigin(origin string) bool {
	if origin == "" {
		return false
	}
	if a.cfg.Domain != "" && origin == a.allowedOrigin() {
		return true
	}
	return a.cfg.Dev && isLocalOrigin(origin)
}

// onSite reports whether origin is on the agent's site: the same scheme and
// registrable domain, on any port. In IP mode only the agent's own origin is;
// under --dev every local origin is.
func (a *Agent) onSite(origin string) bool {
	if a.isOwnOrigin(origin) {
		return true
	}
	if a.cfg.Dev || a.cfg.Domain == "" || net.ParseIP(a.cfg.Domain) != nil {
		return false
	}
	scheme, host, ok := parseOrigin(origin)
	if !ok || scheme != "https" || net.ParseIP(host) != nil {
		return false
	}
	return siteOf(host) == siteOf(a.cfg.Domain)
}

// originAllowed decides whether a request may act for dev (ADR-0062 §4): a
// request without Origin (same-origin GET, <img>, non-browser clients) may;
// otherwise Origin must be the agent's own or the one the device was paired
// from. Reads are included, because CORS answers every origin on the site.
func (a *Agent) originAllowed(r *http.Request, dev *store.Device) bool {
	origin := r.Header.Get("Origin")
	if origin == "" || a.isOwnOrigin(origin) {
		return true
	}
	return dev != nil && dev.Origin != "" && origin == dev.Origin && a.onSite(origin)
}

// cors answers CORS for origins on the agent's site under /auth/ and /api/
// (ADR-0062 §5). It only lets such a page read answers, refusals included, so
// it can tell "pairing required" from "unreachable"; whether a request may act
// is originAllowed's decision. A preflight from anywhere else is refused, so
// the browser never sends the request.
func (a *Agent) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if !strings.HasPrefix(p, "/api/") && !strings.HasPrefix(p, "/auth/") {
			next.ServeHTTP(w, r)
			return
		}
		h := w.Header()
		h.Add("Vary", "Origin")
		origin := r.Header.Get("Origin")
		ok := origin != "" && a.onSite(origin)
		if ok {
			h.Set("Access-Control-Allow-Origin", origin)
			h.Set("Access-Control-Allow-Credentials", "true")
		}
		if r.Method != http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		if !ok {
			a.writeError(w, http.StatusForbidden, "forbidden", "Cross-site request refused")
			return
		}
		h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE")
		h.Set("Access-Control-Allow-Headers", "Content-Type, Range")
		h.Set("Access-Control-Max-Age", "600")
		w.WriteHeader(http.StatusNoContent)
	})
}

// siteSources returns the CSP sources for the other machines on the agent's
// site, on any port (ADR-0062 §6): the HTTP ones for img-src and media-src,
// and those plus the WebSocket ones for connect-src. A source without :*
// would match only the default port. Empty in IP mode.
func (a *Agent) siteSources() (web, sockets string) {
	if a.cfg.Dev {
		return "http://*.localhost:*", "ws://*.localhost:*"
	}
	if a.cfg.Domain == "" || net.ParseIP(a.cfg.Domain) != nil {
		return "", ""
	}
	s := siteOf(a.cfg.Domain)
	if s == a.cfg.Domain && !strings.Contains(s, ".") {
		return "", "" // no registrable domain: nothing to share it with
	}
	return "https://*." + s + ":* https://" + s + ":*", "wss://*." + s + ":* wss://" + s + ":*"
}
