// Package agent 是 HTTP 层：路由、认证中间件、TLS、生命周期。
//
// 见 docs/20-architecture/overview.md 与 docs/60-security/auth-pairing.md。
package agent

import (
	"io"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/sunhaijun/webterm/internal/auth"
	"github.com/sunhaijun/webterm/internal/session"
	"github.com/sunhaijun/webterm/internal/store"
	"github.com/sunhaijun/webterm/internal/transcript"
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
	MaxHistory int
	Version    string
	Logger     *slog.Logger
	// TranscriptHome 是找 ~/.claude/projects 与 ~/.codex/sessions 的 home（ADR-0012 β）。
	// 空 = 当前用户的 home；测试与 E2E 用 WEBTERM_TRANSCRIPT_HOME 指到临时目录。
	TranscriptHome string

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
	// transcripts 跟踪前台 claude / codex 的会话文件（ADR-0012 β）
	transcripts *transcript.Service
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
	home := cfg.TranscriptHome
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	a.transcripts = transcript.New(transcript.DefaultRoots(home), sessions.Fanout)
	sessions.SetCommandObserver(a.transcripts)
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

	a.mux.Handle("GET /api/commands", a.requireAuth(http.HandlerFunc(a.handleListCommands)))
	a.mux.Handle("POST /api/commands", a.requireAuth(http.HandlerFunc(a.handleNewSnippet)))
	a.mux.Handle("PATCH /api/commands", a.requireAuth(http.HandlerFunc(a.handleReorderCommands)))
	a.mux.Handle("PATCH /api/commands/{id}", a.requireAuth(http.HandlerFunc(a.handlePatchCommand)))
	a.mux.Handle("DELETE /api/commands/{id}", a.requireAuth(http.HandlerFunc(a.handleDeleteCommand)))
	a.mux.Handle("DELETE /api/commands", a.requireAuth(http.HandlerFunc(a.handleClearCommands)))

	// 写态路径补全（ADR-0011 ③）：与 shell 同权限，见 fs.go
	a.mux.Handle("GET /api/fs", a.requireAuth(http.HandlerFunc(a.handleFS)))
	// AI CLI 会话转录回放（ADR-0012 β），见 transcript.go
	a.mux.Handle("GET /api/transcript", a.requireAuth(http.HandlerFunc(a.handleTranscript)))

	a.mux.Handle("GET /api/settings", a.requireAuth(http.HandlerFunc(a.handleGetSettings)))
	a.mux.Handle("PATCH /api/settings", a.requireAuth(http.HandlerFunc(a.handlePatchSettings)))
}

// PurgeLoop 周期性清理过期配对码与超额历史。
func (a *Agent) PurgeLoop(stop <-chan struct{}) {
	t := time.NewTicker(time.Hour)
	defer t.Stop()
	purge := func() {
		if _, err := a.store.PurgePairings(time.Now()); err != nil {
			a.log.Warn("清理配对码失败", "err", err)
		}
		if a.cfg.MaxHistory > 0 {
			if _, err := a.store.Evict(a.cfg.MaxHistory); err != nil {
				a.log.Warn("淘汰历史失败", "err", err)
			}
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
