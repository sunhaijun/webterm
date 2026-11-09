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
			// A revoked device's cookie says so: a page opened after the
			// revocation can then tell the user why it shows the pairing page.
			if a.auth.Revoked(r) {
				a.writeError(w, http.StatusUnauthorized, "revoked", "This device has been revoked")
				return
			}
			a.writeError(w, http.StatusUnauthorized, "unauthorized", "Pairing required")
			return
		}
		// Every authenticated request carrying Origin must come from the agent's
		// own origin or the one the device was paired from (ADR-0062 §4). Reads
		// too: CORS answers every origin on the site, so without this any page
		// on the same domain could read the API with the user's cookie. Always
		// logged: the request passed auth, so it is not scanner noise, and a
		// rejected WebSocket would otherwise just retry with an empty log.
		if !a.originAllowed(r, dev) {
			a.log.Warn("request rejected: Origin may not act for this device",
				"path", r.URL.Path, "origin", r.Header.Get("Origin"), "expected", a.allowedOrigin(), "device", dev.ID)
			a.writeError(w, http.StatusForbidden, "forbidden", "This page may not act for this device")
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
	// The other machines on the site (ADR-0062 §6): the page talks to them
	// and previews their files. Scripts still come only from 'self'.
	imgSrc, mediaSrc := "'self' data:", "'self'"
	if web, sockets := a.siteSources(); web != "" {
		connectSrc += " " + web + " " + sockets
		imgSrc += " " + web
		mediaSrc += " " + web
	}
	csp := strings.Join([]string{
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		"connect-src " + connectSrc,
		"img-src " + imgSrc,
		"media-src " + mediaSrc,
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

// checkOrigin reports whether a request comes from the agent's own origin, or
// has no Origin at all (non-browser clients such as wscat and the integration
// tests still need cookie auth, so this is not a bypass). Requests that a
// device is behind use originAllowed, which also accepts the origin the device
// was paired from (ADR-0062 §4).
//
// WebSocket handshakes are not protected by CORS. Modern browsers don't send
// SameSite=Strict cookies on cross-site WS handshakes either, but that
// behavior has varied historically, so the Origin check is a required second
// line of defense (AC-1.8 / threat model T4).
func (a *Agent) checkOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	return origin == "" || a.isOwnOrigin(origin)
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
