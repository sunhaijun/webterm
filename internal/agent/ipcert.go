package agent

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/acme"
)

// IP 模式的证书（ADR-0044）。
//
// Let's Encrypt 的 IP 证书只有 shortlived 一种（约 160 小时），而 autocert
// 只会下 dns 订单、只按 SNI 找证书 —— 浏览器连 IP 时根本不发 SNI。
// 所以这里直接用 acme.Client 走一遍 RFC 8555 + RFC 8738，只做 HTTP-01。

const (
	// ipCertProfile 是 Let's Encrypt 签 IP 证书时唯一接受的 profile。
	ipCertProfile = "shortlived"
	// accountKeyFile 与 autocert 的缓存键同名同格式（EC PRIVATE KEY PEM），
	// 一个数据目录只用一个 ACME 账号，从 IP 换到域名时 autocert 也能直接读。
	accountKeyFile = "acme_account+key"
	// ipCertRetry 是签发 / 续期失败后的重试间隔。Let's Encrypt 的失败验证限额是
	// 每个账号每个标识每小时 5 次，一小时一次远在线下。
	ipCertRetry = time.Hour
	// ipCertAttemptTimeout 是一次签发（注册、下单、验证、出证）最多等多久。
	ipCertAttemptTimeout = 5 * time.Minute
)

// IsIPAddress 报告 --domain 是不是 IPv4 字面量（IP 模式）。
func IsIPAddress(addr string) bool {
	ip := net.ParseIP(addr)
	return ip != nil && ip.To4() != nil && !strings.Contains(addr, ":")
}

// CheckAddress 校验 --domain 的取值。空值留给调用方按模式处理。
//
// IPv6 字面量先拒掉：监听地址默认 0.0.0.0、URL 拼接与端口检查都没处理
// 方括号和双栈，让它进来只会在更远的地方以更难懂的方式失败（ADR-0044 §1）。
func CheckAddress(addr string) error {
	if strings.Contains(addr, ":") && net.ParseIP(strings.Trim(addr, "[]")) != nil {
		return fmt.Errorf("--domain %s 是 IPv6 地址，暂只支持 IPv4。\n"+
			"  只有 IPv6 的机器请用域名（加一条 AAAA 记录）", addr)
	}
	return nil
}

// acmeDirectory 是这次要用的 ACME 目录。
func acmeDirectory(cfg ServeConfig) string {
	switch {
	case cfg.ACMEDirectoryURL != "":
		return cfg.ACMEDirectoryURL
	}
	return acme.LetsEncryptURL
}

// ipCertManager 管一张 IP 证书：签发、缓存、续期、握手时交出去。
type ipCertManager struct {
	ip      string
	dirURL  string
	certDir string
	now     func() time.Time

	mu     sync.Mutex
	cert   *tls.Certificate
	tokens map[string]string // HTTP-01：token → key authorization
}

func newIPCertManager(cfg ServeConfig) *ipCertManager {
	return &ipCertManager{
		ip:      cfg.Domain,
		dirURL:  acmeDirectory(cfg),
		certDir: cfg.CertDir,
		now:     time.Now,
		tokens:  map[string]string{},
	}
}

// GetCertificate 不看 SNI —— 连 IP 的客户端不发 SNI。
//
// 【握手从不触发签发】：手里没有证书就失败。签发只由 run 发起，
// 所以不存在「替别人申请证书」这种攻击面（ADR-0004 里 HostPolicy 防的那个）。
func (m *ipCertManager) GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cert == nil {
		return nil, errors.New("IP 证书还没签下来")
	}
	return m.cert, nil
}

// HTTPHandler 应答 HTTP-01 挑战，其它请求交给 fallback（301 到 HTTPS）。
func (m *ipCertManager) HTTPHandler(fallback http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, ok := strings.CutPrefix(r.URL.Path, "/.well-known/acme-challenge/")
		if !ok {
			if fallback == nil {
				http.NotFound(w, r)
				return
			}
			fallback.ServeHTTP(w, r)
			return
		}
		m.mu.Lock()
		ka := m.tokens[token]
		m.mu.Unlock()
		if ka == "" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		_, _ = io.WriteString(w, ka)
	})
}

// renewAt 是该续期的时刻：剩余有效期不到总有效期的 1/3（和 autocert 同一条规则）。
func renewAt(leaf *x509.Certificate) time.Time {
	return leaf.NotAfter.Add(-leaf.NotAfter.Sub(leaf.NotBefore) / 3)
}

// current 返回手里的证书与它的叶子；没有就是 nil。
func (m *ipCertManager) current() (*tls.Certificate, *x509.Certificate) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cert == nil {
		return nil, nil
	}
	return m.cert, m.cert.Leaf
}

// ensure 保证手里有一张还不到续期时刻的证书。
//
// 顺序：内存里的 → 缓存里的 → 找 CA 签新的。【重启只读缓存】：每重启一次
// 就签一张的话，「同一组标识每周 5 张」的限额几天就耗光了。
// renewed 报告这次是不是真的找 CA 签了一张。
func (m *ipCertManager) ensure(ctx context.Context) (leaf *x509.Certificate, renewed bool, err error) {
	if _, l := m.current(); l != nil && m.now().Before(renewAt(l)) {
		return l, false, nil
	}
	if c, err := m.loadCache(); err == nil && m.now().Before(renewAt(c.Leaf)) {
		m.setCert(c)
		return c.Leaf, false, nil
	} else if err == nil {
		// 缓存里的已经该续了，但在新证书到手之前先用着 —— 没过期就比没有强
		m.setCert(c)
	}
	c, err := m.obtain(ctx)
	if err != nil {
		return nil, false, err
	}
	m.setCert(c)
	return c.Leaf, true, nil
}

func (m *ipCertManager) setCert(c *tls.Certificate) {
	m.mu.Lock()
	m.cert = c
	m.mu.Unlock()
}

// obtain 找 CA 签一张新证书并落盘。
func (m *ipCertManager) obtain(ctx context.Context) (*tls.Certificate, error) {
	key, err := m.accountKey()
	if err != nil {
		return nil, err
	}
	client := &acme.Client{Key: key, DirectoryURL: m.dirURL}
	if _, err := client.Register(ctx, &acme.Account{}, acme.AcceptTOS); err != nil &&
		!errors.Is(err, acme.ErrAccountAlreadyExists) {
		return nil, fmt.Errorf("注册 ACME 账号: %w", err)
	}

	order, err := client.AuthorizeOrder(ctx, acme.IPIDs(m.ip), acme.WithOrderIssuanceProfile(ipCertProfile))
	if err != nil {
		return nil, err
	}
	for _, zurl := range order.AuthzURLs {
		if err := m.authorize(ctx, client, zurl); err != nil {
			return nil, err
		}
	}
	order, err = client.WaitOrder(ctx, order.URI)
	if err != nil {
		return nil, err
	}

	certKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	csr, err := x509.CreateCertificateRequest(rand.Reader,
		&x509.CertificateRequest{IPAddresses: []net.IP{net.ParseIP(m.ip)}}, certKey)
	if err != nil {
		return nil, err
	}
	chain, _, err := client.CreateCertFromOrder(ctx, order, csr, true)
	if err != nil {
		return nil, err
	}
	c, err := m.assemble(certKey, chain)
	if err != nil {
		return nil, err
	}
	if err := m.saveCache(certKey, chain); err != nil {
		return nil, err
	}
	return c, nil
}

// authorize 过一个 authz：只走 HTTP-01（ADR-0044 §2 说了为什么不做 TLS-ALPN-01）。
func (m *ipCertManager) authorize(ctx context.Context, client *acme.Client, zurl string) error {
	z, err := client.GetAuthorization(ctx, zurl)
	if err != nil {
		return err
	}
	if z.Status == acme.StatusValid {
		return nil
	}
	var chal *acme.Challenge
	for _, c := range z.Challenges {
		if c.Type == "http-01" {
			chal = c
			break
		}
	}
	if chal == nil {
		return fmt.Errorf("CA 没有给 http-01 挑战（%s）", zurl)
	}
	ka, err := client.HTTP01ChallengeResponse(chal.Token)
	if err != nil {
		return err
	}
	m.mu.Lock()
	m.tokens[chal.Token] = ka
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		delete(m.tokens, chal.Token)
		m.mu.Unlock()
	}()
	if _, err := client.Accept(ctx, chal); err != nil {
		return err
	}
	_, err = client.WaitAuthorization(ctx, z.URI)
	return err
}

// assemble 把私钥与证书链拼成 tls.Certificate，并确认叶子真是给这个 IP 的。
func (m *ipCertManager) assemble(key crypto.Signer, chain [][]byte) (*tls.Certificate, error) {
	if len(chain) == 0 {
		return nil, errors.New("CA 返回的证书链是空的")
	}
	leaf, err := x509.ParseCertificate(chain[0])
	if err != nil {
		return nil, err
	}
	if err := leaf.VerifyHostname(m.ip); err != nil {
		return nil, fmt.Errorf("证书不是给 %s 的: %w", m.ip, err)
	}
	return &tls.Certificate{Certificate: chain, PrivateKey: key, Leaf: leaf}, nil
}

// ---------- 缓存：与 autocert 同格式（先私钥 PEM，再证书链） ----------

func (m *ipCertManager) cachePath() string { return filepath.Join(m.certDir, m.ip) }

func (m *ipCertManager) loadCache() (*tls.Certificate, error) {
	raw, err := os.ReadFile(m.cachePath())
	if err != nil {
		return nil, err
	}
	var key crypto.Signer
	var chain [][]byte
	for rest := raw; len(rest) > 0; {
		var b *pem.Block
		b, rest = pem.Decode(rest)
		if b == nil {
			break
		}
		switch {
		case b.Type == "CERTIFICATE":
			chain = append(chain, b.Bytes)
		case strings.Contains(b.Type, "PRIVATE KEY"):
			k, err := x509.ParseECPrivateKey(b.Bytes)
			if err != nil {
				return nil, err
			}
			key = k
		}
	}
	if key == nil {
		return nil, errors.New("缓存里没有私钥")
	}
	c, err := m.assemble(key, chain)
	if err != nil {
		return nil, err
	}
	if !m.now().Before(c.Leaf.NotAfter) {
		return nil, errors.New("缓存里的证书已过期")
	}
	return c, nil
}

func (m *ipCertManager) saveCache(key *ecdsa.PrivateKey, chain [][]byte) error {
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return err
	}
	buf := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der})
	for _, c := range chain {
		buf = append(buf, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: c})...)
	}
	return writeFileAtomic(m.cachePath(), buf)
}

func (m *ipCertManager) accountKey() (crypto.Signer, error) {
	p := filepath.Join(m.certDir, accountKeyFile)
	if raw, err := os.ReadFile(p); err == nil {
		b, _ := pem.Decode(raw)
		if b == nil {
			return nil, fmt.Errorf("%s 不是 PEM", p)
		}
		return x509.ParseECPrivateKey(b.Bytes)
	}
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalECPrivateKey(k)
	if err != nil {
		return nil, err
	}
	if err := writeFileAtomic(p, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der})); err != nil {
		return nil, err
	}
	return k, nil
}

// writeFileAtomic 先写临时文件再改名：写到一半被杀也不会留下半张证书。
func writeFileAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

// ---------- 运行：预热 + 续期循环 ----------

// runIPCert 启动时拿到证书并报告，之后在续期时刻续期，失败每小时重试。
// ctx 取消（关闭监听）时退出。
func (a *Agent) runIPCert(ctx context.Context, m *ipCertManager) {
	const env = "Let's Encrypt"
	first := true
	for {
		// 单次签发设上限：acme.Client 默认的 HTTP 客户端没有超时，CA 那边一挂起，
		// 续期循环就永远卡在这一轮，证书几天后悄悄过期
		attempt, cancel := context.WithTimeout(ctx, ipCertAttemptTimeout)
		leaf, renewed, err := m.ensure(attempt)
		cancel()
		if ctx.Err() != nil {
			return
		}
		wait := ipCertRetry
		_, held := m.current()
		switch {
		case err != nil && held == nil:
			// 手里一张都没有：HTTPS 不可用，这是要大声说的
			a.log.Error("证书申请失败 —— HTTPS 还不可用", "ip", m.ip, "env", env, "retry", ipCertRetry)
			if first {
				fmt.Fprint(a.certReport(true), describeACMEError(err, m.ip))
			}
		case err != nil:
			// 还有一张没过期的在用，只是续不上：HTTPS 照常，但几天之内会过期
			if first {
				a.reportCertReady(env, held)
			}
			a.log.Warn("IP 证书续期失败，一小时后重试（续期只走 80 端口的 HTTP-01，80 要一直从公网可达）",
				"ip", m.ip, "err", err, "expires", held.NotAfter.Local().Format("2006-01-02 15:04"))
		default:
			if first {
				a.reportCertReady(env, leaf)
			} else if renewed {
				a.log.Info("IP 证书已续期", "ip", m.ip, "expires", leaf.NotAfter.Local().Format("2006-01-02 15:04"))
			}
			wait = renewAt(leaf).Sub(m.now())
			if renewed && wait <= 0 {
				// 刚签的就已经到续期时刻：多半是系统时钟不对。不能每秒签一张，退回按小时重试
				a.log.Warn("新签的 IP 证书立刻就到续期时刻了，检查系统时钟", "expires", leaf.NotAfter)
				wait = ipCertRetry
			}
		}
		first = false
		if wait < time.Second {
			wait = time.Second
		}
		t := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
	}
}

func (a *Agent) reportCertReady(env string, leaf *x509.Certificate) {
	fmt.Fprintf(a.certReport(false), "证书已就绪（%s，IP 证书，到期 %s，自动续期）\n",
		env, leaf.NotAfter.Local().Format("2006-01-02 15:04"))
}
