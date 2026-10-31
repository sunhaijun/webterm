package agent_test

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/acmetest"
	"github.com/sunhaijun/webterm/internal/agent"
	"github.com/sunhaijun/webterm/internal/session"
	"github.com/sunhaijun/webterm/internal/store"
)

// 重启不该重新申请证书：缓存里的还有效就直接加载，一次 ACME 调用都不发。
func TestRestartReusesCachedCertificate(t *testing.T) {
	ca, err := acmetest.New()
	if err != nil {
		t.Fatal(err)
	}
	defer ca.Close()
	ca.SetLogf(t.Logf)

	base := t.TempDir()
	certDir := filepath.Join(base, "certs")
	// 【必须一次分配两个】。分开调 freePort 两次，第一个 listener 已关闭，OS 可能
	// 把同一个端口再发给第二次 —— http/https 撞车，偶发 CI 红（见 #30 的 freePorts）。
	ports := freePorts(t, 2)
	httpPort, httpsPort := ports[0], ports[1]
	ca.ValidateAgainst(fmt.Sprintf("127.0.0.1:%d", httpPort))

	start := func(round string) {
		dir := filepath.Join(base, "data-"+round)
		st, err := store.Open(dir)
		if err != nil {
			t.Fatal(err)
		}
		defer st.Close()
		sessions := session.NewManager(session.Config{MaxSessions: 1, RingBytes: 1 << 16, Shell: "bash"})
		defer sessions.Shutdown()

		report := &lockedBuffer{}
		a := agent.New(agent.Config{
			Domain: "term.test", Version: "test",
			Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
			CertReport: report,
		}, st, sessions)

		servers, _, err := a.Listen(agent.ServeConfig{
			Domain: "term.test", Bind: "127.0.0.1",
			HTTPPort: httpPort, HTTPSPort: httpsPort,
			CertDir: certDir, ACMEDirectoryURL: ca.DirectoryURL(),
		}, a.Handler())
		if err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(20 * time.Second)
		for time.Now().Before(deadline) && !strings.Contains(report.String(), "证书已就绪") {
			time.Sleep(20 * time.Millisecond)
		}
		if !strings.Contains(report.String(), "证书已就绪") {
			t.Fatalf("%s 轮没拿到证书: %q", round, report.String())
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		servers.Shutdown(ctx)
		cancel()
	}

	start("第一次")
	afterFirst := ca.Requests()
	issuedFirst := len(ca.Issued())
	t.Logf("第一次启动：签发 %d 张，CA 收到 %d 个请求", issuedFirst, afterFirst)

	start("重启")
	t.Logf("重启之后：签发 %d 张，CA 收到 %d 个请求", len(ca.Issued()), ca.Requests())

	if n := len(ca.Issued()); n != issuedFirst {
		t.Errorf("重启后签发数从 %d 变成 %d —— 重启不该重签", issuedFirst, n)
	}
	if ca.Requests() != afterFirst {
		t.Errorf("重启后 CA 收到 %d 个请求（原来 %d）—— 重启不该找 CA",
			ca.Requests(), afterFirst)
	}
	_ = http.StatusOK
}
