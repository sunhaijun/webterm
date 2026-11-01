package agent

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// 证书申请失败时给「原因 + 怎么修」，而不是甩一行 Go 的 error（US-7.2 / AC-1.13）。
func TestDescribeACMEError(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want []string
	}{
		{
			"挑战打不进来 → 先查安全组",
			errors.New(`acme: authorization error for term.example.com: Invalid response from http://...`),
			// 云安全组是最常漏的一步，必须排在第一条
			[]string{"安全组", "curl -sI http://term.example.com/", "dig +short", "Cloudflare"},
		},
		{
			// ★ autocert 会把挑战类型逐个试完才报错，所以【真实现场】
			// 看到的是这一句，而不是底层的 "Invalid response"。
			// 漏了它，最常见的故障就会掉进 default 分支甩裸 error。
			// IT-tls-3 是这条的来源。
			"挑战类型试完了（autocert 真正抛出的那句）→ 同一套诊断",
			errors.New(`acme/autocert: unable to satisfy "https://acme-v02.api.letsencrypt.org/authz/123" for domain "term.example.com": no viable challenge type found`),
			[]string{"安全组", "80", "443", "curl -sI http://term.example.com/", "dig +short", "Cloudflare"},
		},
		{
			"限流 → 说清窗口有多长",
			errors.New("urn:ietf:params:acme:error:rateLimited: too many certificates"),
			[]string{"限流", "一周", "--acme-staging"},
		},
		{
			"域名解析不出来",
			errors.New(`dial tcp: lookup term.example.com: no such host`),
			[]string{"解析不出来", "dig +short"},
		},
		{
			"域名与 --domain 不一致",
			errors.New(`acme/autocert: host "evil.com" not configured in HostWhitelist`),
			[]string{"不一致", "不允许通配"},
		},
		{
			"认不出来的错也要给排障入口",
			errors.New("something entirely unexpected"),
			[]string{"something entirely unexpected", "troubleshooting.md"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := describeACMEError(tc.err, "term.example.com", false)
			for _, want := range tc.want {
				if !strings.Contains(got, want) {
					t.Errorf("诊断里没有 %q：\n%s", want, got)
				}
			}
			// 不该把裸的 Go error 甩给用户当主要内容
			if strings.HasPrefix(strings.TrimSpace(got), "acme:") {
				t.Errorf("诊断以裸 error 开头：\n%s", got)
			}
		})
	}
}

// 已经在用 staging 时不该再劝人用 staging。
func TestDescribeACMEErrorStagingHint(t *testing.T) {
	err := errors.New("rateLimited")
	if strings.Contains(describeACMEError(err, "x.example.com", true), "先用 --acme-staging 调通") {
		t.Error("已经在 staging 了还劝人用 staging")
	}
	if !strings.Contains(describeACMEError(err, "x.example.com", false), "--acme-staging") {
		t.Error("正式环境失败时应当提示先用 staging")
	}
}

// autocert 的 HostPolicy 必须严格限定为 --domain 的值。
//
// 通配的话它会被用来给【任意】域名申请证书（威胁模型 T8）——
// 别人把自己的域名解析到这台机器，就能借我们的 ACME 账号签证书。
func TestCertManagerHostPolicyIsStrict(t *testing.T) {
	m := newCertManager(ServeConfig{Domain: "term.example.com", CertDir: t.TempDir()})
	if m.HostPolicy == nil {
		t.Fatal("HostPolicy 是 nil —— 那等于允许任意域名")
	}
	ctx := context.Background()

	if err := m.HostPolicy(ctx, "term.example.com"); err != nil {
		t.Fatalf("配置的域名被拒了: %v", err)
	}
	for _, host := range []string{
		"evil.example.com",
		"example.com",
		"sub.term.example.com",
		"term.example.com.evil.com",
		"",
	} {
		if err := m.HostPolicy(ctx, host); err == nil {
			t.Errorf("HostPolicy 放过了 %q —— 它能拿我们的账号签证书", host)
		}
	}
}

// RenewBefore 刻意留空，靠 autocert 的 min(30 天, 有效期/3)。
//
// 写死 30 天的话，将来换成短周期证书（LE 已在推 6 天期的选项）就会变成
// "每次都立刻续期"，反而会撞限流。
func TestCertManagerRenewBeforeUsesLibraryDefault(t *testing.T) {
	m := newCertManager(ServeConfig{Domain: "x.example.com", CertDir: t.TempDir()})
	if m.RenewBefore != 0 {
		t.Fatalf("RenewBefore = %v，应当留空让库按有效期缩放（见 install.md 的「证书续期」）", m.RenewBefore)
	}
}

// --acme-staging 才走 staging 目录，默认必须是正式环境。
func TestCertManagerStagingSwitch(t *testing.T) {
	prod := newCertManager(ServeConfig{Domain: "x.example.com", CertDir: t.TempDir()})
	if prod.Client != nil {
		t.Error("默认不该指定 ACME 目录（用 acme 包的正式默认值）")
	}
	staging := newCertManager(ServeConfig{Domain: "x.example.com", CertDir: t.TempDir(), ACMEStaging: true})
	if staging.Client == nil || !strings.Contains(staging.Client.DirectoryURL, "staging") {
		t.Errorf("--acme-staging 没有切到 staging 目录: %+v", staging.Client)
	}
}

// 对外地址：443 不写，其它必须写。cmd/webterm 的配对 URL 与状态总览也用它。
func TestExternalURLIncludesNonDefaultPort(t *testing.T) {
	cases := []struct {
		port int
		want string
	}{
		{443, "https://term.example.com"},
		{0, "https://term.example.com"}, // 没传就按默认，不能拼出 :0
		{8443, "https://term.example.com:8443"},
		{8080, "https://term.example.com:8080"},
	}
	for _, tc := range cases {
		if got := ExternalURL("term.example.com", tc.port); got != tc.want {
			t.Errorf("ExternalURL(_, %d) = %q, 想要 %q", tc.port, got, tc.want)
		}
	}
}

// :80 上的跳转必须跳到真的能打开的地址（含端口）。
func TestRedirectToHTTPSCarriesPort(t *testing.T) {
	cases := []struct {
		port int
		want string
	}{
		{443, "https://term.example.com/a?b=1"},
		{8443, "https://term.example.com:8443/a?b=1"},
	}
	for _, tc := range cases {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "http://term.example.com/a?b=1", nil)
		redirectToHTTPS("term.example.com", tc.port).ServeHTTP(rec, req)
		if rec.Code != http.StatusMovedPermanently {
			t.Errorf("端口 %d：状态码 = %d, 想要 301", tc.port, rec.Code)
		}
		if got := rec.Header().Get("Location"); got != tc.want {
			t.Errorf("端口 %d：Location = %q, 想要 %q", tc.port, got, tc.want)
		}
	}
}

// 两个端口写成一样时要当场说清，而不是撞到 "address already in use"
// 然后让人去查"谁占着这个端口"（占着的是它自己）。
func TestListenRejectsIdenticalPorts(t *testing.T) {
	a := &Agent{cfg: Config{}, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	_, _, err := a.Listen(ServeConfig{
		Domain:    "term.example.com",
		Bind:      "127.0.0.1",
		HTTPPort:  8443,
		HTTPSPort: 8443,
		CertDir:   t.TempDir(),
	}, http.NotFoundHandler())
	if err == nil {
		t.Fatal("端口相同却没报错")
	}
	for _, want := range []string{"不能相同", "8443", "--http-port", "--https-port"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("错误信息里缺 %q: %v", want, err)
		}
	}
}

// 握手噪音不该占 INFO：端口对公网开放，扫描器会持续制造这类行，
// 按 INFO 打会把证书预热结果、绑定失败这些真的要看的行冲掉。
func TestHTTPErrorLogDemotesHandshakeNoise(t *testing.T) {
	cases := []struct {
		name      string
		line      string
		wantLevel string
	}{
		{
			"扫描器拿 IP 直连（没有 SNI）",
			"http: TLS handshake error from 1.2.3.4:5678: acme/autocert: missing server name",
			"DEBUG",
		},
		{
			"扫描器发纯 HTTP",
			"http: TLS handshake error from 1.2.3.4:5678: client sent an HTTP request to an HTTPS server",
			"DEBUG",
		},
		{
			"客户端拒绝我们的证书",
			"http: TLS handshake error from 1.2.3.4:5678: remote error: tls: unknown certificate",
			"DEBUG",
		},
		{
			// 不是握手噪音的必须留在 INFO —— 降级不能一刀切
			"其它 http 错误照常可见",
			"http: panic serving 1.2.3.4:5678: something broke",
			"INFO",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var buf lockedBuf
			a := &Agent{log: slog.New(slog.NewTextHandler(&buf,
				&slog.HandlerOptions{Level: slog.LevelDebug}))}
			a.httpErrorLog().Print(tc.line)

			got := buf.String()
			if !strings.Contains(got, "level="+tc.wantLevel) {
				t.Errorf("想要 level=%s，实际:\n%s", tc.wantLevel, got)
			}
			// 内容不能丢 —— 降级是为了不刷屏，不是为了藏起来
			if !strings.Contains(got, "TLS handshake error") && !strings.Contains(got, "panic serving") {
				t.Errorf("消息内容丢了:\n%s", got)
			}
		})
	}
}

type lockedBuf struct {
	mu sync.Mutex
	b  strings.Builder
}

func (l *lockedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}
