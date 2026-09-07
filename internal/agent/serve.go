package agent

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
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

	// ACMEDirectoryURL 只为集成测试而存在：指向本地假 CA
	// （internal/acmetest）。生产留空，走 Let's Encrypt。
	ACMEDirectoryURL string
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
		m := newCertManager(cfg)
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

		// 主动预热证书。
		//
		// autocert 默认是【懒加载】的：证书要等第一次 TLS 握手才去申请。
		// 那意味着启动时看不出 ACME 通不通 —— 用户得开浏览器才知道，
		// 而 --acme-staging 那一步"先试通再上正式"也就失去了意义。
		// 这里主动触发一次，成功打出到期时间，失败给可读诊断（AC-1.13）。
		go a.warmCertificate(m, cfg.Domain, cfg.ACMEStaging)
	}
	return s, errCh, nil
}

// newCertManager 构造 autocert.Manager。
//
// 单独抽出来是为了能单测两条性质：HostPolicy 不通配，以及 RenewBefore 留空。
func newCertManager(cfg ServeConfig) *autocert.Manager {
	m := &autocert.Manager{
		Prompt: autocert.AcceptTOS,
		Cache:  autocert.DirCache(cfg.CertDir),
		// HostPolicy 严格限定为 --domain 的值，【绝不通配】——
		// 否则会被用来给任意域名申请证书（威胁模型 T8）
		HostPolicy: autocert.HostWhitelist(cfg.Domain),

		// RenewBefore 【刻意留空】。留空时 autocert 用
		// min(30 天, 有效期/3)，会跟着证书有效期自动缩放。
		// 写死 30 天的话，将来换成短周期证书（LE 已在推 6 天期）
		// 就会变成"每次都立刻续期"。
	}
	switch {
	case cfg.ACMEDirectoryURL != "":
		m.Client = &acme.Client{DirectoryURL: cfg.ACMEDirectoryURL}
	case cfg.ACMEStaging:
		m.Client = &acme.Client{DirectoryURL: "https://acme-staging-v02.api.letsencrypt.org/directory"}
	}
	return m
}

// certReport 是证书预热结果的输出目标。
//
// 生产分开走（成功 stdout、失败 stderr），测试里 Config.CertReport
// 把两者收到同一个 buffer，好断言。
func (a *Agent) certReport(failed bool) io.Writer {
	if a.cfg.CertReport != nil {
		return a.cfg.CertReport
	}
	if failed {
		return os.Stderr
	}
	return os.Stdout
}

// warmCertificate 启动时主动申请/加载一次证书，把结果报给用户。
//
// autocert 的续期定时器是在证书【进入内存状态】时挂上的，而它默认懒加载 ——
// 证书要等第一次 TLS 握手才加载。也就是说进程重启后一直没人访问的话，
// 就没有续期定时器。这里主动触发一次，让定时器从启动那一刻就存在。
func (a *Agent) warmCertificate(m *autocert.Manager, domain string, staging bool) {
	env := "Let's Encrypt"
	if staging {
		env = "Let's Encrypt staging"
	}
	cert, err := m.GetCertificate(&tls.ClientHelloInfo{ServerName: domain})
	if err != nil {
		a.log.Error("证书申请失败 —— HTTPS 还不可用", "domain", domain, "env", env)
		fmt.Fprint(a.certReport(true), describeACMEError(err, domain, staging))
		return
	}
	if len(cert.Certificate) == 0 {
		return
	}
	leaf := cert.Leaf
	if leaf == nil {
		parsed, perr := x509.ParseCertificate(cert.Certificate[0])
		if perr != nil {
			a.log.Info("证书已就绪", "env", env)
			return
		}
		leaf = parsed
	}
	// autocert 在到期前 min(30 天, 有效期/3) 自动续期。
	// 续期要重新过域名验证，80（HTTP-01）或 443（TLS-ALPN-01）通一个就够。
	fmt.Fprintf(a.certReport(false), "证书已就绪（%s，到期 %s，自动续期）\n",
		env, leaf.NotAfter.Local().Format("2006-01-02"))
}

// describeACMEError 把 ACME 的失败翻译成"原因 + 怎么修"，
// 而不是甩一行 Go 的 error（US-7.2 / AC-1.13）。
func describeACMEError(err error, domain string, staging bool) string {
	msg := err.Error()
	var b strings.Builder
	b.WriteString("\n")
	// 【窄的分支放前面】：下面"连不上"那条匹配得很宽，会盖住这几个。
	switch {
	case strings.Contains(msg, "rateLimited"), strings.Contains(msg, "too many"):
		b.WriteString("  撞上了 Let's Encrypt 的限流。\n")
		b.WriteString("  限流窗口是一周（每域名每周 50 次签发），撞上了只能等。\n")
	case strings.Contains(msg, "no such host"), strings.Contains(msg, "NXDOMAIN"):
		b.WriteString("  " + domain + " 解析不出来。确认 A/AAAA 记录已经加上并且 TTL 过期了：\n")
		b.WriteString("    dig +short " + domain + "\n")
	case strings.Contains(msg, "not configured in HostWhitelist"):
		b.WriteString("  请求的域名与 --domain 不一致。HostPolicy 刻意不允许通配，\n")
		b.WriteString("  否则会被用来给任意域名申请证书。\n")
	case strings.Contains(msg, "no viable challenge type"),
		strings.Contains(msg, "Invalid response"),
		strings.Contains(msg, "authorization error"),
		strings.Contains(msg, "connection refused"),
		strings.Contains(msg, "Timeout"), strings.Contains(msg, "timeout"):
		// 这是最常见的失败。注意 autocert 会把挑战类型逐个试完，
		// 最后抛出来的是 "no viable challenge type found" ——
		// 【真实故障现场看到的就是这一句】，不是底层的 "Invalid response"。
		b.WriteString("  CA 没能连上本机做域名验证。挑战走 80（HTTP-01）或 443（TLS-ALPN-01），\n")
		b.WriteString("  两个都没通过。按顺序查：\n")
		b.WriteString("    1. 云安全组 / 防火墙放行了入方向 TCP 80 和 443 吗？（最常漏的一步）\n")
		b.WriteString("         在别的机器上跑：curl -sI http://" + domain + "/\n")
		b.WriteString("    2. DNS 指向本机吗？\n")
		b.WriteString("         dig +short " + domain + "   应当等于   curl -s ifconfig.me\n")
		b.WriteString("    3. 用 Cloudflare 的话，把小云朵关掉（DNS only，不要 Proxied）\n")
	default:
		b.WriteString("  " + msg + "\n")
		b.WriteString("  排障清单见 docs/80-ops/troubleshooting.md 的「证书 / TLS」一节。\n")
	}
	if !staging {
		b.WriteString("\n  提示：先用 --acme-staging 调通，避免撞正式环境的限流。\n")
	}
	return b.String()
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
