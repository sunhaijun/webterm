package agent

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/sunhaijun/webterm/internal/store"
)

type ctxKey int

const deviceKey ctxKey = iota

// deviceFrom returns the device the middleware stored in the context.
func deviceFrom(r *http.Request) *store.Device {
	d, _ := r.Context().Value(deviceKey).(*store.Device)
	return d
}

// requireAuth is the authentication middleware.
//
// It must cover the WebSocket upgrade path, not just REST. That is the
// easiest entry in the auth matrix to miss (AC-1.7 / threat model T1).
func (a *Agent) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		dev, err := a.auth.Authenticate(r)
		if err != nil {
			a.writeError(w, http.StatusInternalServerError, "internal", "Authentication check failed")
			return
		}
		if dev == nil {
			a.auth.ClearSessionCookie(w)
			a.writeError(w, http.StatusUnauthorized, "unauthorized", "Pairing required")
			return
		}
		a.auth.MaybeRenew(w, r, dev, time.Now())
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), deviceKey, dev)))
	})
}

// securityHeaders adds security headers to every response.
func (a *Agent) securityHeaders(next http.Handler) http.Handler {
	// xterm's DOM renderer writes terminal output cell by cell as textContent,
	// never parsed as HTML; session names and CWDs are rendered as text too
	// (threat-model.md T5). CSP is the backstop: if anything slips through,
	// foreign scripts still can't run.
	connectSrc := "'self'"
	if a.cfg.Domain != "" {
		connectSrc += " wss://" + a.cfg.Domain
	}
	csp := strings.Join([]string{
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		"connect-src " + connectSrc,
		"img-src 'self' data:",
		"font-src 'self'",
		"manifest-src 'self'",
		"worker-src 'self'",
		"object-src 'none'",
		"base-uri 'none'",
		"frame-ancestors 'none'",
	}, "; ")

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		if !a.cfg.Dev {
			// No HSTS under --dev: localhost is plain HTTP.
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		next.ServeHTTP(w, r)
	})
}

// checkOrigin validates the Origin of a WebSocket handshake.
//
// WebSocket handshakes are not protected by CORS. Modern browsers don't send
// SameSite=Strict cookies on cross-site WS handshakes either, but that
// behavior has varied historically, so the Origin check is a required second
// line of defense (AC-1.8 / threat model T4).
func (a *Agent) checkOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		// Non-browser clients (wscat, integration tests) send no Origin. They
		// still need cookie auth, so this is not a bypass.
		return true
	}
	if a.cfg.Domain != "" && origin == a.allowedOrigin() {
		return true
	}
	if a.cfg.Dev {
		return isLocalOrigin(origin)
	}
	return false
}

// allowedOrigin is the Origin the browser is expected to send.
//
// It must include a non-default port. A page served from
// https://domain:8443 sends Origin https://domain:8443, which never equals
// the portless form; /ws then returns 403, the phone just keeps retrying, and
// the server logs nothing.
//
// It reuses ExternalURL, which the pairing QR code, 301 redirects and the
// startup log also use, so there is a single definition.
func (a *Agent) allowedOrigin() string {
	return ExternalURL(a.cfg.Domain, a.cfg.HTTPSPort)
}

// isLocalOrigin reports whether origin is a loopback address (allowed only
// under --dev).
func isLocalOrigin(origin string) bool {
	rest, ok := strings.CutPrefix(origin, "http://")
	if !ok {
		return false
	}
	host, _, found := strings.Cut(rest, ":")
	if !found {
		host = rest
	}
	return host == "localhost" || host == "127.0.0.1" || host == "[::1]"
}
