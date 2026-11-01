// Package acmetest 是一个极小的 RFC 8555 服务器，只为集成测试而存在。
//
// # 为什么不用 pebble
//
// docs/70-testing/strategy.md 原本写的是「用 pebble 本地 ACME 验证签发」。
// 实际动手时有两个障碍：
//
//  1. pebble 会带进来一整棵新的模块依赖（gorilla/mux、miekg/dns…）。
//     它是测试专用的，但仍然进 go.sum，CI 每次都要拉。
//  2. **pebble 的 VA 会做真实的 DNS 解析**去验证 HTTP-01 挑战。测试里的域名
//     得能解析到本机，绕它要么改 /etc/hosts、要么给 pebble 挂自定义 DNS ——
//     两条都依赖 CI 环境，脆。
//
// 自己写一个反而更简单：零依赖、不碰网络、不需要 DNS（挑战验证的目标地址
// 由测试直接指定），跑完不到一秒。
//
// # 它证明什么、不证明什么
//
// 它证明【我们这边的接线是对的】：autocert 配置正确、:80 上的挑战 handler
// 真的能被取到、启动预热真的拿到了证书并落盘、证书真的能用来握手、
// 失败时给出可读诊断。
//
// 它【不】证明我们与 Let's Encrypt 的协议兼容性 —— 那是
// golang.org/x/crypto/acme 的职责，上游有自己的测试。这个服务器只需要
// 「足以驱动那个客户端」，不需要复刻真 CA 的全部严格性。
//
// 所以它【刻意不校验 JWS 签名】：那对上面要证明的东西没有贡献。
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

// Server 是一个跑在 httptest 上的假 ACME CA。
type Server struct {
	ts     *httptest.Server
	caKey  *ecdsa.PrivateKey
	caCert *x509.Certificate

	mu sync.Mutex
	// validateAddr 是验证 HTTP-01 挑战时要连的地址（host:port）。
	// 真 CA 会去解析域名，这里由测试直接指定，绕开 DNS。
	validateAddr string
	orders       map[string]*order
	nextID       int
	// issued 记录签发过的域名。
	issued []string
	// requests 是收到的请求总数。--dev 的断言用它 ——
	// "没签发成功"太弱（可能是发起了但失败），"一次都没来找过 CA"才够强。
	requests int
	// certLifetime 让测试能造出短周期证书。
	certLifetime time.Duration
	// logf 把内部事件（尤其是挑战验证失败的真实原因）交给测试。
	// 没有它的话，ACME 失败在 autocert 里会被压成一句
	// "no viable challenge type found"，查不动。
	logf func(string, ...any)
	// profiles 是目录里 meta.profiles 声明的 profile（ADR-0042：IP 证书要 shortlived）。
	// nil 表示这个 CA 不支持 profile —— 用来测「CA 不签 IP 证书」那条报错。
	profiles map[string]string
	// orders 按到达顺序记下每个订单的标识类型与 profile，测试据此断言请求的形状。
	orderLog []OrderInfo
}

// OrderInfo 是一个订单在客户端那侧【请求了什么】。
type OrderInfo struct {
	Type    string // "dns" 或 "ip"
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

// New 起一个假 CA。调用方负责 Close。
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
		certLifetime: 90 * 24 * time.Hour, // 与 Let's Encrypt 一致
		// 与 Let's Encrypt 一致：classic 是默认，shortlived 是 6 天期（IP 证书只能用它）
		profiles: map[string]string{
			"classic":    "https://example.invalid/classic",
			"shortlived": "https://example.invalid/shortlived",
		},
	}
	s.ts = httptest.NewServer(s.mux())
	return s, nil
}

func (s *Server) Close() { s.ts.Close() }

// SetLogf 接一个日志函数（通常是 t.Logf）。
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

// DirectoryURL 是喂给 acme.Client 的目录地址。
func (s *Server) DirectoryURL() string { return s.ts.URL + "/directory" }

// RootPool 返回信任这个假 CA 的证书池，用来验证 agent 真的能握手。
func (s *Server) RootPool() *x509.CertPool {
	p := x509.NewCertPool()
	p.AddCert(s.caCert)
	return p
}

// ValidateAgainst 指定验证 HTTP-01 挑战时要连的地址。
// 留空则验证必然失败 —— 用来测「挑战打不进来」那条路径。
func (s *Server) ValidateAgainst(addr string) {
	s.mu.Lock()
	s.validateAddr = addr
	s.mu.Unlock()
}

// SetCertLifetime 改签发出来的证书有效期（用来测续期规则随有效期缩放）。
func (s *Server) SetCertLifetime(d time.Duration) {
	s.mu.Lock()
	s.certLifetime = d
	s.mu.Unlock()
}

// SetProfiles 改目录里声明的 profile；nil = 这个 CA 不支持 profile。
func (s *Server) SetProfiles(p map[string]string) {
	s.mu.Lock()
	s.profiles = p
	s.mu.Unlock()
}

// Orders 返回收到的订单（按顺序）。
func (s *Server) Orders() []OrderInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]OrderInfo(nil), s.orderLog...)
}

// Issued 返回签发过的域名 / IP。测试用它断言 --dev 下【根本没发起签发】。
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
	// 每个响应都带 Replay-Nonce，客户端从任何响应里取都能拿到
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

// Requests 返回收到的请求总数。
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
		writeProblem(w, http.StatusBadRequest, "malformed", "订单里没有 identifiers")
		return
	}
	id0 := req.Identifiers[0]

	s.mu.Lock()
	s.orderLog = append(s.orderLog, OrderInfo{Type: id0.Type, Value: id0.Value, Profile: req.Profile})
	if req.Profile != "" && s.profiles[req.Profile] == "" {
		s.mu.Unlock()
		writeProblem(w, http.StatusBadRequest, "invalidProfile", "不认识的 profile "+req.Profile)
		return
	}
	// 和 Let's Encrypt 一样：IP 证书只能是 shortlived
	if id0.Type == "ip" && req.Profile != "shortlived" {
		s.mu.Unlock()
		writeProblem(w, http.StatusBadRequest, "rejectedIdentifier", "IP 标识只能用 shortlived profile")
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
		writeProblem(w, http.StatusNotFound, "malformed", "没有这个 authz")
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

// challenge 收到 POST 之后【同步】做一次验证，省掉客户端轮询的等待。
func (s *Server) challenge(w http.ResponseWriter, r *http.Request) {
	id := lastSegment(r.URL.Path)
	s.mu.Lock()
	o := s.orders[id]
	addr := s.validateAddr
	s.mu.Unlock()
	if o == nil {
		writeProblem(w, http.StatusNotFound, "malformed", "没有这个挑战")
		return
	}

	if err := s.validateHTTP01(addr, o.domain, o.token); err != nil {
		s.log("acmetest: 挑战 %s 验证失败: %v", id, err)
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

// validateHTTP01 去取 .well-known 下的挑战响应。
//
// 【连 addr、但发 Host: domain】—— 真 CA 就是这么干的：先把域名解析成 IP，
// 连过去，Host 头里仍然是域名。这一点不能省：autocert 的挑战 handler 会用
// HostPolicy 校验 Host，发错了会拿到 403。测试因此顺带证明了
// 挑战路径上的 HostPolicy 是生效的。
//
// 只校验响应以 "<token>." 开头 —— 那已经足以证明 autocert 的挑战 handler
// 挂在了正确的路径上并给出了正确的 token。完整的 keyAuthorization 要算
// 账号密钥的 thumbprint，对「我们这边接线对不对」没有额外贡献。
func (s *Server) validateHTTP01(addr, domain, token string) error {
	if addr == "" {
		return fmt.Errorf("Invalid response from http://%s/.well-known/acme-challenge/%s: connection refused", domain, token)
	}
	url := fmt.Sprintf("http://%s/.well-known/acme-challenge/%s", addr, token)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Host = domain // 关键：真 CA 发的是域名，不是 IP
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
		return fmt.Errorf("Invalid response from %s: 挑战响应不是以 token 开头", url)
	}
	return nil
}

func (s *Server) finalize(w http.ResponseWriter, r *http.Request) {
	id := lastSegment(r.URL.Path)
	s.mu.Lock()
	o := s.orders[id]
	s.mu.Unlock()
	if o == nil {
		writeProblem(w, http.StatusNotFound, "malformed", "没有这个订单")
		return
	}
	if o.status != "valid" {
		writeProblem(w, http.StatusForbidden, "orderNotReady", "挑战还没通过")
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
		writeProblem(w, http.StatusBadRequest, "malformed", "finalize 载荷非法")
		return
	}
	der, err := base64.RawURLEncoding.DecodeString(req.CSR)
	if err != nil {
		writeProblem(w, http.StatusBadRequest, "badCSR", "CSR 不是 base64url")
		return
	}
	csr, err := x509.ParseCertificateRequest(der)
	if err != nil {
		writeProblem(w, http.StatusBadRequest, "badCSR", "CSR 解不开")
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
		writeProblem(w, http.StatusNotFound, "malformed", "没有这个订单")
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
		writeProblem(w, http.StatusNotFound, "malformed", "还没有证书")
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

// ---------- 小工具 ----------

// jwsPayload 取出 JWS 的 payload。【刻意不校验签名】，理由见包注释。
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
		return nil, fmt.Errorf("不是合法的 JWS: %w", err)
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

// TLSClientConfig 是一个信任这个假 CA 的 tls.Config，方便测试握手。
func (s *Server) TLSClientConfig(serverName string) *tls.Config {
	return &tls.Config{ServerName: serverName, RootCAs: s.RootPool(), MinVersion: tls.VersionTLS12}
}
