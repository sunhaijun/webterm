package agent_test

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/acmetest"
	"github.com/sunhaijun/webterm/internal/agent"
	"github.com/sunhaijun/webterm/internal/session"
	"github.com/sunhaijun/webterm/internal/store"
)

// IT-tls-1..3（docs/70-testing/strategy.md）：ACME 链路的机械化证据。
//
// 用 internal/acmetest 里的本地假 CA，不用 pebble ——
// 理由和"它证明什么、不证明什么"写在那个包的注释里。

const testDomain = "term.test"

// acmeFixture 起一个假 CA + 一个真的按生产路径监听的 agent。
type acmeFixture struct {
	ca        *acmetest.Server
	report    *lockedBuffer
	certDir   string
	httpPort  int
	httpsPort int
}

// fixtureOpts 是夹具的可调项。
type fixtureOpts struct {
	// failChallenge 让假 CA 的验证必然失败（模拟"安全组没放行 80"）。
	failChallenge bool
	// certLifetime 是签出来的证书有效期，用来断言报出的到期日是真的。
	certLifetime time.Duration
	tune         func(*agent.ServeConfig)
}

// newACMEFixture 按 ServeConfig 起监听。
func newACMEFixture(t *testing.T, o fixtureOpts) *acmeFixture {
	t.Helper()

	ca, err := acmetest.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(ca.Close)
	ca.SetLogf(t.Logf)
	if o.certLifetime > 0 {
		ca.SetCertLifetime(o.certLifetime)
	}

	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	sessions := session.NewManager(session.Config{MaxSessions: 1, RingBytes: 1 << 16, Shell: "bash"}, st)
	t.Cleanup(sessions.Shutdown)

	report := &lockedBuffer{}
	a := agent.New(agent.Config{
		Domain:     testDomain,
		Version:    "test",
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		CertReport: report,
	}, st, sessions)

	f := &acmeFixture{
		ca:        ca,
		report:    report,
		certDir:   filepath.Join(dir, "certs"),
		httpPort:  freePort(t),
		httpsPort: freePort(t),
	}

	cfg := agent.ServeConfig{
		Domain:           testDomain,
		Bind:             "127.0.0.1",
		HTTPPort:         f.httpPort,
		HTTPSPort:        f.httpsPort,
		CertDir:          f.certDir,
		ACMEDirectoryURL: ca.DirectoryURL(),
	}
	if o.tune != nil {
		o.tune(&cfg)
	}

	// 假 CA 验证挑战时直接连本机的 :80 —— 这样就不需要让 term.test
	// 真的解析出来，也是不用 pebble 的主要原因。
	//
	// 【必须在 Listen 之前定下来】：预热是异步的，晚一步就有竞态。
	if !o.failChallenge {
		ca.ValidateAgainst(fmt.Sprintf("127.0.0.1:%d", f.httpPort))
	}

	servers, _, err := a.Listen(cfg, a.Handler())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		servers.Shutdown(ctx)
	})
	return f
}

// waitReport 等预热结果落到 CertReport（预热是异步的）。
func (f *acmeFixture) waitReport(t *testing.T, want string) string {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if got := f.report.String(); strings.Contains(got, want) {
			return got
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("等 %q 超时，CertReport 里只有:\n%s", want, f.report.String())
	return ""
}

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

// IT-tls-1：走完整 ACME 流程真的拿到证书，落盘、能握手、报出到期时间。
func TestACMEIssuesRealCertificate(t *testing.T) {
	const lifetime = 47 * 24 * time.Hour // 故意不是 90 天，好确认日期不是写死的
	f := newACMEFixture(t, fixtureOpts{certLifetime: lifetime})

	report := f.waitReport(t, "证书已就绪")
	// 报出的到期日必须是【证书真实的到期日】，不是占位符 ——
	// 这是用户确认"真的成了"的唯一凭据
	wantDate := time.Now().Add(lifetime).Local().Format("2006-01-02")
	if !strings.Contains(report, wantDate) {
		t.Errorf("预热报告里的到期日应当是 %s: %q", wantDate, report)
	}
	if !strings.Contains(report, "自动续期") {
		t.Errorf("预热报告缺续期说明: %q", report)
	}

	// 假 CA 侧确认签发的域名就是 --domain。
	// 【数量的断言故意留到握手之后】—— 见文件末尾那条回归测试。
	if issued := f.ca.Issued(); len(issued) == 0 || issued[0] != testDomain {
		t.Errorf("签发的域名 = %v, 想要 [%s]", issued, testDomain)
	}

	// 证书落到了 CertDir，且目录是 0700（私钥在里面）
	info, err := os.Stat(f.certDir)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o700 {
		t.Errorf("证书目录权限 = %o, 想要 700", perm)
	}
	entries, err := os.ReadDir(f.certDir)
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, e := range entries {
		if strings.Contains(e.Name(), testDomain) {
			found = true
		}
	}
	if !found {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("%s 的证书没落盘，目录里只有 %v", testDomain, names)
	}

	// ★ 真握手：这才是"证书可用"的证据，光有文件不算
	conn, err := tls.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", f.httpsPort),
		f.ca.TLSClientConfig(testDomain))
	if err != nil {
		t.Fatalf("TLS 握手失败: %v", err)
	}
	defer conn.Close()
	leaf := conn.ConnectionState().PeerCertificates[0]
	if err := leaf.VerifyHostname(testDomain); err != nil {
		t.Errorf("证书不覆盖 %s: %v", testDomain, err)
	}
	if got := leaf.NotAfter.Local().Format("2006-01-02"); got != wantDate {
		t.Errorf("握手拿到的证书到期日 = %s, 报告里说的是 %s —— 两者必须一致", got, wantDate)
	}

	// :80 上非挑战请求要 301 到 HTTPS（顺带证明挑战 handler 没吃掉全部路由）
	noRedirect := &http.Client{
		Timeout:       5 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := noRedirect.Get(fmt.Sprintf("http://127.0.0.1:%d/", f.httpPort))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMovedPermanently {
		t.Errorf(":80 状态码 = %d, 想要 301", resp.StatusCode)
	}
	if loc := resp.Header.Get("Location"); !strings.HasPrefix(loc, "https://"+testDomain) {
		t.Errorf("Location = %q, 想要 https://%s 开头", loc, testDomain)
	}
}

// IT-tls-2：--dev 【一次都不找 CA】。
//
// 断言"没签发成功"太弱 —— 发起了但失败也满足。这里断言假 CA 收到零请求。
func TestDevModeNeverTouchesACME(t *testing.T) {
	f := newACMEFixture(t, fixtureOpts{tune: func(c *agent.ServeConfig) {
		c.Dev = true
	}})

	// 给足够时间让"如果会去申请"的那条路走起来
	time.Sleep(500 * time.Millisecond)

	if n := f.ca.Requests(); n != 0 {
		t.Errorf("--dev 下 CA 收到 %d 个请求，应当是 0 —— 开发模式不许申请证书", n)
	}
	if got := f.report.String(); got != "" {
		t.Errorf("--dev 下不该有证书报告，却有: %q", got)
	}
	if _, err := os.Stat(f.certDir); !os.IsNotExist(err) {
		t.Errorf("--dev 下不该创建证书目录 %s (err=%v)", f.certDir, err)
	}

	// 而且它确实在明文 HTTP 上工作
	resp, err := (&http.Client{Timeout: 5 * time.Second}).
		Get(fmt.Sprintf("http://127.0.0.1:%d/healthz", f.httpPort))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("--dev /healthz = %d, 想要 200", resp.StatusCode)
	}
}

// IT-tls-3：挑战打不进来时给可读诊断（AC-1.13），而不是甩一行 Go error。
func TestACMEFailureIsDiagnosable(t *testing.T) {
	// 验证必然失败，模拟"安全组没放行 80"
	f := newACMEFixture(t, fixtureOpts{failChallenge: true})

	report := f.waitReport(t, "CA 没能连上本机做域名验证")

	// 云安全组是最常漏的一步，必须排在第一条
	sgAt := strings.Index(report, "云安全组")
	dnsAt := strings.Index(report, "DNS 指向本机")
	if sgAt < 0 || dnsAt < 0 || sgAt > dnsAt {
		t.Errorf("安全组应当排在 DNS 之前，实际 报告=\n%s", report)
	}
	for _, want := range []string{
		"curl -sI http://" + testDomain, // 可以直接抄去跑
		"dig +short " + testDomain,
		"Cloudflare",     // 小云朵是第二常见的坑
		"--acme-staging", // 正式环境失败时应当引导先去 staging
	} {
		if !strings.Contains(report, want) {
			t.Errorf("诊断里缺 %q，实际:\n%s", want, report)
		}
	}
	// 不该是一行裸 error
	if strings.Contains(report, "acme: authorization error") && !strings.Contains(report, "1.") {
		t.Errorf("诊断退化成裸 error 了:\n%s", report)
	}

	// 失败了就不该有证书落盘（半个证书比没有更糟）
	entries, err := os.ReadDir(f.certDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), testDomain) {
			t.Errorf("签发失败却落了证书文件 %s", e.Name())
		}
	}
}

// 预热必须命中【真实客户端会用的那个缓存槽】。
//
// autocert 的缓存 key 含 isRSA = !supportsECDSA(hello)，而 supportsECDSA
// 对一个空的 ClientHelloInfo 返回 false。所以预热时传空 hello 会签一张 RSA
// 证书存到 "<域名>+rsa"；真实浏览器声明 ECDSA，key 是 "<域名>"，必然 miss
// → 在 TLS 握手里现场再签一张。后果：
//
//   - 每次重启都多签一张，很快撞满 LE 的"重复证书"限额（每周 5 张）
//   - 握手要等 ACME 走完，ACME 一抖就是握手失败
//   - "证书已就绪"报的是一张真实客户端根本不用的证书 —— 假的成功
//
// 所以这里断言【握手之后】签发总数仍然是 1。
func TestWarmupHitsTheCacheSlotRealClientsUse(t *testing.T) {
	f := newACMEFixture(t, fixtureOpts{})
	f.waitReport(t, "证书已就绪")

	if n := len(f.ca.Issued()); n != 1 {
		t.Fatalf("预热后签发了 %d 张，应当是 1", n)
	}

	// 真实客户端（Go 的 TLS 客户端声明 ECDSA，和浏览器一样）
	conn, err := tls.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", f.httpsPort),
		f.ca.TLSClientConfig(testDomain))
	if err != nil {
		t.Fatalf("TLS 握手失败: %v", err)
	}
	defer conn.Close()

	// ★ 回归点：握手不该触发第二次签发
	if issued := f.ca.Issued(); len(issued) != 1 {
		t.Errorf("握手之后签发了 %d 张（%v）—— 预热存错了缓存槽，"+
			"真实客户端在握手里又签了一张", len(issued), issued)
	}
}
