// Package agent is the HTTP layer: routing, auth middleware, TLS and
// lifecycle.
//
// See docs/20-architecture/overview.md and docs/60-security/auth-pairing.md.
package agent

import (
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/sunhaijun/webterm/internal/auth"
	"github.com/sunhaijun/webterm/internal/commands"
	"github.com/sunhaijun/webterm/internal/session"
	"github.com/sunhaijun/webterm/internal/store"
	"github.com/sunhaijun/webterm/internal/uploads"
	"github.com/sunhaijun/webterm/internal/wsconn"
)

// Config is the agent's runtime configuration.
type Config struct {
	Domain string
	// HTTPSPort is the public HTTPS port. Origin checks need it: on a port
	// other than 443 the browser's Origin includes the port.
	HTTPSPort  int
	Dev        bool
	TrustProxy bool
	MaxConns   int
	Version    string
	Logger     *slog.Logger

	// The fields below exist only for integration tests; production uses
	// the defaults.
	WSIdleTimeout   time.Duration
	WSWriteQueueMax int
	// CertReport receives the certificate warm-up report. Empty in
	// production: success goes to stdout, failure to stderr. Tests pass a
	// buffer so they can assert on both.
	CertReport io.Writer
	// UploadRoot replaces <temp>/webterm-<uid> as the directory for files
	// sent to sessions (ADR-0051).
	UploadRoot string
	// Home replaces the user's home directory as where GET /api/history and
	// GET /api/commands find the programs' files (ADR-0057). Tests set it.
	Home string
	// CommandsFile is where the command strip's arrangement is kept
	// (~/.config/webterm/commands.json, ADR-0057 §5). Empty: arrangements
	// can't be saved.
	CommandsFile string
	// ProbeDir is the private directory claude's command probe runs in;
	// default <temp>/webterm-<uid>/probe.
	ProbeDir string
}

// Agent stitches the store, auth, sessions and connection layer into one
// HTTP service.
type Agent struct {
	cfg      Config
	log      *slog.Logger
	store    *store.Store
	auth     *auth.Auth
	sessions *session.Manager
	hub      *wsconn.Hub
	uploads  *uploads.Store
	prober   *commands.Prober
	cmdStore *commands.Store
	mux      *http.ServeMux
}

// New assembles an Agent.
func New(cfg Config, st *store.Store, sessions *session.Manager) *Agent {
	log := cfg.Logger
	if log == nil {
		log = slog.Default()
	}
	a := &Agent{
		cfg:      cfg,
		log:      log,
		store:    st,
		auth:     auth.New(st, cfg.Dev, cfg.TrustProxy),
		sessions: sessions,
		hub:      wsconn.NewHub(cfg.MaxConns),
		uploads:  uploads.New(cfg.UploadRoot),
		prober:   commands.NewProber(probeDir(cfg)),
		cmdStore: &commands.Store{Path: cfg.CommandsFile},
		mux:      http.NewServeMux(),
	}
	a.routes()
	return a
}

// Auth returns the auth service; the CLI's pair subcommand uses it.
func (a *Agent) Auth() *auth.Auth { return a.auth }

// Hub returns the connection hub; graceful shutdown broadcasts a notice
// through it.
func (a *Agent) Hub() *wsconn.Hub { return a.hub }

// Handler returns the handler wrapped in global middleware.
func (a *Agent) Handler() http.Handler {
	return a.securityHeaders(a.mux)
}

// routes defines the routes and their auth requirements.
//
// The auth matrix is in docs/60-security/auth-pairing.md. The easiest one to
// miss: /ws must require auth; the middleware cannot wrap only REST (AC-1.7).
func (a *Agent) routes() {
	// No auth: static assets, the pairing page and endpoint, health check.
	a.mux.Handle("GET /", a.staticHandler())
	a.mux.Handle("GET /pair", a.staticHandler())
	// The service worker and manifest must not require auth: they are part
	// of the static shell, and the SW registers before the page has any data.
	a.mux.Handle("GET /sw.js", a.staticHandler())
	a.mux.Handle("GET /manifest.json", a.staticHandler())
	a.mux.HandleFunc("POST /auth/pair", a.handlePair)
	a.mux.Handle("POST /auth/logout", a.requireAuth(a.sameOrigin(http.HandlerFunc(a.handleLogout))))
	a.mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok")) // reveals nothing, not even the version
	})

	// Auth required.
	a.mux.Handle("GET /ws", a.requireAuth(http.HandlerFunc(a.handleWS)))
	a.mux.Handle("GET /api/devices", a.requireAuth(http.HandlerFunc(a.handleListDevices)))
	a.mux.Handle("PATCH /api/devices/{id}", a.requireAuth(a.sameOrigin(http.HandlerFunc(a.handlePatchDevice))))
	a.mux.Handle("DELETE /api/devices/{id}", a.requireAuth(a.sameOrigin(http.HandlerFunc(a.handleRevokeDevice))))
	a.mux.Handle("POST /api/devices/revoke-all", a.requireAuth(a.sameOrigin(http.HandlerFunc(a.handleRevokeAll))))
	a.mux.Handle("POST /api/uploads", a.requireAuth(a.sameOrigin(http.HandlerFunc(a.handleUpload))))
	a.mux.Handle("GET /api/history", a.requireAuth(http.HandlerFunc(a.handleHistory)))
	a.mux.Handle("GET /api/commands", a.requireAuth(http.HandlerFunc(a.handleCommands)))
	a.mux.Handle("PUT /api/commands", a.requireAuth(a.sameOrigin(http.HandlerFunc(a.handlePutCommands))))
	a.mux.Handle("DELETE /api/commands", a.requireAuth(a.sameOrigin(http.HandlerFunc(a.handleDeleteCommands))))

	// Every other /api/* path authenticates first, then 404s (auth matrix:
	// /api/* ✓). Without this they would fall through to the SPA fallback on
	// GET / and return 200 + index.html even unauthenticated, as the removed
	// /api/commands, /api/fs and /api/settings did (ADR-0026 §6).
	//
	// Register per method: a method-less "/api/" conflicts with "GET /" in
	// ServeMux.
	apiNotFound := a.requireAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a.writeError(w, http.StatusNotFound, "not_found", "No such endpoint")
	}))
	for _, m := range []string{"GET", "POST", "PUT", "PATCH", "DELETE"} {
		a.mux.Handle(m+" /api/", apiNotFound)
	}
}

// PurgeLoop periodically deletes expired pairing codes and uploads older
// than a day (ADR-0051 §5).
func (a *Agent) PurgeLoop(stop <-chan struct{}) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	purge := func() {
		if _, err := a.store.PurgePairings(time.Now()); err != nil {
			a.log.Warn("purge pairing codes failed", "err", err)
		}
		if n, err := a.uploads.Sweep(); err != nil {
			a.log.Warn("sweeping uploads failed", "err", err)
		} else if n > 0 {
			a.log.Debug("swept uploads", "removed", n)
		}
	}
	purge() // once at startup
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			purge()
		}
	}
}
