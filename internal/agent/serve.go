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

// ServeConfig configures listening and TLS.
//
// There are only two TLS code paths (ADR-0004): ACME in production and plain
// HTTP on localhost under --dev. --no-tls is a third, allowed only on
// loopback/private addresses, for users who put their own reverse proxy or
// tunnel in front.
type ServeConfig struct {
	Domain    string
	Dev       bool
	NoTLS     bool
	Bind      string
	HTTPPort  int
	HTTPSPort int
	CertDir   string

	// ACMEDirectoryURL exists only for integration tests: it points at the
	// local fake CA (internal/acmetest). Empty in production, which uses
	// Let's Encrypt.
	ACMEDirectoryURL string

	// Inherited holds listener fds handed over by a hot upgrade (name → fd,
	// name is "http" or "https"). They are reused instead of binding again,
	// so the ports never go unanswered, even briefly (ADR-0016).
	Inherited map[string]int
}

// Servers holds the running servers, for graceful shutdown and for exporting
// listeners on hot upgrade.
type Servers struct {
	https *http.Server
	http  *http.Server
	lns   map[string]net.Listener
	// stop stops the background certificate loop (IP-mode renewal, ADR-0044).
	stop context.CancelFunc
}

// listen opens the named listener, preferring an inherited fd over a new
// bind.
func (s *Servers) listen(cfg ServeConfig, name, addr string) (net.Listener, error) {
	if s.lns == nil {
		s.lns = make(map[string]net.Listener)
	}
	if fd, ok := cfg.Inherited[name]; ok {
		f := os.NewFile(uintptr(fd), name)
		if f == nil {
			return nil, fmt.Errorf("inherited listener fd %d (%s) is invalid", fd, name)
		}
		ln, err := net.FileListener(f)
		_ = f.Close() // FileListener dups its own copy
		if err != nil {
			return nil, fmt.Errorf("restore listener %s: %w", name, err)
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

// ExportListeners duplicates the listening sockets as inheritable fds
// (ADR-0016). Hold the returned *os.File values until exec; the kernel closes
// them when the old image goes away. On error, everything already exported is
// closed: those fds have CLOEXEC cleared and would otherwise leak into shells
// started later.
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
			return fail(fmt.Errorf("export listener %s: %w", name, err))
		}
		files = append(files, f)
		if err := handoff.Inherit(int(f.Fd())); err != nil {
			return fail(err)
		}
		out = append(out, handoff.Listener{Name: name, FD: int(f.Fd())})
	}
	return out, files, nil
}

// Listen starts listening as configured and returns immediately. Server
// errors are reported on the returned channel.
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
		a.log.Info("webterm started (dev mode)", "url", "http://"+addr)

	case cfg.NoTLS:
		// Reverse proxy / tunnel: the layer in front terminates TLS.
		if !isLoopbackOrPrivate(cfg.Bind) {
			return nil, nil, fmt.Errorf(
				"--no-tls requires a loopback or private --bind address, got --bind=%s; "+
					"serving webterm over plain HTTP on the internet hands out your shell", cfg.Bind)
		}
		addr := fmt.Sprintf("%s:%d", cfg.Bind, cfg.HTTPPort)
		s.http = &http.Server{Addr: addr, Handler: handler, ReadHeaderTimeout: 10 * time.Second,
			ErrorLog: a.httpErrorLog()}
		ln, err := s.listen(cfg, "http", addr)
		if err != nil {
			return nil, nil, describeBindError(err, cfg.HTTPPort)
		}
		go func() { errCh <- s.http.Serve(ln) }()
		a.log.Info("webterm started (plain HTTP; expecting a reverse proxy to terminate TLS)", "addr", addr)

	default:
		if cfg.Domain == "" {
			return nil, nil, errors.New("--domain is required (a domain name or public IPv4 address, for ACME), or use --dev")
		}
		if err := CheckAddress(cfg.Domain); err != nil {
			return nil, nil, err
		}
		// Catch this early: otherwise the second listener hits "address
		// already in use" and describeBindError sends the user looking for
		// whoever holds the port, which is webterm itself.
		if cfg.HTTPPort == cfg.HTTPSPort {
			return nil, nil, fmt.Errorf(
				"--http-port and --https-port must differ (both are %d).\n"+
					"  --http-port serves ACME challenges and redirects, --https-port serves HTTPS; they need separate ports",
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

		// :80 does two things only: ACME challenges and 301 redirects to HTTPS.
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
		a.log.Info("webterm started", "url", ExternalURL(cfg.Domain, cfg.HTTPSPort))

		// Warm up the certificate.
		//
		// autocert is lazy by default: it requests a certificate on the first
		// TLS handshake, so startup can't tell whether ACME works; the user
		// would only find out in the browser. Trigger it now, print the expiry
		// on success and a readable diagnosis on failure (AC-1.13). In IP mode
		// this is also the renewal loop (ADR-0044), since our own certificate
		// manager has no autocert timer.
		go warm(ctx)
	}
	return s, errCh, nil
}

// certSource supplies HTTPS certificates: autocert for domains, our own
// ipCertManager for IP addresses.
type certSource interface {
	GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error)
	HTTPHandler(fallback http.Handler) http.Handler
}

// certSource picks the certificate source for --domain and returns the
// warm-up to run after startup (which also renews in IP mode).
func (a *Agent) certSource(cfg ServeConfig) (certSource, func(context.Context)) {
	if IsIPAddress(cfg.Domain) {
		m := newIPCertManager(cfg)
		return m, func(ctx context.Context) { a.runIPCert(ctx, m) }
	}
	m := newCertManager(cfg)
	return m, func(context.Context) { a.warmCertificate(m, cfg.Domain) }
}

// tlsConfigFor returns the TLS config for the HTTPS listener.
//
// Domain mode advertises acme-tls/1: autocert tries TLS-ALPN-01 first, so
// renewal still works over 443 if port 80 is closed later. IP mode uses only
// HTTP-01 (ADR-0044 §2) and does not advertise it.
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
		return fmt.Errorf("create cert dir: %w", err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return fmt.Errorf("chmod cert dir: %w", err)
	}
	return nil
}

// IssueCheck is the core of webterm doctor --acme (ADR-0045 §4). It
// temporarily listens on the http and https ports, obtains a certificate into
// cfg.CertDir (the same certs/ the service uses), returns the leaf and
// releases the ports. issued reports whether the CA actually issued a new
// certificate; a valid cached one is reused rather than requesting another.
//
// It proves the one thing that can't be checked from inside the machine: the
// CA can reach it from the internet (cloud security groups, NAT, ISPs
// blocking port 80). The certificate is a real production one that the
// service uses as is; a failure only costs from the hourly failed-validation
// limit (ADR-0044 §3), so staging isn't needed.
func IssueCheck(ctx context.Context, cfg ServeConfig) (leaf *x509.Certificate, issued bool, err error) {
	if err := CheckAddress(cfg.Domain); err != nil {
		return nil, false, err
	}
	if err := prepareCertDir(cfg.CertDir); err != nil {
		return nil, false, err
	}
	// Comparing the cache file before and after tells new from cached; both
	// modes cache at certs/<address>.
	cachePath := filepath.Join(cfg.CertDir, cfg.Domain)
	before, _ := os.ReadFile(cachePath)
	var src certSource
	var issue func(context.Context) (*tls.Certificate, error)
	if IsIPAddress(cfg.Domain) {
		m := newIPCertManager(cfg)
		src = m
		// ensure, not obtain: reuse a cached certificate that isn't due for
		// renewal instead of requesting another.
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
		// A human-readable diagnosis (same as at startup) that doctor prints
		// verbatim, flagged when the CA couldn't reach us (ADR-0046).
		return nil, false, newIssueError(err, cfg.Domain)
	}
	after, _ := os.ReadFile(cachePath)
	issued = !bytes.Equal(before, after)
	if cert.Leaf != nil {
		return cert.Leaf, issued, nil
	}
	leaf, err = x509.ParseCertificate(cert.Certificate[0])
	return leaf, issued, err
}

// newCertManager builds the autocert.Manager.
//
// It is separate so unit tests can check two properties: HostPolicy has no
// wildcard, and RenewBefore is left unset.
func newCertManager(cfg ServeConfig) *autocert.Manager {
	// Domains only. IP addresses use ipCertManager (ADR-0044): autocert only
	// places dns orders.
	m := &autocert.Manager{
		Prompt: autocert.AcceptTOS,
		Cache:  autocert.DirCache(cfg.CertDir),
		// HostPolicy allows exactly --domain, never a wildcard; otherwise
		// it could be used to request certificates for any name (threat
		// model T8).
		HostPolicy: autocert.HostWhitelist(cfg.Domain),

		// RenewBefore is deliberately unset. autocert then uses
		// min(30 days, lifetime/3), which scales with the certificate
		// lifetime. A fixed 30 days would turn into "renew immediately,
		// every time" with short-lived certificates (LE now offers 6-day
		// ones).
	}
	switch {
	case cfg.ACMEDirectoryURL != "":
		m.Client = &acme.Client{DirectoryURL: cfg.ACMEDirectoryURL}
	}
	return m
}

// certReport is where the certificate warm-up result is written.
//
// Production splits it (success to stdout, failure to stderr); tests set
// Config.CertReport to collect both in one buffer.
func (a *Agent) certReport(failed bool) io.Writer {
	if a.cfg.CertReport != nil {
		return a.cfg.CertReport
	}
	if failed {
		return os.Stderr
	}
	return os.Stdout
}

// warmCertificate requests or loads the certificate once at startup and
// reports the result to the user.
//
// autocert starts its renewal timer when a certificate is loaded into memory,
// and by default that only happens on the first TLS handshake. After a
// restart with no visitors there would be no renewal timer at all. Loading it
// here makes the timer exist from startup.
func (a *Agent) warmCertificate(m *autocert.Manager, domain string) {
	const env = "Let's Encrypt"
	cert, err := m.GetCertificate(warmupHello(domain))
	if err != nil {
		a.log.Error("certificate request failed; HTTPS is not available yet", "domain", domain, "env", env)
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
			a.log.Info("certificate ready", "env", env)
			return
		}
		leaf = parsed
	}
	// autocert renews min(30 days, lifetime/3) before expiry. Renewal
	// validates the domain again; either 80 (HTTP-01) or 443 (TLS-ALPN-01)
	// being reachable is enough.
	fmt.Fprintf(a.certReport(false), "Certificate ready (%s, expires %s, renews automatically)\n",
		env, leaf.NotAfter.Local().Format("2006-01-02"))
}

// httpErrorLog routes net/http's internal errors into slog and demotes TLS
// handshake noise to DEBUG.
//
// webterm's ports are open to the whole internet (threat model T-net), and
// scanners keep producing "http: TLS handshake error from ..." lines:
// connecting by IP without SNI, sending plain HTTP, connecting and idling
// until timeout. slog.SetDefault makes net/http's default log.Logger print at
// INFO, so this noise would bury the lines that matter: certificate warm-up
// results, bind failures, session errors.
//
// Demoted rather than dropped: debugging "I can't connect" still needs them,
// and --log-level debug shows them.
func (a *Agent) httpErrorLog() *log.Logger {
	return log.New(httpLogWriter{log: a.log}, "", 0)
}

type httpLogWriter struct{ log *slog.Logger }

func (w httpLogWriter) Write(p []byte) (int, error) {
	msg := strings.TrimRight(string(p), "\n")
	if strings.HasPrefix(msg, "http: TLS handshake error") {
		w.log.Debug(msg)
	} else {
		// Everything else (recovered panics, timeouts) matters.
		w.log.Info(msg)
	}
	return len(p), nil
}

// warmupHello builds a ClientHelloInfo that looks like a real browser, for
// the warm-up.
//
// An empty ClientHelloInfo does not work. autocert's cache key includes
// isRSA = !supportsECDSA(hello), and supportsECDSA returns false for an empty
// hello, so the warm-up would obtain an RSA certificate stored under
// "<domain>+rsa". Real browsers all advertise ECDSA and use the key
// "<domain>", so they miss, and autocert requests another certificate inside
// the TLS handshake. Three consequences, all hard to debug:
//
//  1. Every restart issues an extra certificate, quickly exhausting Let's
//     Encrypt's duplicate certificate limit (5 per week), after which HTTPS
//     stops working.
//  2. The handshake waits for the whole ACME flow, so any ACME hiccup
//     becomes a handshake failure ("missing certificate" plus ACME 4xx in
//     the log).
//  3. "Certificate ready" reports a certificate real clients never use: a
//     false success.
//
// Only the ECDSA slot is warmed: it is the only one modern clients use.
// Warming both would issue an extra certificate and waste the limit.
//
// Regression test: TestWarmupHitsTheCacheSlotRealClientsUse.
func warmupHello(domain string) *tls.ClientHelloInfo {
	return &tls.ClientHelloInfo{
		ServerName:       domain,
		CipherSuites:     []uint16{tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256},
		SupportedCurves:  []tls.CurveID{tls.CurveP256},
		SignatureSchemes: []tls.SignatureScheme{tls.ECDSAWithP256AndSHA256},
	}
}

// describeACMEError turns an ACME failure into "what happened + how to fix
// it" instead of a raw Go error (US-7.2 / AC-1.13). domain may be an IP
// address (ADR-0044).
func describeACMEError(err error, domain string) string {
	msg := err.Error()
	ip := IsIPAddress(domain)
	var b strings.Builder
	b.WriteString("\n")
	// Narrow cases first: the "can't connect" case below matches broadly and
	// would shadow them.
	switch {
	case strings.Contains(msg, "does not support profiles"),
		strings.Contains(msg, "does not advertise a profile"),
		strings.Contains(msg, "invalidProfile"),
		// Let's Encrypt's exact wording for an IP order without shortlived.
		strings.Contains(msg, "does not permit IP address identifiers"):
		b.WriteString("  This CA does not issue IP certificates: its directory has no shortlived profile.\n")
		b.WriteString("  Let's Encrypt is currently the only CA that does. Otherwise, use a domain name.\n")
	case strings.Contains(msg, "rateLimited"), strings.Contains(msg, "too many"):
		b.WriteString("  Hit a Let's Encrypt rate limit.\n")
		b.WriteString("  Failed validations are limited per hour (5 per hour): wait an hour and retry.\n")
		b.WriteString("  Issued certificates are limited per week (50 per domain or IP, 5 for the same set of names):\n")
		b.WriteString("  usually caused by deleting certs/ repeatedly. The only fix is to wait.\n")
	case strings.Contains(msg, "no such host"), strings.Contains(msg, "NXDOMAIN"):
		b.WriteString("  " + domain + " does not resolve. Check that the A/AAAA record exists and the old TTL has expired:\n")
		b.WriteString("    dig +short " + domain + "\n")
	case strings.Contains(msg, "not configured in HostWhitelist"):
		b.WriteString("  The requested name does not match --domain. HostPolicy deliberately allows no wildcards;\n")
		b.WriteString("  otherwise anyone could use this server to get certificates for arbitrary names.\n")
	case ip && isChallengeFailure(msg):
		b.WriteString("  The CA could not reach http://" + domain + "/ to validate it. IP certificates validate on port 80 only (HTTP-01). Check in order:\n")
		b.WriteString("    1. Does your cloud security group / firewall allow inbound TCP 80? (the step most often missed)\n")
		b.WriteString("         From another machine: curl -sI http://" + domain + "/\n")
		b.WriteString("    2. Is " + domain + " this machine's public IP?\n")
		b.WriteString("         curl -s ifconfig.me\n")
	case isChallengeFailure(msg):
		// The most common failure. autocert tries every challenge type before
		// giving up, so what users actually see is "no viable challenge type
		// found", not the underlying "Invalid response".
		b.WriteString("  The CA could not reach this machine to validate the domain. Validation uses port 80 (HTTP-01)\n")
		b.WriteString("  or 443 (TLS-ALPN-01), and both failed. Check in order:\n")
		b.WriteString("    1. Does your cloud security group / firewall allow inbound TCP 80 and 443? (the step most often missed)\n")
		b.WriteString("         From another machine: curl -sI http://" + domain + "/\n")
		b.WriteString("    2. Does DNS point to this machine?\n")
		b.WriteString("         dig +short " + domain + "   should equal   curl -s ifconfig.me\n")
		b.WriteString("    3. On Cloudflare, turn off the proxy (orange cloud): use DNS only, not Proxied.\n")
	default:
		b.WriteString("  " + msg + "\n")
		b.WriteString("  See \"Certificates and TLS\" in docs/80-ops/troubleshooting.md.\n")
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

// Shutdown gracefully closes the listeners. Sessions are left alone;
// session.Manager owns them.
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

// ExternalURL is the public address: domain plus any non-default port.
//
// 443 is the default and would be noise; any other port must be included or
// the URL won't open (this happens when another service holds 443; see
// "Non-standard ports" in docs/80-ops/install.md). 0 is treated as the default
// and never rendered as :0.
//
// The startup log, HTTPS redirects, Origin checks, pairing URLs and the
// status overview all use this one rule.
func ExternalURL(domain string, httpsPort int) string {
	return "https://" + externalHost(domain, httpsPort)
}

func externalHost(domain string, httpsPort int) string {
	if httpsPort != 0 && httpsPort != 443 {
		return fmt.Sprintf("%s:%d", domain, httpsPort)
	}
	return domain
}

// redirectToHTTPS 301-redirects every non-challenge request on :80 to HTTPS.
func redirectToHTTPS(domain string, httpsPort int) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := externalHost(domain, httpsPort)
		http.Redirect(w, r, "https://"+host+r.URL.RequestURI(), http.StatusMovedPermanently)
	})
}

// describeBindError turns a Go bind error into something a person can act on
// (US-7.2 / AC-1.13).
func describeBindError(err error, port int) error {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "address already in use"):
		return fmt.Errorf(
			"port %d is already in use.\n"+
				"  Find out what holds it:  ss -lntp | grep :%d\n"+
				"  Stop it, or run behind a reverse proxy (see \"Reverse proxy or tunnel\" in docs/80-ops/install.md)",
			port, port)
	case strings.Contains(msg, "permission denied"):
		return fmt.Errorf(
			"no permission to bind port %d (ports below 1024 need a capability).\n"+
				"  Recommended:  sudo setcap 'cap_net_bind_service=+ep' $(command -v webterm)\n"+
				"  Then run it again as a normal user. Don't run webterm as root: that puts a root shell on the internet",
			port)
	}
	return fmt.Errorf("listen on port %d: %w", port, err)
}

// isLoopbackOrPrivate reports whether bind is a loopback or private address.
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

// CertDirDefault returns the default certificate cache directory.
func CertDirDefault(dataDir string) string { return filepath.Join(dataDir, "certs") }
