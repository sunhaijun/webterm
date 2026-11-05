package agent

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"strconv"
	"time"

	"github.com/coder/websocket"
	"github.com/sunhaijun/webterm/internal/auth"
	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/webui"
	"github.com/sunhaijun/webterm/internal/wsconn"
)

const maxJSONBody = 64 << 10

// ---------- Static assets ----------

// staticHandler serves the embedded frontend.
//
// Static assets need no auth: the JS/CSS hold no secrets (all data goes
// through authenticated APIs), and requiring auth would mean the pairing page
// itself needs auth.
func (a *Agent) staticHandler() http.Handler {
	sub := webui.FS()
	files := http.FileServerFS(sub)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !webui.Built() {
			// The binary has no frontend. A silent 404 would look like broken
			// routing, so say plainly that a build step was skipped.
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte("This binary was built without the frontend.\n" +
				"Build the frontend first: cd web && npm run build, then go build\n"))
			return
		}
		// SPA fallback: unknown paths get index.html and the frontend routes them.
		p := r.URL.Path
		if p != "/" {
			if _, err := fs.Stat(sub, p[1:]); err != nil {
				r = r.Clone(r.Context())
				r.URL.Path = "/"
			}
		}
		// The service worker caches only the static shell; no long-lived cache
		// headers here, or updates would not get through.
		w.Header().Set("Cache-Control", "no-cache")
		files.ServeHTTP(w, r)
	})
}

// ---------- Pairing ----------

type pairRequest struct {
	Code string `json:"code"`
}

// handlePair is the only unauthenticated dynamic endpoint, so it is rate
// limited (AC-1.6).
func (a *Agent) handlePair(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	ip := auth.ClientIP(r, a.cfg.TrustProxy)

	if ok, retry := a.auth.Limiter().Allow(ip, now); !ok {
		w.Header().Set("Retry-After", strconv.Itoa(int(retry.Seconds())+1))
		a.writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many attempts. Try again later")
		return
	}

	var req pairRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxJSONBody)).Decode(&req); err != nil || req.Code == "" {
		a.auth.Limiter().Failed(ip, now)
		a.writeError(w, http.StatusBadRequest, "bad_request", "Missing pairing code")
		return
	}

	dev, token, err := a.auth.Pair(req.Code, r.Header.Get("User-Agent"), ip, now)
	if err != nil {
		if tripped := a.auth.Limiter().Failed(ip, now); tripped {
			// The global circuit breaker must be visible to whoever runs the server.
			a.log.Warn("pairing failures hit the global limit; pausing pairing for 10 minutes")
		}
		// Never log the pairing code (AC-8.5).
		a.log.Info("pairing failed", "ip", ip)
		a.writeError(w, http.StatusUnauthorized, "invalid_code", "Invalid or expired pairing code")
		return
	}
	a.auth.Limiter().Succeeded(ip)
	a.auth.SetSessionCookie(w, token)
	a.log.Info("new device paired", "device", dev.ID, "name", dev.Name, "ip", ip)
	a.writeJSON(w, http.StatusOK, map[string]any{"device": dev})
}

// handleLogout signs out the requesting device (AC-1.22, ADR-0048). It revokes
// the device rather than only clearing the cookie, so a copied token stops
// working too, and asks the browser to drop everything it holds for this
// origin. The device's other tabs lose their WebSocket through the revocation
// scan (AC-1.11).
func (a *Agent) handleLogout(w http.ResponseWriter, r *http.Request) {
	dev := deviceFrom(r)
	if err := a.store.RevokeDevice(dev.ID, time.Now()); err != nil {
		a.writeError(w, http.StatusInternalServerError, "internal", "Sign-out failed")
		return
	}
	a.auth.ClearSessionCookie(w)
	w.Header().Set("Clear-Site-Data", `"cookies", "storage", "cache"`)
	a.log.Info("device signed out", "device", dev.ID, "name", dev.Name)
	w.WriteHeader(http.StatusNoContent)
}

// ---------- WebSocket ----------

func (a *Agent) handleWS(w http.ResponseWriter, r *http.Request) {
	if !a.checkOrigin(r) {
		// Always log this. The request already passed auth, so it is not
		// scanner noise: one of the user's own devices is being rejected.
		// Otherwise the client just keeps retrying and the server log is empty.
		a.log.Warn("WebSocket rejected: Origin mismatch",
			"origin", r.Header.Get("Origin"), "expected", a.allowedOrigin())
		a.writeError(w, http.StatusForbidden, "forbidden", "Origin does not match the configured domain")
		return
	}
	if a.hub.Full() {
		a.writeError(w, http.StatusServiceUnavailable, "too_many_conns", "Too many concurrent connections")
		return
	}

	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Origin was already checked strictly against the configured domain.
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled, // no compression (ADR-0009)
	})
	if err != nil {
		return
	}
	ws.SetReadLimit(int64(maxWSRead))

	c := wsconn.New(ws, wsconn.Deps{
		Sessions:        a.sessions,
		Hub:             a.hub,
		ServerVersion:   a.cfg.Version,
		Logger:          a.log,
		IdleTimeout:     a.cfg.WSIdleTimeout,
		WriteQueueBytes: a.cfg.WSWriteQueueMax,
		Revoked: func() bool {
			// Checking only at handshake is not enough; a WebSocket can stay
			// open for days (AC-1.11).
			d, err := a.store.DeviceByToken(sessionTokenOf(r))
			return err == nil && d == nil
		},
	})
	if err := a.hub.Add(c); err != nil {
		_ = ws.Close(websocket.StatusTryAgainLater, "too many concurrent connections")
		return
	}
	a.sessions.AddObserver(c)
	defer func() {
		a.sessions.RemoveObserver(c)
		a.hub.Remove(c)
	}()
	c.Serve(r.Context())
}

func sessionTokenOf(r *http.Request) string {
	if c, err := r.Cookie(auth.CookieName); err == nil {
		return c.Value
	}
	return ""
}

// maxWSRead caps a single WebSocket message: frame header plus max payload,
// with some headroom.
const maxWSRead = protocol.HeaderSize + protocol.MaxPayload + 1024

// ---------- Devices ----------

func (a *Agent) handleListDevices(w http.ResponseWriter, r *http.Request) {
	devs, err := a.store.ListDevices()
	if err != nil {
		a.writeError(w, http.StatusInternalServerError, "internal", "Failed to list devices")
		return
	}
	cur := deviceFrom(r)
	out := make([]map[string]any, 0, len(devs))
	for _, d := range devs {
		out = append(out, map[string]any{
			"id": d.ID, "name": d.Name, "created_at": d.CreatedAt,
			"last_seen_at": d.LastSeenAt, "last_ip": d.LastIP,
			// current marks the requesting device; the UI asks for extra
			// confirmation so users don't revoke themselves by accident.
			"current": cur != nil && d.ID == cur.ID,
		})
	}
	a.writeJSON(w, http.StatusOK, out)
}

func (a *Agent) handlePatchDevice(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, maxJSONBody)).Decode(&body); err != nil || body.Name == "" {
		a.writeError(w, http.StatusBadRequest, "bad_request", "Missing name")
		return
	}
	if err := a.store.RenameDevice(r.PathValue("id"), body.Name); err != nil {
		a.writeError(w, http.StatusInternalServerError, "internal", "Rename failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *Agent) handleRevokeDevice(w http.ResponseWriter, r *http.Request) {
	if err := a.store.RevokeDevice(r.PathValue("id"), time.Now()); err != nil {
		a.writeError(w, http.StatusInternalServerError, "internal", "Revoke failed")
		return
	}
	a.log.Info("device revoked", "device", r.PathValue("id"))
	w.WriteHeader(http.StatusNoContent)
}

func (a *Agent) handleRevokeAll(w http.ResponseWriter, r *http.Request) {
	n, err := a.store.RevokeAllDevices(time.Now())
	if err != nil {
		a.writeError(w, http.StatusInternalServerError, "internal", "Revoke failed")
		return
	}
	a.auth.ClearSessionCookie(w) // including our own
	a.log.Warn("all devices revoked", "count", n)
	a.writeJSON(w, http.StatusOK, map[string]any{"revoked": n})
}

// ---------- Helpers ----------

func (a *Agent) writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	if err := json.NewEncoder(w).Encode(v); err != nil && !errors.Is(err, http.ErrHandlerTimeout) {
		a.log.Debug("write response failed", "err", err)
	}
}

func (a *Agent) writeError(w http.ResponseWriter, status int, code, message string) {
	a.writeJSON(w, status, map[string]string{"code": code, "message": message})
}
