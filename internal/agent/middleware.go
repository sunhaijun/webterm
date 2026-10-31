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

// deviceFrom 取出中间件放进 context 的设备。
func deviceFrom(r *http.Request) *store.Device {
	d, _ := r.Context().Value(deviceKey).(*store.Device)
	return d
}

// requireAuth 是认证中间件。
//
// **它必须覆盖 WebSocket 升级路径**，不能只包 REST —— 这是整个认证矩阵里
// 最容易漏的一条（AC-1.7 / 威胁模型 T1）。
func (a *Agent) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		dev, err := a.auth.Authenticate(r)
		if err != nil {
			a.writeError(w, http.StatusInternalServerError, "internal", "认证检查失败")
			return
		}
		if dev == nil {
			a.auth.ClearSessionCookie(w)
			a.writeError(w, http.StatusUnauthorized, "unauthorized", "需要配对")
			return
		}
		a.auth.MaybeRenew(w, r, dev, time.Now())
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), deviceKey, dev)))
	})
}

// securityHeaders 给所有响应加安全头。
func (a *Agent) securityHeaders(next http.Handler) http.Handler {
	// 终端输出由 xterm 的 DOM 渲染器逐格写 textContent，从不当 HTML 解析；会话名与 CWD
	// 同样按文本渲染（threat-model.md T5）。CSP 是兜底：哪里漏了也执行不了外来脚本。
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
			// --dev 下不发 HSTS：localhost 是明文
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		next.ServeHTTP(w, r)
	})
}

// checkOrigin 校验 WebSocket 握手的 Origin。
//
// WebSocket 握手【不受 CORS 保护】。虽然现代浏览器对 SameSite=Strict 的
// Cookie 在 WS 握手时也不发送，但这个行为历史上有过差异 —— Origin 校验是
// 必需的第二道防线（AC-1.8 / 威胁模型 T4）。
func (a *Agent) checkOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		// 非浏览器客户端（wscat / 集成测试）不带 Origin。
		// 它们仍然要过 Cookie 认证，所以这不是一条旁路。
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

// allowedOrigin 是浏览器该发过来的那个 Origin。
//
// 【必须带上非默认端口】。页面在 https://域名:8443 上时浏览器发的
// Origin 就是 https://域名:8443，拿不带端口的去比必然不等 ——
// 于是 /ws 被 403，手机端表现为"一直在重试连接"，而且服务端
// 什么日志都没有。--https-port 那个特性让对外 URL 带上了端口，
// 这里当时漏了。
//
// 复用 externalURL：配对二维码、301 跳转、启动日志都走它，
// 一处定义就不会再漂。
func (a *Agent) allowedOrigin() string {
	return externalURL(a.cfg.Domain, a.cfg.HTTPSPort)
}

// isLocalOrigin 报告 origin 是不是本机地址（仅 --dev 下允许）。
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
