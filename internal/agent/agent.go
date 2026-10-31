// Package agent 是 HTTP 层：路由、认证中间件、TLS、生命周期。
//
// 见 docs/20-architecture/overview.md 与 docs/60-security/auth-pairing.md。
package agent

import (
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/sunhaijun/webterm/internal/auth"
	"github.com/sunhaijun/webterm/internal/session"
	"github.com/sunhaijun/webterm/internal/store"
	"github.com/sunhaijun/webterm/internal/wsconn"
)

// Config 是 agent 的运行配置。
type Config struct {
	Domain string
	// HTTPSPort 是【对外】的 HTTPS 端口。Origin 校验要用它 ——
	// 浏览器在非 443 端口上发的 Origin 带着端口号。
	HTTPSPort  int
	Dev        bool
	TrustProxy bool
	MaxConns   int
	Version    string
	Logger     *slog.Logger

	// 下面几个只为集成测试而存在，生产走默认值。
	WSIdleTimeout   time.Duration
	WSWriteQueueMax int
	// CertReport 把证书预热的结果重定向到这里。生产留空：
	// 成功走 stdout、失败走 stderr。测试里给一个 buffer，两者都能断言。
	CertReport io.Writer
}

// Agent 把 store / auth / session / 连接层缝成一个 HTTP 服务。
type Agent struct {
	cfg      Config
	log      *slog.Logger
	store    *store.Store
	auth     *auth.Auth
	sessions *session.Manager
	hub      *wsconn.Hub
	mux      *http.ServeMux
}

// New 组装 agent。
func New(cfg Config, st *store.Store, sessions *session.Manager) *Agent {
	log := cfg.Logger
	if log == nil {
		log = slog.Default()
	}
	a := &Agent{
		cfg:      cfg,
		log:      log,
		store:    st,
		auth:     auth.New(st, cfg.Dev),
		sessions: sessions,
		hub:      wsconn.NewHub(cfg.MaxConns),
		mux:      http.NewServeMux(),
	}
	a.routes()
	return a
}

// Auth 暴露认证服务（CLI 的 pair 子命令要用）。
func (a *Agent) Auth() *auth.Auth { return a.auth }

// Hub 暴露连接表（优雅关闭时要广播 notice）。
func (a *Agent) Hub() *wsconn.Hub { return a.hub }

// Handler 返回带全局中间件的处理器。
func (a *Agent) Handler() http.Handler {
	return a.securityHeaders(a.mux)
}

// routes 定义路由与它们的认证要求。
//
// 认证矩阵见 docs/60-security/auth-pairing.md。最容易漏的一条是
// **/ws 必须认证** —— 中间件不能只包 REST（AC-1.7）。
func (a *Agent) routes() {
	// 不需要认证：静态资源、配对页与配对接口、健康检查
	a.mux.Handle("GET /", a.staticHandler())
	a.mux.Handle("GET /pair", a.staticHandler())
	// Service Worker 与 manifest 必须免认证：它们是静态壳的一部分，
	// 而且 SW 的注册发生在页面还没拿到任何数据之前
	a.mux.Handle("GET /sw.js", a.staticHandler())
	a.mux.Handle("GET /manifest.json", a.staticHandler())
	a.mux.HandleFunc("POST /auth/pair", a.handlePair)
	a.mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write([]byte("ok")) // 不泄露任何信息，连版本号都不给
	})

	// 需要认证
	a.mux.Handle("GET /ws", a.requireAuth(http.HandlerFunc(a.handleWS)))
	a.mux.Handle("GET /api/devices", a.requireAuth(http.HandlerFunc(a.handleListDevices)))
	a.mux.Handle("PATCH /api/devices/{id}", a.requireAuth(http.HandlerFunc(a.handlePatchDevice)))
	a.mux.Handle("DELETE /api/devices/{id}", a.requireAuth(http.HandlerFunc(a.handleRevokeDevice)))
	a.mux.Handle("POST /api/devices/revoke-all", a.requireAuth(http.HandlerFunc(a.handleRevokeAll)))

	// 其余 /api/* 一律先认证、再 404（路由认证矩阵：/api/* ✓）。不兜住的话它们会
	// 落进 GET / 的 SPA 回退，未认证也能拿到 200 + index.html —— 删掉的
	// /api/commands、/api/fs、/api/settings（ADR-0026 §6）就是这么一批路径。
	//
	// 按方法逐个登记：不带方法的 "/api/" 与 "GET /" 在 ServeMux 里算冲突。
	apiNotFound := a.requireAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a.writeError(w, http.StatusNotFound, "not_found", "没有这个接口")
	}))
	for _, m := range []string{"GET", "POST", "PUT", "PATCH", "DELETE"} {
		a.mux.Handle(m+" /api/", apiNotFound)
	}
}

// PurgeLoop 周期性清理过期配对码。
func (a *Agent) PurgeLoop(stop <-chan struct{}) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	purge := func() {
		if _, err := a.store.PurgePairings(time.Now()); err != nil {
			a.log.Warn("清理配对码失败", "err", err)
		}
	}
	purge() // 启动时先跑一次
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			purge()
		}
	}
}
