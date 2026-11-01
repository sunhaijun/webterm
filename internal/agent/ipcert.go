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

// Certificates for IP mode (ADR-0044).
//
// Let's Encrypt issues IP certificates only under the shortlived profile
// (about 160 hours), while autocert only places dns orders and looks up
// certificates by SNI, which browsers don't send when connecting to an IP.
// So this file drives RFC 8555 + RFC 8738 directly with acme.Client, using
// HTTP-01 only.

const (
	// ipCertProfile is the only profile Let's Encrypt accepts for IP
	// certificates.
	ipCertProfile = "shortlived"
	// accountKeyFile matches autocert's cache key name and format (EC
	// PRIVATE KEY PEM), so one data dir uses one ACME account and autocert
	// can read it after switching from an IP to a domain.
	accountKeyFile = "acme_account+key"
	// ipCertRetry is the retry interval after a failed issuance or renewal.
	// Let's Encrypt allows 5 failed validations per account per identifier
	// per hour; once an hour stays far below that.
	ipCertRetry = time.Hour
	// ipCertAttemptTimeout bounds one issuance attempt (register, order,
	// validate, finalize).
	ipCertAttemptTimeout = 5 * time.Minute
)

// IsIPAddress reports whether --domain is an IPv4 literal (IP mode).
func IsIPAddress(addr string) bool {
	ip := net.ParseIP(addr)
	return ip != nil && ip.To4() != nil && !strings.Contains(addr, ":")
}

// CheckAddress validates the --domain value. An empty value is left to the
// caller, which handles it per mode.
//
// IPv6 literals are rejected up front: the default listen address is
// 0.0.0.0, and URL building and port checks don't handle brackets or dual
// stack, so letting one in would only fail later in a more confusing way
// (ADR-0044 §1).
func CheckAddress(addr string) error {
	if strings.Contains(addr, ":") && net.ParseIP(strings.Trim(addr, "[]")) != nil {
		return fmt.Errorf("--domain %s is an IPv6 address; only IPv4 is supported.\n"+
			"  On an IPv6-only machine, use a domain name with an AAAA record", addr)
	}
	return nil
}

// acmeDirectory returns the ACME directory URL to use.
func acmeDirectory(cfg ServeConfig) string {
	switch {
	case cfg.ACMEDirectoryURL != "":
		return cfg.ACMEDirectoryURL
	}
	return acme.LetsEncryptURL
}

// ipCertManager manages one IP certificate: issuance, caching, renewal and
// serving it during handshakes.
type ipCertManager struct {
	ip      string
	dirURL  string
	certDir string
	now     func() time.Time

	mu     sync.Mutex
	cert   *tls.Certificate
	tokens map[string]string // HTTP-01: token → key authorization
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

// GetCertificate ignores SNI; clients connecting to an IP don't send it.
//
// A handshake never triggers issuance: without a certificate it fails.
// Issuance is only started explicitly (runIPCert, IssueCheck), so there is no
// "request certificates on someone else's behalf" attack surface (what
// HostPolicy guards against in ADR-0004).
func (m *ipCertManager) GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cert == nil {
		return nil, errors.New("no IP certificate yet")
	}
	return m.cert, nil
}

// HTTPHandler answers HTTP-01 challenges and passes everything else to
// fallback (the 301 to HTTPS).
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

// renewAt is when to renew: once less than 1/3 of the lifetime remains (the
// same rule as autocert).
func renewAt(leaf *x509.Certificate) time.Time {
	return leaf.NotAfter.Add(-leaf.NotAfter.Sub(leaf.NotBefore) / 3)
}

// current returns the held certificate and its leaf, or nil if there is none.
func (m *ipCertManager) current() (*tls.Certificate, *x509.Certificate) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cert == nil {
		return nil, nil
	}
	return m.cert, m.cert.Leaf
}

// ensure makes sure a certificate that isn't due for renewal is held.
//
// Order: memory, then the cache, then a new one from the CA. A restart only
// reads the cache: issuing on every restart would exhaust the "5 per week for
// the same set of names" limit within days. renewed reports whether the CA
// actually issued a new certificate.
func (m *ipCertManager) ensure(ctx context.Context) (leaf *x509.Certificate, renewed bool, err error) {
	if _, l := m.current(); l != nil && m.now().Before(renewAt(l)) {
		return l, false, nil
	}
	if c, err := m.loadCache(); err == nil && m.now().Before(renewAt(c.Leaf)) {
		m.setCert(c)
		return c.Leaf, false, nil
	} else if err == nil {
		// The cached one is due for renewal, but use it until the new one
		// arrives: unexpired beats nothing.
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

// obtain gets a new certificate from the CA and stores it.
func (m *ipCertManager) obtain(ctx context.Context) (*tls.Certificate, error) {
	key, err := m.accountKey()
	if err != nil {
		return nil, err
	}
	client := &acme.Client{Key: key, DirectoryURL: m.dirURL}
	if _, err := client.Register(ctx, &acme.Account{}, acme.AcceptTOS); err != nil &&
		!errors.Is(err, acme.ErrAccountAlreadyExists) {
		return nil, fmt.Errorf("register ACME account: %w", err)
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

// authorize completes one authorization using HTTP-01 only (ADR-0044 §2
// explains why not TLS-ALPN-01).
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
		return fmt.Errorf("CA offered no http-01 challenge (%s)", zurl)
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

// assemble combines the key and chain into a tls.Certificate and checks that
// the leaf really is for this IP.
func (m *ipCertManager) assemble(key crypto.Signer, chain [][]byte) (*tls.Certificate, error) {
	if len(chain) == 0 {
		return nil, errors.New("CA returned an empty certificate chain")
	}
	leaf, err := x509.ParseCertificate(chain[0])
	if err != nil {
		return nil, err
	}
	if err := leaf.VerifyHostname(m.ip); err != nil {
		return nil, fmt.Errorf("certificate is not valid for %s: %w", m.ip, err)
	}
	return &tls.Certificate{Certificate: chain, PrivateKey: key, Leaf: leaf}, nil
}

// ---------- Cache: same format as autocert (key PEM, then the chain) ----------

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
		return nil, errors.New("no private key in cached certificate")
	}
	c, err := m.assemble(key, chain)
	if err != nil {
		return nil, err
	}
	if !m.now().Before(c.Leaf.NotAfter) {
		return nil, errors.New("cached certificate has expired")
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
			return nil, fmt.Errorf("%s is not PEM", p)
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

// writeFileAtomic writes a temp file and renames it, so being killed midway
// never leaves half a certificate.
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

// ---------- Running: warm-up plus renewal loop ----------

// runIPCert obtains the certificate at startup and reports it, then renews at
// the renewal time, retrying hourly on failure. It returns when ctx is
// canceled (listeners closed).
func (a *Agent) runIPCert(ctx context.Context, m *ipCertManager) {
	const env = "Let's Encrypt"
	first := true
	for {
		// Bound each attempt: acme.Client's default HTTP client has no
		// timeout, so a hung CA would stall the loop forever and the
		// certificate would quietly expire days later.
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
			// No certificate at all: HTTPS is down, so say it loudly.
			a.log.Error("certificate request failed; HTTPS is not available yet", "ip", m.ip, "env", env, "retry", ipCertRetry)
			if first {
				fmt.Fprint(a.certReport(true), describeACMEError(err, m.ip))
			}
		case err != nil:
			// An unexpired certificate is still in use, but renewal failed:
			// HTTPS works for now and will break within days.
			if first {
				a.reportCertReady(env, held)
			}
			a.log.Warn("IP certificate renewal failed; retrying in an hour (renewal uses HTTP-01 on port 80 only, so port 80 must stay reachable from the internet)",
				"ip", m.ip, "err", err, "expires", held.NotAfter.Local().Format("2006-01-02 15:04"))
		default:
			if first {
				a.reportCertReady(env, leaf)
			} else if renewed {
				a.log.Info("IP certificate renewed", "ip", m.ip, "expires", leaf.NotAfter.Local().Format("2006-01-02 15:04"))
			}
			wait = renewAt(leaf).Sub(m.now())
			if renewed && wait <= 0 {
				// Due for renewal right after issuance: the system clock is
				// probably wrong. Don't issue every second; fall back to hourly.
				a.log.Warn("newly issued IP certificate is already due for renewal; check the system clock", "expires", leaf.NotAfter)
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
	fmt.Fprintf(a.certReport(false), "Certificate ready (%s, IP certificate, expires %s, renews automatically)\n",
		env, leaf.NotAfter.Local().Format("2006-01-02 15:04"))
}
