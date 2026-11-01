package agent

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/crypto/acme"
	"golang.org/x/crypto/acme/autocert"

	"github.com/sunhaijun/webterm/internal/handoff"
)

// ServeConfig 是监听与 TLS 的配置。
//
// TLS 代码路径只有两条（ADR-0004）：生产走 ACME，--dev 走 localhost 明文。
// --no-tls 是第三条，但它只允许绑回环/私有地址，用于用户自己套反代/隧道。
type ServeConfig struct {
	Domain    string
	Dev       bool
	NoTLS     bool
	Bind      string
	HTTPPort  int
	HTTPSPort int
	CertDir   string

	// ACMEDirectoryURL 只为集成测试而存在：指向本地假 CA
	// （internal/acmetest）。生产留空，走 Let's Encrypt。
	ACMEDirectoryURL string

	// Inherited 是热升级交接过来的监听 fd（name → fd，name 为 "http" / "https"），
	// 有就接着用而不是重新 bind —— 端口不会有一瞬间没人听（ADR-0016）。
	Inherited map[string]int
}

// Servers 是启动后的服务器句柄，用于优雅关闭与热升级导出监听。
type Servers struct {
	https *http.Server
	http  *http.Server
	lns   map[string]net.Listener
	// stop 停掉后台的证书循环（IP 模式的续期，ADR-0044）
	stop context.CancelFunc
}

// listen 按名字开监听：交接过来的 fd 优先，否则新 bind。
func (s *Servers) listen(cfg ServeConfig, name, addr string) (net.Listener, error) {
	if s.lns == nil {
		s.lns = make(map[string]net.Listener)
	}
	if fd, ok := cfg.Inherited[name]; ok {
		f := os.NewFile(uintptr(fd), name)
		if f == nil {
			return nil, fmt.Errorf("交接的监听 fd %d（%s）无效", fd, name)
		}
		ln, err := net.FileListener(f)
		_ = f.Close() // FileListener 自己 dup 了一份
		if err != nil {
			return nil, fmt.Errorf("接回监听 %s: %w", name, err)
		}
		s.lns[name] = ln
		return ln, nil
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	s.lns[name] = ln
	return ln, nil
}

// ExportListeners 把监听 socket 复制成可继承的 fd（ADR-0016）。
// 返回的 *os.File 要一直持有到 exec，之后由内核在旧映像销毁时关掉。
// 出错时已导出的都关掉：它们清了 CLOEXEC，留着会被之后起的 shell 继承。
func (s *Servers) ExportListeners() ([]handoff.Listener, []*os.File, error) {
	var out []handoff.Listener
	var files []*os.File
	fail := func(err error) ([]handoff.Listener, []*os.File, error) {
		for _, f := range files {
			f.Close()
		}
		return nil, nil, err
	}
	for name, ln := range s.lns {
		tl, ok := ln.(*net.TCPListener)
		if !ok {
			continue
		}
		f, err := tl.File()
		if err != nil {
			return fail(fmt.Errorf("导出监听 %s: %w", name, err))
		}
		files = append(files, f)
		if err := handoff.Inherit(int(f.Fd())); err != nil {
			return fail(err)
		}
		out = append(out, handoff.Listener{Name: name, FD: int(f.Fd())})
	}
	return out, files, nil
}

// Listen 按配置启动监听，立刻返回；服务出错从返回的 channel 报上来。
func (a *Agent) Listen(cfg ServeConfig, handler http.Handler) (*Servers, <-chan error, error) {
	errCh := make(chan error, 2)
	s := &Servers{}

	switch {
	case cfg.Dev:
		addr := fmt.Sprintf("127.0.0.1:%d", cfg.HTTPPort)
		s.http = &http.Server{Addr: addr, Handler: handler, ReadHeaderTimeout: 10 * time.Second,
			ErrorLog: a.httpErrorLog()}
		ln, err := s.listen(cfg, "http", addr)
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
		s.http = &http.Server{Addr: addr, Handler: handler, ReadHeaderTimeout: 10 * time.Second,
			ErrorLog: a.httpErrorLog()}
		ln, err := s.listen(cfg, "http", addr)
		if err != nil {
			return nil, nil, describeBindError(err, cfg.HTTPPort)
		}
		go func() { errCh <- s.http.Serve(ln) }()
		a.log.Info("webterm 已启动（明文，等待反代接管 TLS）", "addr", addr)

	default:
		if cfg.Domain == "" {
			return nil, nil, errors.New("生产模式必须指定 --domain（域名或公网 IPv4，ACME 需要它），或用 --dev")
		}
		if err := CheckAddress(cfg.Domain); err != nil {
			return nil, nil, err
		}
		// 早点拦住：否则第二个 listener 会撞 "address already in use"，
		// 而 describeBindError 会让人去查"谁占着这个端口" —— 占着的是它自己。
		if cfg.HTTPPort == cfg.HTTPSPort {
			return nil, nil, fmt.Errorf(
				"--http-port 和 --https-port 不能相同（都是 %d）。\n"+
					"  ACME 挑战与跳转走 --http-port，HTTPS 服务走 --https-port，是两个监听",
				cfg.HTTPPort)
		}
		if err := prepareCertDir(cfg.CertDir); err != nil {
			return nil, nil, err
		}
		src, warm := a.certSource(cfg)
		ctx, cancel := context.WithCancel(context.Background())
		s.stop = cancel

		httpsAddr := fmt.Sprintf("%s:%d", cfg.Bind, cfg.HTTPSPort)
		s.https = &http.Server{
			Addr:              httpsAddr,
			Handler:           handler,
			TLSConfig:         tlsConfigFor(cfg, src),
			ReadHeaderTimeout: 10 * time.Second,
			ErrorLog:          a.httpErrorLog(),
		}
		httpsLn, err := s.listen(cfg, "https", httpsAddr)
		if err != nil {
			cancel()
			return nil, nil, describeBindError(err, cfg.HTTPSPort)
		}

		// :80 只做两件事：ACME 挑战，以及 301 到 HTTPS
		httpAddr := fmt.Sprintf("%s:%d", cfg.Bind, cfg.HTTPPort)
		s.http = &http.Server{
			Addr:              httpAddr,
			Handler:           src.HTTPHandler(redirectToHTTPS(cfg.Domain, cfg.HTTPSPort)),
			ReadHeaderTimeout: 10 * time.Second,
			ErrorLog:          a.httpErrorLog(),
		}
		httpLn, err := s.listen(cfg, "http", httpAddr)
		if err != nil {
			cancel()
			httpsLn.Close()
			return nil, nil, describeBindError(err, cfg.HTTPPort)
		}

		go func() { errCh <- s.http.Serve(httpLn) }()
		go func() { errCh <- s.https.ServeTLS(httpsLn, "", "") }()
		a.log.Info("webterm 已启动", "url", ExternalURL(cfg.Domain, cfg.HTTPSPort))

		// 主动预热证书。
		//
		// autocert 默认是【懒加载】的：证书要等第一次 TLS 握手才去申请。
		// 那意味着启动时看不出 ACME 通不通 —— 用户得开浏览器才知道。
		// 这里主动触发一次，成功打出到期时间，失败给可读诊断（AC-1.13）。
		// IP 模式下它还是续期循环（ADR-0044）：自管的证书没有 autocert 的定时器。
		go warm(ctx)
	}
	return s, errCh, nil
}

// certSource 是 HTTPS 的证书来源：域名走 autocert，IP 走自管的 ipCertManager。
type certSource interface {
	GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error)
	HTTPHandler(fallback http.Handler) http.Handler
}

// certSource 按 --domain 选证书来源，并给出启动后要跑的预热（IP 模式下兼续期）。
func (a *Agent) certSource(cfg ServeConfig) (certSource, func(context.Context)) {
	if IsIPAddress(cfg.Domain) {
		m := newIPCertManager(cfg)
		return m, func(ctx context.Context) { a.runIPCert(ctx, m) }
	}
	m := newCertManager(cfg)
	return m, func(context.Context) { a.warmCertificate(m, cfg.Domain) }
}

// tlsConfigFor 是 HTTPS 监听的 TLS 配置。
//
// 域名模式要带 acme-tls/1：autocert 先试 TLS-ALPN-01，续期在 80 关掉后也能走 443。
// IP 模式只走 HTTP-01（ADR-0044 §2），不声明它。
func tlsConfigFor(cfg ServeConfig, src certSource) *tls.Config {
	protos := []string{"h2", "http/1.1"}
	if !IsIPAddress(cfg.Domain) {
		protos = append(protos, acme.ALPNProto)
	}
	return &tls.Config{
		GetCertificate: src.GetCertificate,
		MinVersion:     tls.VersionTLS12,
		NextProtos:     protos,
	}
}

func prepareCertDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("创建证书目录失败: %w", err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return fmt.Errorf("设置证书目录权限失败: %w", err)
	}
	return nil
}

// IssueCheck 是 webterm doctor --acme 的核心（ADR-0045 §4）：临时监听
// http / https 两个端口，把证书签好存进 cfg.CertDir（就是服务用的 certs/），
// 返回叶子证书，然后释放端口。issued 报告这次是不是真的找 CA 签了一张 ——
// 缓存里已经有有效证书时直接用它，不多签。
//
// 它证明的是机器内部唯一查不出来的那件事：CA 从公网连得进来
// （云安全组、NAT、运营商封 80）。签的是【正式】证书：成功的那次就是正式签发，
// 服务启动直接用；失败只消耗按小时计的失败额度（ADR-0044 §3），用不着 staging。
func IssueCheck(ctx context.Context, cfg ServeConfig) (leaf *x509.Certificate, issued bool, err error) {
	if err := CheckAddress(cfg.Domain); err != nil {
		return nil, false, err
	}
	if err := prepareCertDir(cfg.CertDir); err != nil {
		return nil, false, err
	}
	// 缓存文件签前签后比一比，就知道是新签的还是现成的 —— 两种模式缓存都在 certs/<地址>
	cachePath := filepath.Join(cfg.CertDir, cfg.Domain)
	before, _ := os.ReadFile(cachePath)
	var src certSource
	var issue func(context.Context) (*tls.Certificate, error)
	if IsIPAddress(cfg.Domain) {
		m := newIPCertManager(cfg)
		src = m
		// ensure 而不是 obtain：缓存里有还不到续期时刻的证书就直接用，不多签
		issue = func(ctx context.Context) (*tls.Certificate, error) {
			if _, _, err := m.ensure(ctx); err != nil {
				return nil, err
			}
			c, _ := m.current()
			return c, nil
		}
	} else {
		m := newCertManager(cfg)
		src = m
		issue = func(context.Context) (*tls.Certificate, error) { return m.GetCertificate(warmupHello(cfg.Domain)) }
	}

	httpsLn, err := net.Listen("tcp", fmt.Sprintf("%s:%d", cfg.Bind, cfg.HTTPSPort))
	if err != nil {
		return nil, false, describeBindError(err, cfg.HTTPSPort)
	}
	httpLn, err := net.Listen("tcp", fmt.Sprintf("%s:%d", cfg.Bind, cfg.HTTPPort))
	if err != nil {
		httpsLn.Close()
		return nil, false, describeBindError(err, cfg.HTTPPort)
	}
	quiet := log.New(io.Discard, "", 0)
	hs := &http.Server{Handler: http.NotFoundHandler(), TLSConfig: tlsConfigFor(cfg, src),
		ReadHeaderTimeout: 10 * time.Second, ErrorLog: quiet}
	h := &http.Server{Handler: src.HTTPHandler(nil), ReadHeaderTimeout: 10 * time.Second, ErrorLog: quiet}
	go func() { _ = hs.ServeTLS(httpsLn, "", "") }()
	go func() { _ = h.Serve(httpLn) }()
	defer func() {
		sctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = hs.Shutdown(sctx)
		_ = h.Shutdown(sctx)
	}()

	cert, err := issue(ctx)
	if err != nil {
		// 直接给人看的诊断（与启动时同一套），doctor 原样打印
		return nil, false, errors.New(strings.TrimSpace(describeACMEError(err, cfg.Domain)))
	}
	after, _ := os.ReadFile(cachePath)
	issued = !bytes.Equal(before, after)
	if cert.Leaf != nil {
		return cert.Leaf, issued, nil
	}
	leaf, err = x509.ParseCertificate(cert.Certificate[0])
	return leaf, issued, err
}

// newCertManager 构造 autocert.Manager。
//
// 单独抽出来是为了能单测两条性质：HostPolicy 不通配，以及 RenewBefore 留空。
func newCertManager(cfg ServeConfig) *autocert.Manager {
	// 只为域名服务。IP 走 ipCertManager（ADR-0044）：autocert 只会下 dns 订单。
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
func (a *Agent) warmCertificate(m *autocert.Manager, domain string) {
	const env = "Let's Encrypt"
	cert, err := m.GetCertificate(warmupHello(domain))
	if err != nil {
		a.log.Error("证书申请失败 —— HTTPS 还不可用", "domain", domain, "env", env)
		fmt.Fprint(a.certReport(true), describeACMEError(err, domain))
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

// httpErrorLog 把 net/http 的内部错误接进 slog，并【把握手噪音降到 DEBUG】。
//
// webterm 的端口对整个互联网开放（威胁模型 T-net），扫描器会持续制造
// "http: TLS handshake error from ..." —— 拿 IP 直连没有 SNI、发纯 HTTP、
// 连上不说话到超时，每一种都是一行。而 slog.SetDefault 会把 net/http 默认用的
// log.Logger 输出按 INFO 打出来，于是这些噪音会把真正要看的行冲掉：
// 证书预热的结果、绑定失败、会话错误。
//
// 降到 DEBUG 而不是丢掉：排查"我自己连不上"的时候还得看它，
// 加 --log-level debug 就有。
func (a *Agent) httpErrorLog() *log.Logger {
	return log.New(httpLogWriter{log: a.log}, "", 0)
}

type httpLogWriter struct{ log *slog.Logger }

func (w httpLogWriter) Write(p []byte) (int, error) {
	msg := strings.TrimRight(string(p), "\n")
	if strings.HasPrefix(msg, "http: TLS handshake error") {
		w.log.Debug(msg)
	} else {
		// 其它的（比如 panic 恢复、超时）是真的要看的
		w.log.Info(msg)
	}
	return len(p), nil
}

// warmupHello 造一个"像真实浏览器"的 ClientHelloInfo 给预热用。
//
// 【不能传空的 ClientHelloInfo】。autocert 的缓存 key 里含
// isRSA = !supportsECDSA(hello)，而 supportsECDSA 对空 hello 返回 false ——
// 于是预热会签一张 RSA 证书存到 "<域名>+rsa"。真实浏览器都声明 ECDSA，
// 它们的 key 是 "<域名>"，必然 miss，autocert 就在【TLS 握手里】现场再签
// 一张。后果有三个，都很难查：
//
//  1. 每次重启都多签一张，很快撞满 Let's Encrypt 的"重复证书"限额
//     （每周 5 张），之后 HTTPS 直接不可用
//  2. 握手要等整个 ACME 流程走完，ACME 一抖就变成握手失败
//     （日志里是 "missing certificate" 和 ACME 的 4xx）
//  3. "证书已就绪"报的是一张真实客户端根本不用的证书 —— 假的成功
//
// 只预热 ECDSA 这一个槽：那是现代客户端唯一会用的。两个都预热等于
// 主动多签一张，白烧限额。
//
// 回归测试：TestWarmupHitsTheCacheSlotRealClientsUse。
func warmupHello(domain string) *tls.ClientHelloInfo {
	return &tls.ClientHelloInfo{
		ServerName:       domain,
		CipherSuites:     []uint16{tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256},
		SupportedCurves:  []tls.CurveID{tls.CurveP256},
		SignatureSchemes: []tls.SignatureScheme{tls.ECDSAWithP256AndSHA256},
	}
}

// describeACMEError 把 ACME 的失败翻译成"原因 + 怎么修"，
// 而不是甩一行 Go 的 error（US-7.2 / AC-1.13）。domain 可以是 IP（ADR-0044）。
func describeACMEError(err error, domain string) string {
	msg := err.Error()
	ip := IsIPAddress(domain)
	var b strings.Builder
	b.WriteString("\n")
	// 【窄的分支放前面】：下面"连不上"那条匹配得很宽，会盖住这几个。
	switch {
	case strings.Contains(msg, "does not support profiles"),
		strings.Contains(msg, "does not advertise a profile"),
		strings.Contains(msg, "invalidProfile"),
		// Let's Encrypt 对不带 shortlived 的 IP 订单的原话（2026-10 实测）
		strings.Contains(msg, "does not permit IP address identifiers"):
		b.WriteString("  这个 CA 不签 IP 证书 —— 它的目录里没有 shortlived profile。\n")
		b.WriteString("  目前只有 Let's Encrypt 签 IP 证书；不然就改用域名。\n")
	case strings.Contains(msg, "rateLimited"), strings.Contains(msg, "too many"):
		b.WriteString("  撞上了 Let's Encrypt 的限流。\n")
		b.WriteString("  失败的验证按小时限（每小时 5 次）：等一小时再试。\n")
		b.WriteString("  签发成功的次数按周限（每域名 / 每个 IP 每周 50 张，同一组标识每周 5 张）：\n")
		b.WriteString("  通常是反复删 certs/ 造成的，只能等。\n")
	case strings.Contains(msg, "no such host"), strings.Contains(msg, "NXDOMAIN"):
		b.WriteString("  " + domain + " 解析不出来。确认 A/AAAA 记录已经加上并且 TTL 过期了：\n")
		b.WriteString("    dig +short " + domain + "\n")
	case strings.Contains(msg, "not configured in HostWhitelist"):
		b.WriteString("  请求的域名与 --domain 不一致。HostPolicy 刻意不允许通配，\n")
		b.WriteString("  否则会被用来给任意域名申请证书。\n")
	case ip && isChallengeFailure(msg):
		b.WriteString("  CA 没能连上 http://" + domain + "/ 做验证。IP 证书只走 80（HTTP-01）。按顺序查：\n")
		b.WriteString("    1. 云安全组 / 防火墙放行了入方向 TCP 80 吗？（最常漏的一步）\n")
		b.WriteString("         在别的机器上跑：curl -sI http://" + domain + "/\n")
		b.WriteString("    2. " + domain + " 是本机的公网 IP 吗？\n")
		b.WriteString("         curl -s ifconfig.me\n")
	case isChallengeFailure(msg):
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
	return b.String()
}

func isChallengeFailure(msg string) bool {
	for _, k := range []string{"no viable challenge type", "Invalid response", "authorization error",
		"connection refused", "Timeout", "timeout"} {
		if strings.Contains(msg, k) {
			return true
		}
	}
	return false
}

// Shutdown 优雅关闭监听（不动会话，那由 session.Manager 负责）。
func (s *Servers) Shutdown(ctx context.Context) {
	if s.stop != nil {
		s.stop()
	}
	if s.https != nil {
		_ = s.https.Shutdown(ctx)
	}
	if s.http != nil {
		_ = s.http.Shutdown(ctx)
	}
}

// ExternalURL 是【对外可见的地址】：域名 + 非默认端口。
//
// 443 是默认端口，写出来是噪音；不是 443 就必须带上，否则用户拿到的
// 地址是打不开的（443 被别的服务占着时会遇到 —— 见
// docs/80-ops/install.md 的「跑在非标准端口上」）。0 当默认处理，不拼出 :0。
//
// 启动日志、HTTPS 跳转、Origin 校验、配对 URL、状态总览都用它这一条规则。
func ExternalURL(domain string, httpsPort int) string {
	return "https://" + externalHost(domain, httpsPort)
}

func externalHost(domain string, httpsPort int) string {
	if httpsPort != 0 && httpsPort != 443 {
		return fmt.Sprintf("%s:%d", domain, httpsPort)
	}
	return domain
}

// redirectToHTTPS 把 :80 上非 ACME 挑战的请求全部 301 到 HTTPS。
func redirectToHTTPS(domain string, httpsPort int) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := externalHost(domain, httpsPort)
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
