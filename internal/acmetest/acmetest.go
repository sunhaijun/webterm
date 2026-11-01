// Package acmetest is a tiny RFC 8555 server that exists only for
// integration tests.
//
// # Why not pebble
//
//  1. pebble pulls in a whole tree of module dependencies (gorilla/mux,
//     miekg/dns, …). Even as a test-only dependency it lands in go.sum and CI
//     fetches it every run.
//  2. pebble's VA does real DNS resolution to validate HTTP-01 challenges.
//     Test domains would have to resolve to localhost, which means editing
//     /etc/hosts or wiring a custom DNS server into pebble. Both depend on
//     the CI environment and are brittle.
//
// Writing our own is simpler: no dependencies, no network, no DNS (the test
// sets the address used for challenge validation), and it runs in under a
// second.
//
// # What it proves, and what it doesn't
//
// It proves our side is wired correctly: autocert is configured right, the
// challenge handler on :80 is reachable, startup warm-up really obtains a
// certificate and stores it, the certificate works for a handshake, and
// failures produce readable diagnostics.
//
// It does not prove protocol compatibility with Let's Encrypt; that is the
// job of golang.org/x/crypto/acme and its own tests. This server only needs
// to be good enough to drive that client, not to reproduce a real CA's
// strictness.
//
// That is why it deliberately does not verify JWS signatures: doing so adds
// nothing to what the tests prove.
package acmetest

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"time"
)

// Server is a fake ACME CA running on httptest.
type Server struct {
	ts     *httptest.Server
	caKey  *ecdsa.PrivateKey
	caCert *x509.Certificate

	mu sync.Mutex
	// validateAddr is the host:port dialed to validate HTTP-01 challenges.
	// A real CA resolves the domain; here the test sets it, bypassing DNS.
	validateAddr string
	orders       map[string]*order
	nextID       int
	// issued records the names that were issued.
	issued []string
	// requests counts all requests received. The --dev assertions use it:
	// "nothing was issued" is too weak (issuance may have started and
	// failed); "the CA was never contacted" is the strong form.
	requests int
	// certLifetime lets tests produce short-lived certificates.
	certLifetime time.Duration
	// logf hands internal events to the test, above all the real reason a
	// challenge failed. Without it, autocert collapses ACME failures into
	// "no viable challenge type found", which is impossible to debug.
	logf func(string, ...any)
	// profiles are the profiles declared in the directory's meta.profiles
	// (ADR-0044: IP certificates need shortlived). nil means the CA does not
	// support profiles; used to test the "CA won't issue IP certs" error.
	profiles map[string]string
	// orderLog records each order's identifier type and profile in arrival
	// order, so tests can assert on the shape of the request.
	orderLog []OrderInfo
}

// OrderInfo is what the client requested in one order.
type OrderInfo struct {
	Type    string // "dns" or "ip"
	Value   string
	Profile string
}

type order struct {
	idType  string
	domain  string
	profile string
	token   string
	status  string // pending | valid | invalid
	certPEM []byte
	problem string
}

// New starts a fake CA. The caller must Close it.
func New() (*Server, error) {
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "acmetest fake CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &caKey.PublicKey, caKey)
	if err != nil {
		return nil, err
	}
	caCert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}

	s := &Server{
		caKey:        caKey,
		caCert:       caCert,
		orders:       map[string]*order{},
		certLifetime: 90 * 24 * time.Hour, // same as Let's Encrypt
		// Same as Let's Encrypt: classic is the default, shortlived is 6 days
		// and the only option for IP certificates.
		profiles: map[string]string{
			"classic":    "https://example.invalid/classic",
			"shortlived": "https://example.invalid/shortlived",
		},
	}
	s.ts = httptest.NewServer(s.mux())
	return s, nil
}

func (s *Server) Close() { s.ts.Close() }

// SetLogf sets a log function, usually t.Logf.
func (s *Server) SetLogf(f func(string, ...any)) {
	s.mu.Lock()
	s.logf = f
	s.mu.Unlock()
}

func (s *Server) log(format string, args ...any) {
	s.mu.Lock()
	f := s.logf
	s.mu.Unlock()
	if f != nil {
		f(format, args...)
	}
}

// DirectoryURL is the directory URL to give acme.Client.
func (s *Server) DirectoryURL() string { return s.ts.URL + "/directory" }

// RootPool returns a cert pool trusting this fake CA, for checking that the
// agent really completes a handshake.
func (s *Server) RootPool() *x509.CertPool {
	p := x509.NewCertPool()
	p.AddCert(s.caCert)
	return p
}

// ValidateAgainst sets the address dialed to validate HTTP-01 challenges.
// Empty makes validation always fail, for testing the "challenge can't reach
// us" path.
func (s *Server) ValidateAgainst(addr string) {
	s.mu.Lock()
	s.validateAddr = addr
	s.mu.Unlock()
}

// SetCertLifetime changes the lifetime of issued certificates, for testing
// that the renewal rule scales with lifetime.
func (s *Server) SetCertLifetime(d time.Duration) {
	s.mu.Lock()
	s.certLifetime = d
	s.mu.Unlock()
}

// SetProfiles changes the profiles declared in the directory. nil means the
// CA does not support profiles.
func (s *Server) SetProfiles(p map[string]string) {
	s.mu.Lock()
	s.profiles = p
	s.mu.Unlock()
}

// Orders returns the orders received, in order.
func (s *Server) Orders() []OrderInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]OrderInfo(nil), s.orderLog...)
}

// Issued returns the domains / IPs that were issued. Tests use it to assert
// that --dev never starts issuance at all.
func (s *Server) Issued() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.issued...)
}

func (s *Server) mux() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/directory", s.directory)
	mux.HandleFunc("/nonce", s.nonce)
	mux.HandleFunc("/new-account", s.newAccount)
	mux.HandleFunc("/new-order", s.newOrder)
	mux.HandleFunc("/authz/", s.authz)
	mux.HandleFunc("/challenge/", s.challenge)
	mux.HandleFunc("/finalize/", s.finalize)
	mux.HandleFunc("/order/", s.orderStatus)
	mux.HandleFunc("/cert/", s.certificate)
	// Every response carries Replay-Nonce, so the client can take one from any
	// response.
	return s.count(withNonce(mux))
}

func (s *Server) count(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.requests++
		s.mu.Unlock()
		next.ServeHTTP(w, r)
	})
}

// Requests returns the total number of requests received.
func (s *Server) Requests() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.requests
}

func withNonce(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Replay-Nonce", randomToken())
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) directory(w http.ResponseWriter, _ *http.Request) {
	dir := map[string]any{
		"newNonce":   s.ts.URL + "/nonce",
		"newAccount": s.ts.URL + "/new-account",
		"newOrder":   s.ts.URL + "/new-order",
		"revokeCert": s.ts.URL + "/revoke",
		"keyChange":  s.ts.URL + "/key-change",
	}
	s.mu.Lock()
	if s.profiles != nil {
		dir["meta"] = map[string]any{"profiles": s.profiles}
	}
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, dir)
}

func (s *Server) nonce(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
}

func (s *Server) newAccount(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Location", s.ts.URL+"/account/1")
	writeJSON(w, http.StatusCreated, map[string]any{
		"status":  "valid",
		"contact": []string{},
	})
}

func (s *Server) newOrder(w http.ResponseWriter, r *http.Request) {
	payload, err := jwsPayload(r)
	if err != nil {
		writeProblem(w, http.StatusBadRequest, "malformed", err.Error())
		return
	}
	var req struct {
		Identifiers []struct {
			Type  string `json:"type"`
			Value string `json:"value"`
		} `json:"identifiers"`
		Profile string `json:"profile"`
	}
	if err := json.Unmarshal(payload, &req); err != nil || len(req.Identifiers) == 0 {
		writeProblem(w, http.StatusBadRequest, "malformed", "order has no identifiers")
		return
	}
	id0 := req.Identifiers[0]

	s.mu.Lock()
	s.orderLog = append(s.orderLog, OrderInfo{Type: id0.Type, Value: id0.Value, Profile: req.Profile})
	if req.Profile != "" && s.profiles[req.Profile] == "" {
		s.mu.Unlock()
		writeProblem(w, http.StatusBadRequest, "invalidProfile", "unknown profile "+req.Profile)
		return
	}
	// Like Let's Encrypt: IP certificates must use shortlived.
	if id0.Type == "ip" && req.Profile != "shortlived" {
		s.mu.Unlock()
		writeProblem(w, http.StatusBadRequest, "rejectedIdentifier", "IP identifiers require the shortlived profile")
		return
	}
	s.nextID++
	id := fmt.Sprintf("%d", s.nextID)
	o := &order{idType: id0.Type, domain: id0.Value, profile: req.Profile, token: randomToken(), status: "pending"}
	s.orders[id] = o
	s.mu.Unlock()

	w.Header().Set("Location", s.ts.URL+"/order/"+id)
	writeJSON(w, http.StatusCreated, s.orderJSON(id, o))
}

func (s *Server) orderJSON(id string, o *order) map[string]any {
	out := map[string]any{
		"status":  o.status,
		"expires": time.Now().Add(time.Hour).Format(time.RFC3339),
		"identifiers": []map[string]string{
			{"type": o.idType, "value": o.domain},
		},
		"authorizations": []string{s.ts.URL + "/authz/" + id},
		"finalize":       s.ts.URL + "/finalize/" + id,
	}
	if o.certPEM != nil {
		out["certificate"] = s.ts.URL + "/cert/" + id
	}
	return out
}

func (s *Server) authz(w http.ResponseWriter, r *http.Request) {
	id := lastSegment(r.URL.Path)
	s.mu.Lock()
	o := s.orders[id]
	s.mu.Unlock()
	if o == nil {
		writeProblem(w, http.StatusNotFound, "malformed", "no such authz")
		return
	}
	body := map[string]any{
		"status":     o.status,
		"identifier": map[string]string{"type": o.idType, "value": o.domain},
		"challenges": []map[string]any{
			{
				"type":   "http-01",
				"url":    s.ts.URL + "/challenge/" + id,
				"token":  o.token,
				"status": o.status,
			},
		},
	}
	if o.status == "invalid" {
		body["challenges"].([]map[string]any)[0]["error"] = map[string]any{
			"type":   "urn:ietf:params:acme:error:connection",
			"detail": o.problem,
		}
	}
	writeJSON(w, http.StatusOK, body)
}

// challenge validates synchronously on POST so the client doesn't have to
// poll.
func (s *Server) challenge(w http.ResponseWriter, r *http.Request) {
	id := lastSegment(r.URL.Path)
	s.mu.Lock()
	o := s.orders[id]
	addr := s.validateAddr
	s.mu.Unlock()
	if o == nil {
		writeProblem(w, http.StatusNotFound, "malformed", "no such challenge")
		return
	}

	if err := s.validateHTTP01(addr, o.domain, o.token); err != nil {
		s.log("acmetest: challenge %s failed validation: %v", id, err)
		s.mu.Lock()
		o.status = "invalid"
		o.problem = err.Error()
		s.mu.Unlock()
	} else {
		s.mu.Lock()
		o.status = "valid"
		s.mu.Unlock()
	}

	s.mu.Lock()
	status := o.status
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"type":   "http-01",
		"url":    s.ts.URL + "/challenge/" + id,
		"token":  o.token,
		"status": status,
	})
}

// validateHTTP01 fetches the challenge response under .well-known.
//
// It dials addr but sends Host: domain, as a real CA does: resolve the domain
// to an IP, connect, keep the domain in the Host header. This matters:
// autocert's challenge handler checks Host against HostPolicy and returns 403
// on a mismatch, so the tests also prove HostPolicy is enforced on the
// challenge path.
//
// It only checks that the response starts with "<token>.". That is enough to
// prove autocert's handler is mounted at the right path and returns the right
// token. The full keyAuthorization needs the account key thumbprint and adds
// nothing to checking our wiring.
func (s *Server) validateHTTP01(addr, domain, token string) error {
	if addr == "" {
		return fmt.Errorf("Invalid response from http://%s/.well-known/acme-challenge/%s: connection refused", domain, token)
	}
	url := fmt.Sprintf("http://%s/.well-known/acme-challenge/%s", addr, token)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Host = domain // a real CA sends the domain, not the IP
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("Invalid response from %s: %v", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("Invalid response from %s: %d", url, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err != nil {
		return err
	}
	if !strings.HasPrefix(string(body), token+".") {
		return fmt.Errorf("Invalid response from %s: challenge response does not start with the token", url)
	}
	return nil
}

func (s *Server) finalize(w http.ResponseWriter, r *http.Request) {
	id := lastSegment(r.URL.Path)
	s.mu.Lock()
	o := s.orders[id]
	s.mu.Unlock()
	if o == nil {
		writeProblem(w, http.StatusNotFound, "malformed", "no such order")
		return
	}
	if o.status != "valid" {
		writeProblem(w, http.StatusForbidden, "orderNotReady", "challenge not yet valid")
		return
	}

	payload, err := jwsPayload(r)
	if err != nil {
		writeProblem(w, http.StatusBadRequest, "malformed", err.Error())
		return
	}
	var req struct {
		CSR string `json:"csr"`
	}
	if err := json.Unmarshal(payload, &req); err != nil {
		writeProblem(w, http.StatusBadRequest, "malformed", "invalid finalize payload")
		return
	}
	der, err := base64.RawURLEncoding.DecodeString(req.CSR)
	if err != nil {
		writeProblem(w, http.StatusBadRequest, "badCSR", "CSR is not base64url")
		return
	}
	csr, err := x509.ParseCertificateRequest(der)
	if err != nil {
		writeProblem(w, http.StatusBadRequest, "badCSR", "cannot parse CSR")
		return
	}

	certPEM, err := s.issue(csr)
	if err != nil {
		writeProblem(w, http.StatusInternalServerError, "serverInternal", err.Error())
		return
	}
	s.mu.Lock()
	o.certPEM = certPEM
	s.issued = append(s.issued, csr.DNSNames...)
	for _, ip := range csr.IPAddresses {
		s.issued = append(s.issued, ip.String())
	}
	s.mu.Unlock()

	w.Header().Set("Location", s.ts.URL+"/order/"+id)
	writeJSON(w, http.StatusOK, s.orderJSON(id, o))
}

func (s *Server) orderStatus(w http.ResponseWriter, r *http.Request) {
	id := lastSegment(r.URL.Path)
	s.mu.Lock()
	o := s.orders[id]
	s.mu.Unlock()
	if o == nil {
		writeProblem(w, http.StatusNotFound, "malformed", "no such order")
		return
	}
	writeJSON(w, http.StatusOK, s.orderJSON(id, o))
}

func (s *Server) certificate(w http.ResponseWriter, r *http.Request) {
	id := lastSegment(r.URL.Path)
	s.mu.Lock()
	o := s.orders[id]
	s.mu.Unlock()
	if o == nil || o.certPEM == nil {
		writeProblem(w, http.StatusNotFound, "malformed", "no certificate yet")
		return
	}
	w.Header().Set("Content-Type", "application/pem-certificate-chain")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(o.certPEM)
}

func (s *Server) issue(csr *x509.CertificateRequest) ([]byte, error) {
	s.mu.Lock()
	lifetime := s.certLifetime
	s.mu.Unlock()

	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 96))
	if err != nil {
		return nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: firstOr(csr.DNSNames, "")},
		DNSNames:     csr.DNSNames,
		IPAddresses:  append([]net.IP(nil), csr.IPAddresses...),
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(lifetime),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, s.caCert, csr.PublicKey, s.caKey)
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := pem.Encode(&buf, &pem.Block{Type: "CERTIFICATE", Bytes: der}); err != nil {
		return nil, err
	}
	if err := pem.Encode(&buf, &pem.Block{Type: "CERTIFICATE", Bytes: s.caCert.Raw}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// ---------- Helpers ----------

// jwsPayload extracts the JWS payload. It deliberately skips signature
// verification; see the package comment.
func jwsPayload(r *http.Request) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	var jws struct {
		Protected string `json:"protected"`
		Payload   string `json:"payload"`
		Signature string `json:"signature"`
	}
	if err := json.Unmarshal(body, &jws); err != nil {
		return nil, fmt.Errorf("invalid JWS: %w", err)
	}
	if jws.Payload == "" {
		return []byte("{}"), nil // POST-as-GET
	}
	return base64.RawURLEncoding.DecodeString(jws.Payload)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeProblem(w http.ResponseWriter, code int, typ, detail string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"type":   "urn:ietf:params:acme:error:" + typ,
		"detail": detail,
	})
}

func randomToken() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return base64.RawURLEncoding.EncodeToString(b[:])
}

func lastSegment(p string) string {
	i := strings.LastIndexByte(p, '/')
	return p[i+1:]
}

func firstOr(ss []string, fallback string) string {
	if len(ss) > 0 {
		return ss[0]
	}
	return fallback
}

// TLSClientConfig returns a tls.Config that trusts this fake CA, for testing
// handshakes.
func (s *Server) TLSClientConfig(serverName string) *tls.Config {
	return &tls.Config{ServerName: serverName, RootCAs: s.RootPool(), MinVersion: tls.VersionTLS12}
}
