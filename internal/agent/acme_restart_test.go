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

// A restart must not request a new certificate: a valid cached one is loaded
// without a single ACME call.
func TestRestartReusesCachedCertificate(t *testing.T) {
	ca, err := acmetest.New()
	if err != nil {
		t.Fatal(err)
	}
	defer ca.Close()
	ca.SetLogf(t.Logf)

	base := t.TempDir()
	certDir := filepath.Join(base, "certs")
	// Allocate both at once. Two separate freePort calls can return the same
	// port, since the first listener is already closed; http and https would
	// collide and CI would flake (see freePorts).
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
		for time.Now().Before(deadline) && !strings.Contains(report.String(), "Certificate ready") {
			time.Sleep(20 * time.Millisecond)
		}
		if !strings.Contains(report.String(), "Certificate ready") {
			t.Fatalf("%s run got no certificate: %q", round, report.String())
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		servers.Shutdown(ctx)
		cancel()
	}

	start("first")
	afterFirst := ca.Requests()
	issuedFirst := len(ca.Issued())
	t.Logf("first start: %d issued, %d CA requests", issuedFirst, afterFirst)

	start("restart")
	t.Logf("after restart: %d issued, %d CA requests", len(ca.Issued()), ca.Requests())

	if n := len(ca.Issued()); n != issuedFirst {
		t.Errorf("issued count went from %d to %d after restart; a restart must not reissue", issuedFirst, n)
	}
	if ca.Requests() != afterFirst {
		t.Errorf("CA got %d requests after restart (was %d); a restart must not contact the CA",
			ca.Requests(), afterFirst)
	}
	_ = http.StatusOK
}
