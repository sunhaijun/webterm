package agent

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/crypto/acme"
	"golang.org/x/crypto/acme/autocert"
)

// ServeConfig 是监听与 TLS 的配置。
//
// TLS 代码路径只有两条（ADR-0004）：生产走 ACME，--dev 走 localhost 明文。
// --no-tls 是第三条，但它只允许绑回环/私有地址，用于用户自己套反代/隧道。
type ServeConfig struct {
	Domain      string
	Dev         bool
	NoTLS       bool
	ACMEStaging bool
	Bind        string
	HTTPPort    int
	HTTPSPort   int
	CertDir     string
}

// Servers 是启动后的服务器句柄，用于优雅关闭。
type Servers struct {
	https *http.Server
	http  *http.Server
}

// Listen 按配置启动监听。阻塞直到出错或被 Shutdown。
func (a *Agent) Listen(cfg ServeConfig, handler http.Handler) (*Servers, <-chan error, error) {
	errCh := make(chan error, 2)
	s := &Servers{}

	switch {
	case cfg.Dev:
		addr := fmt.Sprintf("127.0.0.1:%d", cfg.HTTPPort)
		s.http = &http.Server{Addr: addr, Handler: handler, ReadHeaderTimeout: 10 * time.Second}
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			return nil, nil, describeBindError(err, cfg.HTTPPort)
		}
		go func() { errCh <- s.http.Serve(ln) }()
		a.log.Info("webterm 已启动（开发模式）", "url", "http://"+addr)

	case cfg.NoTLS:
		// 反代/隧道场景：TLS 由前面那层终结
		if !isLoopbackOrPrivate(cfg.Bind) {
			return nil, nil, fmt.Errorf(
				"--no-tls 只允许绑回环或私有地址，当前 --bind=%s；"+
					"把 webterm 明文暴露到公网等于把 shell 送人", cfg.Bind)
		}
		addr := fmt.Sprintf("%s:%d", cfg.Bind, cfg.HTTPPort)
		s.http = &http.Server{Addr: addr, Handler: handler, ReadHeaderTimeout: 10 * time.Second}
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			return nil, nil, describeBindError(err, cfg.HTTPPort)
		}
		go func() { errCh <- s.http.Serve(ln) }()
		a.log.Info("webterm 已启动（明文，等待反代接管 TLS）", "addr", addr)

	default:
		if cfg.Domain == "" {
			return nil, nil, errors.New("生产模式必须指定 --domain（ACME 需要它），或用 --dev")
		}
		m := &autocert.Manager{
			Prompt: autocert.AcceptTOS,
			Cache:  autocert.DirCache(cfg.CertDir),
			// HostPolicy 严格限定为 --domain 的值，【绝不通配】——
			// 否则会被用来给任意域名申请证书（威胁模型 T8）
			HostPolicy: autocert.HostWhitelist(cfg.Domain),
		}
		if cfg.ACMEStaging {
			m.Client = &acme.Client{DirectoryURL: "https://acme-staging-v02.api.letsencrypt.org/directory"}
		}
		if err := os.MkdirAll(cfg.CertDir, 0o700); err != nil {
			return nil, nil, fmt.Errorf("创建证书目录失败: %w", err)
		}
		if err := os.Chmod(cfg.CertDir, 0o700); err != nil {
			return nil, nil, fmt.Errorf("设置证书目录权限失败: %w", err)
		}

		httpsAddr := fmt.Sprintf("%s:%d", cfg.Bind, cfg.HTTPSPort)
		s.https = &http.Server{
			Addr:    httpsAddr,
			Handler: handler,
			TLSConfig: &tls.Config{
				GetCertificate: m.GetCertificate,
				MinVersion:     tls.VersionTLS12,
				NextProtos:     []string{"h2", "http/1.1", acme.ALPNProto},
			},
			ReadHeaderTimeout: 10 * time.Second,
		}
		httpsLn, err := net.Listen("tcp", httpsAddr)
		if err != nil {
			return nil, nil, describeBindError(err, cfg.HTTPSPort)
		}

		// :80 只做两件事：ACME 挑战，以及 301 到 HTTPS
		httpAddr := fmt.Sprintf("%s:%d", cfg.Bind, cfg.HTTPPort)
		s.http = &http.Server{
			Addr:              httpAddr,
			Handler:           m.HTTPHandler(redirectToHTTPS(cfg.Domain, cfg.HTTPSPort)),
			ReadHeaderTimeout: 10 * time.Second,
		}
		httpLn, err := net.Listen("tcp", httpAddr)
		if err != nil {
			httpsLn.Close()
			return nil, nil, describeBindError(err, cfg.HTTPPort)
		}

		go func() { errCh <- s.http.Serve(httpLn) }()
		go func() { errCh <- s.https.ServeTLS(httpsLn, "", "") }()
		a.log.Info("webterm 已启动", "url", "https://"+cfg.Domain)
	}
	return s, errCh, nil
}

// Shutdown 优雅关闭监听（不动会话，那由 session.Manager 负责）。
func (s *Servers) Shutdown(ctx context.Context) {
	if s.https != nil {
		_ = s.https.Shutdown(ctx)
	}
	if s.http != nil {
		_ = s.http.Shutdown(ctx)
	}
}

// redirectToHTTPS 把 :80 上非 ACME 挑战的请求全部 301 到 HTTPS。
func redirectToHTTPS(domain string, httpsPort int) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := domain
		if httpsPort != 443 {
			host = fmt.Sprintf("%s:%d", domain, httpsPort)
		}
		http.Redirect(w, r, "https://"+host+r.URL.RequestURI(), http.StatusMovedPermanently)
	})
}

// describeBindError 把 Go 的 bind 错误翻译成人看得懂的话（US-7.2 / AC-1.13）。
func describeBindError(err error, port int) error {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "address already in use"):
		return fmt.Errorf(
			"%d 端口已被占用。\n"+
				"  查是谁占着：  ss -lntp | grep :%d\n"+
				"  停掉它，或者改用反代模式（见 docs/80-ops/install.md 的「反向代理 / 隧道场景」）",
			port, port)
	case strings.Contains(msg, "permission denied"):
		return fmt.Errorf(
			"没有绑定 %d 端口的权限（1024 以下需要特权）。\n"+
				"  推荐做法：  sudo setcap 'cap_net_bind_service=+ep' $(command -v webterm)\n"+
				"  然后以普通用户重新运行 —— 不要用 root 跑 webterm，那等于把 root shell 挂到公网",
			port)
	}
	return fmt.Errorf("监听 %d 端口失败: %w", port, err)
}

// isLoopbackOrPrivate 报告地址是不是回环或私有地址。
func isLoopbackOrPrivate(bind string) bool {
	if bind == "" {
		return false
	}
	ip := net.ParseIP(bind)
	if ip == nil {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()
}

// CertDirDefault 返回默认的证书缓存目录。
func CertDirDefault(dataDir string) string { return filepath.Join(dataDir, "certs") }
