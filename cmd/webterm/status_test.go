package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// 裸跑 webterm 要一眼看到"现在正常吗"。渲染是纯函数，好把各种状态都钉住。
func TestRenderStatus(t *testing.T) {
	now := time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name string
		st   status
		want []string
		deny []string
	}{
		{
			"一切正常",
			status{
				running: true, runningVia: "systemd",
				url:    "https://term.example.com:8443",
				certOK: true, certExpiry: now.AddDate(0, 0, 89),
				devices: 2, configPath: "/home/u/.config/webterm/config",
			},
			[]string{"运行中", "systemd", "https://term.example.com:8443",
				"2026-12-06", "89 天", "2 台", "webterm pair"},
			nil,
		},
		{
			// 最常见的第一次：服务起来了但还没配对
			"还没有授权设备 → 指出下一步",
			status{running: true, url: "https://x.example.com", certOK: true,
				certExpiry: now.AddDate(0, 0, 89), devices: 0},
			[]string{"还没有授权设备", "webterm pair"},
			nil,
		},
		{
			"服务没在跑",
			status{running: false, url: "https://x.example.com"},
			[]string{"未运行", "webterm serve"},
			nil,
		},
		{
			"证书还没申请下来",
			status{running: true, url: "https://x.example.com", certOK: false},
			[]string{"还没有证书"},
			[]string{"到期"},
		},
		{
			// 到期在即要显眼 —— 这是唯一会静默变成事故的东西
			"证书快到期了",
			status{running: true, url: "https://x.example.com", certOK: true,
				certExpiry: now.AddDate(0, 0, 5), devices: 1},
			[]string{"5 天", "续期"},
			nil,
		},
		{
			"已经过期",
			status{running: true, url: "https://x.example.com", certOK: true,
				certExpiry: now.AddDate(0, 0, -1), devices: 1},
			[]string{"已过期"},
			nil,
		},
		{
			"还没配域名（连 --dev 都没跑过）",
			status{running: false},
			[]string{"还没配域名", "install.sh"},
			nil,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := renderStatus(tc.st, "v0.1.0", now, false)
			for _, w := range tc.want {
				if !strings.Contains(got, w) {
					t.Errorf("缺 %q：\n%s", w, got)
				}
			}
			for _, d := range tc.deny {
				if strings.Contains(got, d) {
					t.Errorf("不该出现 %q：\n%s", d, got)
				}
			}
			// 命令清单永远要在
			if !strings.Contains(got, "webterm doctor") {
				t.Errorf("命令清单丢了：\n%s", got)
			}
		})
	}
}

// 剩余天数按自然日算，别出现 "-0 天" 这种。
func TestDaysLeft(t *testing.T) {
	now := time.Date(2026, 9, 8, 23, 30, 0, 0, time.UTC)
	cases := []struct {
		expiry time.Time
		want   int
	}{
		{now.Add(30 * time.Minute), 0}, // 半小时后到期 → 今天
		{now.Add(25 * time.Hour), 1},
		{now.AddDate(0, 0, 89), 89},
		{now.Add(-time.Hour), -1}, // 已过期
	}
	for _, tc := range cases {
		if got := daysLeft(tc.expiry, now); got != tc.want {
			t.Errorf("daysLeft(+%v) = %d, 想要 %d", tc.expiry.Sub(now), got, tc.want)
		}
	}
}

// 颜色只在接着终端时才该出现 —— 重定向到文件里不能躺着转义序列。
func TestRenderStatusColor(t *testing.T) {
	now := time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)
	// 快到期和已过期是仅有的两处上色
	for _, st := range []status{
		{running: true, url: "https://x.example.com", certOK: true, certExpiry: now.AddDate(0, 0, 5)},
		{running: true, url: "https://x.example.com", certOK: true, certExpiry: now.AddDate(0, 0, -1)},
	} {
		plain := renderStatus(st, "v0.1.0", now, false)
		if strings.Contains(plain, "\033[") {
			t.Errorf("关了颜色还有转义序列：\n%q", plain)
		}
		colored := renderStatus(st, "v0.1.0", now, true)
		if !strings.Contains(colored, "\033[") {
			t.Errorf("开了颜色却没上色：\n%q", colored)
		}
		// 关掉颜色不能丢信息
		if stripANSI(colored) != plain {
			t.Errorf("上色改变了文字内容：\n%q\n%q", stripANSI(colored), plain)
		}
	}
}

func stripANSI(s string) string {
	for {
		i := strings.Index(s, "\033[")
		if i < 0 {
			return s
		}
		j := strings.Index(s[i:], "m")
		if j < 0 {
			return s
		}
		s = s[:i] + s[i+j+1:]
	}
}

// NO_COLOR 一设就不上色，不管值是什么；TERM=dumb 同理。
func TestColorEnabled(t *testing.T) {
	// 非终端（普通文件）永远不上色
	f, err := os.CreateTemp(t.TempDir(), "out")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	t.Setenv("TERM", "xterm-256color")
	os.Unsetenv("NO_COLOR")
	if colorEnabled(f) {
		t.Error("重定向到文件时不该上色")
	}
	t.Setenv("NO_COLOR", "")
	if colorEnabled(os.Stdin) {
		t.Error("设了 NO_COLOR（哪怕是空值）就不该上色")
	}
}

// 探活必须带 SNI。
//
// autocert 的 HostPolicy 只认 --domain 那个名字：拿 IP 直连、不带 SNI 时
// 服务端【不给证书】，握手直接断 —— 那是服务端的拒绝，客户端
// InsecureSkipVerify 救不了。漏了 SNI 就会把活着的服务判成"未运行"。
//
// 【不能用 httptest.StartTLS】：它会无条件往 Certificates 里塞一张 localhost
// 证书，而 Go 在 len(Certificates)>0 且 ServerName 为空时根本不调
// GetCertificate —— 握手会用那张兜底证书成功，测试就失去意义了
// （这个坑真踩到了：撤掉修复测试照样绿）。所以自己起一个只有
// GetCertificate、没有兜底证书的服务器。
func TestHealthzOKSendsSNI(t *testing.T) {
	const domain = "t.example.com"
	cert := selfSigned(t, domain)

	var sawSNI []string
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			io.WriteString(w, "ok")
		}),
		TLSConfig: &tls.Config{
			GetCertificate: func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
				sawSNI = append(sawSNI, hello.ServerName)
				if hello.ServerName != domain {
					// autocert 在 HostPolicy 不匹配时就是这么拒的
					return nil, fmt.Errorf("acme/autocert: host %q not configured in HostWhitelist", hello.ServerName)
				}
				return &cert, nil
			},
		},
	}
	go srv.ServeTLS(ln, "", "") //nolint:errcheck // 关闭时必然返回 ErrServerClosed
	defer srv.Close()

	url := "https://" + ln.Addr().String() + "/healthz"
	if !healthzOK(url, domain) {
		t.Errorf("带上 SNI 应该探得通（服务端看到的 SNI: %q）", sawSNI)
	}
	if healthzOK(url, "") {
		t.Error("不带 SNI 时这个服务端会拒绝握手，不该报成功")
	}
	if len(sawSNI) == 0 || sawSNI[0] != domain {
		t.Errorf("服务端没收到期望的 SNI: %q", sawSNI)
	}
}

// 返回体不是 "ok" 就不算活着 —— 端口上是别的服务时靠这条区分。
func TestHealthzOKChecksBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "<html>nginx</html>")
	}))
	defer srv.Close()
	if healthzOK(srv.URL+"/healthz", "") {
		t.Error("返回体不是 ok，不该判成 webterm")
	}
}

func selfSigned(t *testing.T, domain string) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: domain},
		DNSNames:     []string{domain},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

// 探活不跟随重定向 —— 跟下去等于让别的地方替本机回答。
//
// 真实场景：生产的 :80 只有 ACME 挑战和跳转，/healthz 拿到的是 301，
// 指向公网域名。跟下去会绕出这台机器再回来，正确性就依赖 DNS 和
// 公网 IP 自反了；--bind 127.0.0.1 时更是直接指向一个本进程没在服务的地址。
func TestHealthzOKDoesNotFollowRedirect(t *testing.T) {
	real := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "ok")
	}))
	defer real.Close()

	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, real.URL+"/healthz", http.StatusMovedPermanently)
	}))
	defer redirector.Close()

	if healthzOK(redirector.URL+"/healthz", "") {
		t.Error("301 跟到别处拿到 ok，不该算本机活着")
	}
	// 对照：目标本身直接答 ok 时要判成活着
	if !healthzOK(real.URL+"/healthz", "") {
		t.Error("直接返回 ok 的应该判成活着")
	}
}
