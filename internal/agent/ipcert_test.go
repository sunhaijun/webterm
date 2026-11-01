package agent_test

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"log/slog"
	"net"
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

// IT-tls-4..6：IP 模式（ADR-0044）。和 acme_test.go 一样用本地假 CA。

const testIP = "203.0.113.7"

type ipFixture struct {
	ca        *acmetest.Server
	report    *lockedBuffer
	certDir   string
	httpPort  int
	httpsPort int
	shutdown  func()
}

// startIP 按生产路径起一个 IP 模式的 agent。certDir 与端口可以跨两次启动复用（测重启）。
func startIP(t *testing.T, ca *acmetest.Server, certDir string, ports []int) *ipFixture {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	sessions := session.NewManager(session.Config{MaxSessions: 1, RingBytes: 1 << 16, Shell: "bash"})
	report := &lockedBuffer{}
	a := agent.New(agent.Config{
		Domain: testIP, Version: "test",
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		CertReport: report,
	}, st, sessions)
	servers, _, err := a.Listen(agent.ServeConfig{
		Domain: testIP, Bind: "127.0.0.1",
		HTTPPort: ports[0], HTTPSPort: ports[1],
		CertDir: certDir, ACMEDirectoryURL: ca.DirectoryURL(),
	}, a.Handler())
	if err != nil {
		t.Fatal(err)
	}
	f := &ipFixture{ca: ca, report: report, certDir: certDir, httpPort: ports[0], httpsPort: ports[1]}
	var once bool
	f.shutdown = func() {
		if once {
			return
		}
		once = true
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		servers.Shutdown(ctx)
		sessions.Shutdown()
		st.Close()
	}
	t.Cleanup(f.shutdown)
	return f
}

func newCA(t *testing.T) *acmetest.Server {
	t.Helper()
	ca, err := acmetest.New()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(ca.Close)
	ca.SetLogf(t.Logf)
	return ca
}

// dialNoSNI 像浏览器连 IP 那样握手：ServerName 是 IP，Go 不会把它放进 SNI，
// 校验时比对证书里的 IP SAN。
func dialNoSNI(t *testing.T, ca *acmetest.Server, port int) *tls.ConnectionState {
	t.Helper()
	cfg := ca.TLSClientConfig(testIP)
	conn, err := tls.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", port), cfg)
	if err != nil {
		t.Fatalf("不带 SNI 的握手失败: %v", err)
	}
	defer conn.Close()
	st := conn.ConnectionState()
	return &st
}

// IT-tls-4：订单是 ip 标识 + shortlived，证书带 IP SAN，不带 SNI 的握手能通过 CA 校验。
func TestIPModeIssuesShortlivedIPCertificate(t *testing.T) {
	ca := newCA(t)
	ca.SetCertLifetime(160 * time.Hour)
	ports := freePorts(t, 2)
	ca.ValidateAgainst(fmt.Sprintf("127.0.0.1:%d", ports[0]))
	f := startIP(t, ca, filepath.Join(t.TempDir(), "certs"), ports)

	waitFor(t, "证书已就绪", func() bool { return strings.Contains(f.report.String(), "证书已就绪") })
	report := f.report.String()
	if !strings.Contains(report, "IP 证书") {
		t.Errorf("报告没说明这是 IP 证书: %q", report)
	}
	// 6 天期的证书，报到期要精确到小时 —— 只写日期的话「今天到期」和「6 天后到期」分不清是哪天几点
	wantExp := time.Now().Add(160 * time.Hour).Local().Format("2006-01-02 15")
	if !strings.Contains(report, wantExp) {
		t.Errorf("报告里的到期时间应当是 %s 点: %q", wantExp, report)
	}

	orders := ca.Orders()
	if len(orders) != 1 || orders[0].Type != "ip" || orders[0].Value != testIP || orders[0].Profile != "shortlived" {
		t.Fatalf("CA 收到的订单 = %+v，想要一张 ip=%s、profile=shortlived 的", orders, testIP)
	}

	st := dialNoSNI(t, ca, f.httpsPort)
	leaf := st.PeerCertificates[0]
	if len(leaf.IPAddresses) != 1 || leaf.IPAddresses[0].String() != testIP {
		t.Errorf("证书的 IP SAN = %v，想要 [%s]", leaf.IPAddresses, testIP)
	}

	// 缓存落盘、权限 0600，与 autocert 同格式（状态总览按 certs/<ip> 读）
	info, err := os.Stat(filepath.Join(f.certDir, testIP))
	if err != nil {
		t.Fatalf("证书没落盘: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("证书缓存权限 = %o，想要 600（私钥在里面）", perm)
	}
}

// IP 模式不声明 acme-tls/1：它只走 HTTP-01（ADR-0044 §2），声明了 CA 也用不上，
// 反倒让扫描器以为这里能做 TLS-ALPN-01。
func TestIPModeDoesNotAdvertiseACMEALPN(t *testing.T) {
	ca := newCA(t)
	ports := freePorts(t, 2)
	ca.ValidateAgainst(fmt.Sprintf("127.0.0.1:%d", ports[0]))
	f := startIP(t, ca, filepath.Join(t.TempDir(), "certs"), ports)
	waitFor(t, "证书已就绪", func() bool { return strings.Contains(f.report.String(), "证书已就绪") })

	cfg := ca.TLSClientConfig(testIP)
	cfg.NextProtos = []string{"acme-tls/1"}
	conn, err := tls.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", f.httpsPort), cfg)
	if err == nil {
		defer conn.Close()
		if got := conn.ConnectionState().NegotiatedProtocol; got == "acme-tls/1" {
			t.Error("IP 模式协商出了 acme-tls/1")
		}
	}
}

// IT-tls-5：重启读缓存，不再找 CA（「同一组标识每周 5 张」经不起每次重启都签）。
func TestIPModeRestartReusesCache(t *testing.T) {
	ca := newCA(t)
	ca.SetCertLifetime(160 * time.Hour)
	ports := freePorts(t, 2)
	ca.ValidateAgainst(fmt.Sprintf("127.0.0.1:%d", ports[0]))
	certDir := filepath.Join(t.TempDir(), "certs")

	first := startIP(t, ca, certDir, ports)
	waitFor(t, "第一次证书已就绪", func() bool { return strings.Contains(first.report.String(), "证书已就绪") })
	first.shutdown()
	ordersBefore := len(ca.Orders())

	second := startIP(t, ca, certDir, ports)
	waitFor(t, "重启后证书已就绪", func() bool { return strings.Contains(second.report.String(), "证书已就绪") })
	if n := len(ca.Orders()); n != ordersBefore {
		t.Errorf("重启后又下了 %d 个订单 —— 应当直接用缓存", n-ordersBefore)
	}
	dialNoSNI(t, ca, second.httpsPort)
}

// IT-tls-6：到了续期时刻会换一张新证书，握手拿到的是新的。
//
// 假 CA 的 NotBefore 往前拨了 1 分钟，有效期 L 的证书总长是 L+60s，
// 续期时刻 = NotAfter - (L+60)/3。L=33s 时大约签下来 2 秒后就该续。
func TestIPModeRenewsBeforeExpiry(t *testing.T) {
	ca := newCA(t)
	ca.SetCertLifetime(33 * time.Second)
	ports := freePorts(t, 2)
	ca.ValidateAgainst(fmt.Sprintf("127.0.0.1:%d", ports[0]))
	f := startIP(t, ca, filepath.Join(t.TempDir(), "certs"), ports)
	waitFor(t, "证书已就绪", func() bool { return strings.Contains(f.report.String(), "证书已就绪") })
	firstSerial := dialNoSNI(t, ca, f.httpsPort).PeerCertificates[0].SerialNumber

	waitFor(t, "续期出第二张证书", func() bool { return len(ca.Issued()) >= 2 })
	waitFor(t, "握手拿到新证书", func() bool {
		return dialNoSNI(t, ca, f.httpsPort).PeerCertificates[0].SerialNumber.Cmp(firstSerial) != 0
	})
}

// 挑战打不进来时，IP 模式给的是 IP 版的诊断（只提 80、不提 DNS）。
func TestIPModeFailureIsDiagnosable(t *testing.T) {
	ca := newCA(t) // 不 ValidateAgainst：验证必然失败，模拟安全组没放行 80
	f := startIP(t, ca, filepath.Join(t.TempDir(), "certs"), freePorts(t, 2))
	waitFor(t, "失败诊断", func() bool { return strings.Contains(f.report.String(), "安全组") })
	got := f.report.String()
	if !strings.Contains(got, "只走 80") || strings.Contains(got, "dig +short") {
		t.Errorf("IP 模式的失败诊断不对:\n%s", got)
	}
	// 握手不会触发签发：手里没证书就是握手失败，CA 那边不会多出订单
	before := len(ca.Orders())
	if conn, err := tls.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", f.httpsPort), ca.TLSClientConfig(testIP)); err == nil {
		conn.Close()
		t.Error("没有证书时握手居然成功了")
	}
	time.Sleep(100 * time.Millisecond)
	if after := len(ca.Orders()); after != before {
		t.Errorf("握手触发了签发（订单 %d → %d）", before, after)
	}
}

// CA 不支持 profile（不签 IP 证书）时报得清楚。
func TestIPModeCAWithoutProfiles(t *testing.T) {
	ca := newCA(t)
	ca.SetProfiles(nil)
	ports := freePorts(t, 2)
	ca.ValidateAgainst(fmt.Sprintf("127.0.0.1:%d", ports[0]))
	f := startIP(t, ca, filepath.Join(t.TempDir(), "certs"), ports)
	waitFor(t, "失败诊断", func() bool { return strings.Contains(f.report.String(), "不签 IP 证书") })
}

// IT-doctor-acme-1..2：doctor --acme 的签发核心。两种模式都签得出来，
// 证书存进给定的证书目录（服务用的 certs/），返回之后端口已经释放；
// 再跑一次直接用缓存，CA 收不到新订单 —— 签好的证书留给服务，不多签。
func TestIssueCheck(t *testing.T) {
	for _, tc := range []struct{ name, addr string }{
		{"域名", "term.test"},
		{"IP", testIP},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ca := newCA(t)
			ports := freePorts(t, 2)
			ca.ValidateAgainst(fmt.Sprintf("127.0.0.1:%d", ports[0]))
			dir := filepath.Join(t.TempDir(), "certs")
			cfg := agent.ServeConfig{
				Domain: tc.addr, Bind: "127.0.0.1", HTTPPort: ports[0], HTTPSPort: ports[1],
				CertDir: dir, ACMEDirectoryURL: ca.DirectoryURL(),
			}
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			leaf, issued, err := agent.IssueCheck(ctx, cfg)
			if err != nil {
				t.Fatalf("签发失败: %v", err)
			}
			if !issued {
				t.Error("第一次应当是新签的")
			}
			if err := leaf.VerifyHostname(tc.addr); err != nil {
				t.Errorf("签出来的证书不是给 %s 的: %v", tc.addr, err)
			}
			if _, err := os.Stat(filepath.Join(dir, tc.addr)); err != nil {
				t.Errorf("证书没存进证书目录（服务要直接用它）: %v", err)
			}
			for _, p := range ports {
				ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
				if err != nil {
					t.Errorf("IssueCheck 返回后 %d 端口没释放: %v", p, err)
					continue
				}
				ln.Close()
			}

			orders := len(ca.Orders())
			again, issued, err := agent.IssueCheck(ctx, cfg)
			if err != nil {
				t.Fatalf("第二次失败: %v", err)
			}
			if issued || len(ca.Orders()) != orders {
				t.Errorf("已有有效证书还去签了（issued=%v，订单 %d → %d）", issued, orders, len(ca.Orders()))
			}
			if again.SerialNumber.Cmp(leaf.SerialNumber) != 0 {
				t.Error("第二次拿到的不是缓存里那张")
			}
		})
	}

	t.Run("挑战打不进来", func(t *testing.T) {
		ca := newCA(t)
		ports := freePorts(t, 2)
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_, _, err := agent.IssueCheck(ctx, agent.ServeConfig{
			Domain: testIP, Bind: "127.0.0.1", HTTPPort: ports[0], HTTPSPort: ports[1],
			CertDir: t.TempDir(), ACMEDirectoryURL: ca.DirectoryURL(),
		})
		if err == nil {
			t.Fatal("挑战打不进来却签出来了")
		}
		// doctor 原样打印这个 error，所以它本身就得是「原因 + 怎么修」
		if !strings.Contains(err.Error(), "安全组") {
			t.Errorf("IssueCheck 的失败不是可读诊断: %v", err)
		}
	})
}
