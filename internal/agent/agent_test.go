package agent_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/agent"
	"github.com/sunhaijun/webterm/internal/auth"
	"github.com/sunhaijun/webterm/internal/protocol"
)

// End to end: pair → open WebSocket → create session → type a command → see
// the output. This was the m2 exit criterion, once checked by hand with wscat.
func TestEndToEndPairAndRunCommand(t *testing.T) {
	h := newHarness(t)
	c := h.client()

	resp := h.pair(c)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("pairing returned %d", resp.StatusCode)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab-1", nil, "")

	w := cl.welcome()
	if w.Protocol != protocol.Version {
		t.Fatalf("welcome.protocol = %d", w.Protocol)
	}
	if w.InstanceID == "" {
		t.Fatal("welcome lacks instance_id")
	}
	if w.Limits.MaxFrameBytes != protocol.MaxPayload {
		t.Fatalf("limits.max_frame_bytes = %d", w.Limits.MaxFrameBytes)
	}
	// home: the frontend abbreviates the CWD to ~ with it (protocol §4.2).
	if home, _ := os.UserHomeDir(); w.Home != home || w.Home == "" {
		t.Fatalf("welcome.home = %q, want %q", w.Home, home)
	}

	sid := cl.createSession(t.TempDir())
	cl.input(sid, "printf 'E2E-%s\\n' OK\r")
	waitFor(t, "command output on screen", func() bool {
		return cl.screenHas(sid, "E2E-OK")
	})

	// ping / pong
	cl.send(&protocol.Ping{TS: 12345})
	waitFor(t, "pong received", func() bool {
		for _, m := range cl.messages() {
			if p, ok := m.(*protocol.Pong); ok && p.TS == 12345 {
				return true
			}
		}
		return false
	})
}

// IT-auth-1: the route auth matrix, including /ws.
//
// "The auth middleware must cover the WebSocket upgrade" is the easiest rule
// to miss (AC-1.7).
func TestITAuth1_RouteMatrix(t *testing.T) {
	h := newHarness(t)
	anon := h.client()

	t.Run("routes without auth", func(t *testing.T) {
		for _, p := range []string{"/", "/pair", "/healthz", "/manifest.json"} {
			resp, err := anon.Get(h.srv.URL + p)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Errorf("GET %s = %d, want 200", p, resp.StatusCode)
			}
		}
	})

	t.Run("routes with auth", func(t *testing.T) {
		for _, tc := range []struct{ method, path string }{
			{"GET", "/api/devices"},
			{"GET", "/api/commands"},
			{"GET", "/api/settings"},
			{"GET", "/api/fs?cwd=/"},
			{"GET", "/api/anything-else"},
			{"POST", "/api/devices/revoke-all"},
			{"POST", "/auth/logout"},
			{"DELETE", "/api/commands?pinned=false"},
		} {
			resp := h.do(anon, tc.method, tc.path, nil)
			resp.Body.Close()
			if resp.StatusCode != http.StatusUnauthorized {
				t.Errorf("%s %s = %d, want 401", tc.method, tc.path, resp.StatusCode)
			}
		}
	})

	t.Run("WebSocket upgrade requires auth too", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, resp, err := h.dial(ctx, anon, h.srv.URL)
		if err == nil {
			t.Fatal("connected without auth")
		}
		if resp == nil || resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("WS upgrade = %v, want 401", resp)
		}
	})

	t.Run("removed endpoints: 404 after auth, not the SPA page", func(t *testing.T) {
		// /api/commands*, /api/fs and /api/settings went away with command
		// history (ADR-0026 §6). Without the catch-all they would fall into
		// the SPA fallback on GET / and return 200 + index.html.
		c := h.client()
		h.pair(c).Body.Close()
		for _, p := range []string{"/api/commands", "/api/settings", "/api/fs?cwd=/"} {
			resp := h.do(c, http.MethodGet, p, nil)
			resp.Body.Close()
			if resp.StatusCode != http.StatusNotFound {
				t.Errorf("GET %s = %d, want 404", p, resp.StatusCode)
			}
		}
	})

	t.Run("connects after pairing", func(t *testing.T) {
		c := h.client()
		h.pair(c).Body.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		ws, _, err := h.dial(ctx, c, h.srv.URL)
		if err != nil {
			t.Fatalf("authenticated but cannot connect: %v", err)
		}
		ws.CloseNow()
	})
}

// IT-auth-2: WebSocket Origin check (AC-1.8 / threat model T4).
func TestITAuth2_OriginCheck(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	t.Run("forged Origin is rejected", func(t *testing.T) {
		_, resp, err := h.dial(ctx, c, "https://evil.example.com")
		if err == nil {
			t.Fatal("cross-site Origin connected")
		}
		if resp == nil || resp.StatusCode != http.StatusForbidden {
			t.Fatalf("status = %v, want 403", resp)
		}
	})

	t.Run("local Origin allowed under --dev", func(t *testing.T) {
		ws, _, err := h.dial(ctx, c, h.srv.URL)
		if err != nil {
			t.Fatalf("local Origin rejected: %v", err)
		}
		ws.CloseNow()
	})

	// State-changing /api requests get the same check (ADR-0047 §3): the
	// SameSite cookie is the first line, this the second.
	t.Run("cross-origin /api mutations are refused", func(t *testing.T) {
		send := func(method, path, origin string) int {
			req, _ := http.NewRequest(method, h.srv.URL+path, nil)
			req.Header.Set("Origin", origin)
			resp, err := c.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			return resp.StatusCode
		}
		if got := send(http.MethodPost, "/api/devices/revoke-all", "https://evil.example.com"); got != http.StatusForbidden {
			t.Fatalf("cross-origin revoke-all: status %d, want 403", got)
		}
		if got := send(http.MethodDelete, "/api/devices/no-such-device", h.srv.URL); got == http.StatusForbidden {
			t.Fatal("same-origin request refused")
		}
		if resp := h.do(c, http.MethodGet, "/api/devices", nil); resp.StatusCode != http.StatusOK {
			t.Fatalf("device lost after a refused request: %d", resp.StatusCode)
		}
	})
}

// IT-auth-3: cookie attributes (AC-1.9).
func TestITAuth3_CookieAttributes(t *testing.T) {
	h := newHarness(t)
	resp := h.pair(h.client())
	defer resp.Body.Close()

	var got *http.Cookie
	for _, ck := range resp.Cookies() {
		if ck.Name == auth.CookieName {
			got = ck
		}
	}
	if got == nil {
		t.Fatal("pairing succeeded but set no session cookie")
	}
	if !got.HttpOnly {
		t.Error("cookie must be HttpOnly, or XSS can steal it")
	}
	if got.SameSite != http.SameSiteStrictMode {
		t.Error("cookie must be SameSite=Strict; it is the main CSRF defense")
	}
	if got.Path != "/" {
		t.Errorf("Path = %q, want /", got.Path)
	}
	if got.MaxAge < 300*24*3600 {
		t.Errorf("MaxAge = %d is too short (want about a year)", got.MaxAge)
	}
	// --dev may omit Secure (localhost is plain HTTP but still a secure
	// context).
	if got.Secure {
		t.Error("--dev must not set Secure, or http://localhost won't get the cookie")
	}
}

// AC-1.10: the store holds token hashes, not plaintext.
func TestTokenStoredAsHashOnly(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	resp := h.pair(c)
	resp.Body.Close()

	var token string
	for _, ck := range resp.Cookies() {
		if ck.Name == auth.CookieName {
			token = ck.Value
		}
	}
	if token == "" {
		t.Fatal("no token received")
	}
	// The plaintext token must not appear anywhere in the data dir.
	assertNotInDataDir(t, h.dataDir, token)
}

// IT-auth-4: revocation takes effect immediately; an open WebSocket is closed
// within 5 seconds (AC-1.11).
//
// Checking only at handshake isn't enough: a WebSocket can stay open for days.
func TestITAuth4_RevocationClosesLiveWebSocket(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab-1", nil, "")
	cl.welcome()

	devs, err := h.store.ListDevices()
	if err != nil || len(devs) != 1 {
		t.Fatalf("unexpected device list: %v %d", err, len(devs))
	}
	start := time.Now()
	if err := h.store.RevokeDevice(devs[0].ID, time.Now()); err != nil {
		t.Fatal(err)
	}

	waitFor(t, "connection closed", func() bool { return cl.isClosed() })
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("closed %v after revocation; AC-1.11 requires 5 seconds", d)
	}
	// Tell the user why before disconnecting.
	var told bool
	for _, m := range cl.messages() {
		if n, ok := m.(*protocol.Notice); ok && strings.Contains(n.Message, "revoked") {
			told = true
		}
	}
	for _, e := range cl.errors() {
		if e.Code == protocol.CodeUnauthorized {
			told = true
		}
	}
	if !told {
		t.Error("no reason given before disconnecting; the user only sees an unexplained reconnect failure")
	}

	// Opened again later, the revoked cookie gets code "revoked", not the
	// plain "pairing required", so the page can say why (AC-1.11).
	code := func(c *http.Client) string {
		resp := h.do(c, http.MethodGet, "/api/devices", nil)
		defer resp.Body.Close()
		var body struct{ Code string }
		_ = json.NewDecoder(resp.Body).Decode(&body)
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("status %d, want 401", resp.StatusCode)
		}
		return body.Code
	}
	if got := code(c); got != "revoked" {
		t.Errorf("revoked cookie: code %q, want revoked", got)
	}
	if got := code(h.client()); got != "unauthorized" {
		t.Errorf("no cookie: code %q, want unauthorized", got)
	}
}

// IT-auth-5: signing out this device (AC-1.22, ADR-0048). The server revokes
// it, so even a copy of the token stops working, and the response clears what
// the browser holds.
func TestITAuth5_SignOut(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	resp := h.pair(c)
	resp.Body.Close()
	var token string
	for _, ck := range resp.Cookies() {
		if ck.Name == auth.CookieName {
			token = ck.Value
		}
	}
	if token == "" {
		t.Fatal("no token received")
	}
	// withToken sends a request carrying the old token, as a copied cookie would.
	withToken := func(method, path, origin string) int {
		req, _ := http.NewRequest(method, h.srv.URL+path, nil)
		req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}

	if got := withToken(http.MethodPost, "/auth/logout", "https://evil.example.com"); got != http.StatusForbidden {
		t.Fatalf("cross-origin sign-out: status %d, want 403", got)
	}
	if got := withToken(http.MethodGet, "/api/devices", ""); got != http.StatusOK {
		t.Fatalf("device lost after a refused sign-out: %d", got)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	other := h.connect(ctx, h.reuse(c), "tab-2", nil, "") // another tab of this device
	other.welcome()

	req, _ := http.NewRequest(http.MethodPost, h.srv.URL+"/auth/logout", nil)
	req.Header.Set("Origin", h.srv.URL)
	start := time.Now()
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("sign-out: status %d, want 204", resp.StatusCode)
	}
	cleared := false
	for _, ck := range resp.Cookies() {
		if ck.Name == auth.CookieName && ck.MaxAge < 0 {
			cleared = true
		}
	}
	if !cleared {
		t.Error("the response doesn't clear the cookie")
	}
	if got := resp.Header.Get("Clear-Site-Data"); !strings.Contains(got, `"cookies"`) || !strings.Contains(got, `"storage"`) || !strings.Contains(got, `"cache"`) {
		t.Errorf("Clear-Site-Data = %q, want cookies, storage and cache", got)
	}

	if got := withToken(http.MethodGet, "/api/devices", ""); got != http.StatusUnauthorized {
		t.Errorf("old token on /api/devices: %d, want 401", got)
	}
	jar := h.client()
	u, _ := url.Parse(h.srv.URL)
	jar.Jar.SetCookies(u, []*http.Cookie{{Name: auth.CookieName, Value: token}})
	if _, resp, err := h.dial(ctx, jar, h.srv.URL); err == nil || resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("old token on /ws: err=%v resp=%v, want 401", err, resp)
	}
	waitFor(t, "the device's other tab is cut off", func() bool { return other.isClosed() })
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("other tab closed %v after sign-out; AC-1.11 allows 5 seconds", d)
	}
}

// IT-pair-1: pairing codes are single-use and expire (AC-1.4).
func TestITPair1_CodeIsSingleUse(t *testing.T) {
	h := newHarness(t)
	code, err := h.agent.Auth().NewPairingCode(time.Now())
	if err != nil {
		t.Fatal(err)
	}

	resp := h.postJSON(h.client(), "/auth/pair", map[string]string{"code": code})
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("first pairing = %d, want 200", resp.StatusCode)
	}

	resp2 := h.postJSON(h.client(), "/auth/pair", map[string]string{"code": code})
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusUnauthorized {
		t.Fatalf("same code again = %d, want 401 (single use)", resp2.StatusCode)
	}

	// Rate limiting is per IP and every test request comes from 127.0.0.1,
	// so each subtest below gets a fresh harness; otherwise the attempts
	// above would push it into 429.
	t.Run("expired code is rejected", func(t *testing.T) {
		h := newHarness(t)
		old, err := h.agent.Auth().NewPairingCode(time.Now().Add(-2 * auth.PairingTTL))
		if err != nil {
			t.Fatal(err)
		}
		resp := h.postJSON(h.client(), "/auth/pair", map[string]string{"code": old})
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("expired code = %d, want 401", resp.StatusCode)
		}
	})

	t.Run("guessed code is rejected", func(t *testing.T) {
		h := newHarness(t)
		resp := h.postJSON(h.client(), "/auth/pair", map[string]string{"code": "not-a-real-code"})
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("wrong code = %d, want 401", resp.StatusCode)
		}
	})
}

// IT-pair-2: pairing codes never reach the log or the store (AC-1.5 /
// AC-8.5).
func TestITPair2_CodeNeverLogged(t *testing.T) {
	h := newHarness(t)
	code, err := h.agent.Auth().NewPairingCode(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	// One success and one failure: check both paths.
	h.postJSON(h.client(), "/auth/pair", map[string]string{"code": code}).Body.Close()
	h.postJSON(h.client(), "/auth/pair", map[string]string{"code": code}).Body.Close()

	if strings.Contains(h.logs.String(), code) {
		t.Fatal("pairing code appears in the log")
	}
	assertNotInDataDir(t, h.dataDir, code)
}

// IT-pair-4: typed digits use the same endpoint, the server strips
// separators, and using them invalidates the QR code key too (ADR-0017).
func TestITPair4_DigitsCodeOverHTTP(t *testing.T) {
	h := newHarness(t)
	codes, err := h.agent.Auth().NewPairingCodes(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	spaced := strings.ReplaceAll(auth.FormatDigits(codes.Digits), "-", " ")
	resp := h.postJSON(h.client(), "/auth/pair", map[string]string{"code": spaced})
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("pairing with space-separated digits = %d, want 200", resp.StatusCode)
	}
	resp2 := h.postJSON(h.client(), "/auth/pair", map[string]string{"code": codes.URL})
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusUnauthorized {
		t.Fatalf("URL code after digits were used = %d, want 401 (both keys expire together)", resp2.StatusCode)
	}
	// Like the URL code, the digits never reach the log or the store (AC-8.5).
	if strings.Contains(h.logs.String(), codes.Digits) {
		t.Fatal("numeric code appears in the log")
	}
	assertNotInDataDir(t, h.dataDir, codes.Digits)
}

// IT-pair-3: rate limiting (AC-1.6).
func TestITPair3_RateLimited(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	var got429 bool
	for i := range 8 {
		resp := h.postJSON(c, "/auth/pair", map[string]string{"code": "wrong-code"})
		code := resp.StatusCode
		retryAfter := resp.Header.Get("Retry-After")
		resp.Body.Close()
		if code == http.StatusTooManyRequests {
			got429 = true
			if retryAfter == "" {
				t.Error("429 must include Retry-After")
			}
			break
		}
		if i >= 7 {
			t.Fatalf("8 attempts in a row were not rate limited")
		}
	}
	if !got429 {
		t.Fatal("rate limit not triggered")
	}
}

// IT-privacy-1: terminal output never touches disk (AC-8.4 / invariant 3).
func TestITPrivacy1_TerminalOutputNeverPersisted(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab-1", nil, "")
	cl.welcome()
	sid := cl.createSession(t.TempDir())

	const canary = "WEBTERM_CANARY_9f3a2b"
	// Build it with printf so the canary appears only in the output, not in
	// the command text. This tests output; command text is covered by
	// IT-privacy-3.
	cl.input(sid, "printf 'WEBTERM_CANARY_%s\\n' 9f3a2b\r")
	waitFor(t, "canary on screen", func() bool {
		return cl.screenHas(sid, canary)
	})
	// Give any writes to the store a moment.
	time.Sleep(300 * time.Millisecond)

	assertNotInDataDir(t, h.dataDir, canary)
	if strings.Contains(h.logs.String(), canary) {
		t.Fatal("terminal output appears in the log")
	}
}

// IT-privacy-3: command text never touches disk either (command history was
// removed, ADR-0026 §6).
func TestITPrivacy3_CommandTextNeverPersisted(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab-1", nil, "")
	cl.welcome()
	sid := cl.createSession(t.TempDir())

	const secret = "SECRET_TYPED_COMMAND_7e1d"
	cl.input(sid, "echo "+secret+"\r")
	waitFor(t, "command executed", func() bool { return strings.Count(cl.screenOf(sid), secret) >= 2 })
	time.Sleep(300 * time.Millisecond)
	assertNotInDataDir(t, h.dataDir, secret)
}

// IT-privacy-2: command text never reaches the log (AC-8.5).
func TestITPrivacy2_CommandTextNeverLogged(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab-1", nil, "")
	cl.welcome()
	sid := cl.createSession(t.TempDir())

	const secret = "SUPER_SECRET_COMMAND_TEXT"
	cl.input(sid, "echo "+secret+"\r")
	waitFor(t, "command executed", func() bool {
		return cl.screenHas(sid, secret)
	})
	time.Sleep(200 * time.Millisecond)

	if strings.Contains(h.logs.String(), secret) {
		t.Fatal("command text appears in the log")
	}
}

// IT-sub-1: an unsubscribed session keeps buffering, and subscribe{out_seq}
// catches up.
func TestITSub1_UnsubscribedSessionKeepsBuffering(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab-1", nil, "")
	cl.welcome()
	sid := cl.createSession(t.TempDir())

	cl.input(sid, "printf 'BEFORE-%s\\n' MARK\r")
	waitFor(t, "first output", func() bool { return cl.screenHas(sid, "BEFORE-MARK") })

	cl.send(&protocol.Unsubscribe{SID: sid})
	time.Sleep(200 * time.Millisecond)
	before := len(cl.screenOf(sid))

	cl.input(sid, "printf 'AFTER-%s\\n' MARK\r")
	// No bytes should cross the wire while unsubscribed.
	time.Sleep(500 * time.Millisecond)
	if cl.screenHas(sid, "AFTER-MARK") {
		t.Fatal("unsubscribed session still pushes output; the mobile bandwidth saving is broken")
	}
	// But the agent keeps buffering, so switching back catches up.
	cl.mu.Lock()
	at := cl.outSeq[sid]
	cl.mu.Unlock()
	cl.send(&protocol.Subscribe{SID: sid, OutSeq: at})
	waitFor(t, "switching back catches up on the missed output", func() bool {
		return cl.screenHas(sid, "AFTER-MARK")
	})
	if len(cl.screenOf(sid)) <= before {
		t.Fatal("catch-up brought no new content")
	}
}

// IT-sub-2: when the backlog on switching back exceeds ring_bytes, the agent
// sends a snapshot (SNAPSHOT frames) and the client clears and rebuilds the
// screen instead of appending discontinuous content to the old one (AC-2.6).
//
// This covers the subscribe path. The reconnect half
// (welcome.resumed[].status) is TestResumeSnapshotOverRealSocket; they are
// different code paths.
func TestITSub2_SubscribeOverflowSendsSnapshot(t *testing.T) {
	const ring = 16 << 10
	h := newHarnessWith(t, harnessOpts{ringBytes: ring})
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab-1", nil, "")
	cl.welcome()
	sid := cl.createSession(t.TempDir())

	cl.input(sid, "printf 'BEFORE-%s\\n' MARK\r")
	waitFor(t, "marker shown before switching away", func() bool { return cl.screenHas(sid, "BEFORE-MARK") })

	cl.send(&protocol.Unsubscribe{SID: sid})
	time.Sleep(200 * time.Millisecond)
	cl.mu.Lock()
	at := cl.outSeq[sid]
	cl.mu.Unlock()
	before := cl.snapshotCount(sid)

	// While away, produce far more than ring_bytes, pushing BEFORE-MARK out of
	// the window.
	cl.input(sid, "for i in $(seq 1 600); do printf 'pad %04d %s\\n' $i "+strings.Repeat("x", 60)+"; done; printf 'PAD-%s\\n' DONE\r")
	waitFor(t, "backlog overruns the window", func() bool { return cl.headSeqOf(sid) > at+ring+2048 })
	s, _ := h.sessions.Get(sid)
	waitFor(t, "output stops", func() bool {
		h1 := s.HeadSeq()
		time.Sleep(300 * time.Millisecond)
		return s.HeadSeq() == h1
	})

	cl.send(&protocol.Subscribe{SID: sid, OutSeq: at})
	waitFor(t, "snapshot received", func() bool { return cl.snapshotCount(sid) == before+1 })

	screen := cl.screenOf(sid)
	if strings.Contains(screen, "BEFORE-MARK") && !strings.Contains(screen, "PAD-DONE") {
		t.Fatal("snapshot did not clear and rebuild; content was appended to the old screen")
	}
	if !strings.Contains(screen, "PAD-DONE") {
		t.Fatal("snapshot lacks the current screen")
	}
	cl.mu.Lock()
	got := cl.outSeq[sid]
	cl.mu.Unlock()
	if got != s.HeadSeq() {
		t.Fatalf("out_seq after snapshot = %d, want head %d", got, s.HeadSeq())
	}

	// Live output after the rebuild is still correct.
	cl.input(sid, "printf 'AFTER-%s\\n' MARK\r")
	waitFor(t, "new output after rebuild", func() bool { return cl.screenHas(sid, "AFTER-MARK") })
	if errs := cl.seqErrors(); len(errs) != 0 {
		t.Fatalf("seq discontinuity: %v", errs)
	}
}

// IT-unread-1: a head_seq held back by throttling must be sent later
// (AC-4.3).
//
// Output from an unsubscribed session often comes in bursts that end within a
// second, with nothing afterwards to trigger another notification. Throttling
// without a trailing flush would leave the client's head_seq before the
// burst forever: the unread dot never lights and the user never learns the
// background session did anything.
func TestHeadSeqThrottleFlushesLastValue(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab-1", nil, "")
	cl.welcome()
	sid := cl.createSession(t.TempDir())
	cl.input(sid, "printf 'READY-%s\\n' MARK\r")
	waitFor(t, "session ready", func() bool { return cl.screenHas(sid, "READY-MARK") })

	cl.send(&protocol.Unsubscribe{SID: sid})
	time.Sleep(1200 * time.Millisecond) // let the throttle window expire so the next one passes

	// First burst: passes and sets lastHead to now.
	cl.input(sid, "printf 'A%.0s' $(seq 1 500); printf '\\n'\r")
	waitFor(t, "head_seq of the first burst arrives", func() bool { return cl.headSeqOf(sid) > 0 })
	h1 := cl.headSeqOf(sid)

	// Second burst: inside the throttle window, so it is held back and only
	// the trailing flush can deliver it.
	cl.input(sid, "printf 'B%.0s' $(seq 1 500); printf '\\n'\r")
	time.Sleep(2 * time.Second) // output stopped long ago; nothing else will trigger

	if got := cl.headSeqOf(sid); got < h1+500 {
		t.Fatalf("head_seq stuck at %d (was %d after the first burst): the throttled value was never flushed, so unread is missed", got, h1)
	}
}

// Reconnecting outside the window: welcome.resumed[].status = snapshot,
// from_seq = the snapshot's seq, and welcome precedes the SNAPSHOT frames
// (protocol §5.3 ⑥⑧).
func TestResumeSnapshotOverRealSocket(t *testing.T) {
	const ring = 16 << 10
	h := newHarnessWith(t, harnessOpts{ringBytes: ring})
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab-1", nil, "")
	first := cl.welcome()
	sid := cl.createSession(t.TempDir())
	cl.input(sid, "printf 'BEFORE-%s\\n' MARK\r")
	waitFor(t, "marker shown", func() bool { return cl.screenHas(sid, "BEFORE-MARK") })

	cl.mu.Lock()
	at := cl.outSeq[sid]
	cl.mu.Unlock()
	cl.ws.CloseNow()
	waitFor(t, "old connection gone", func() bool { return cl.isClosed() })

	// While disconnected, output (typed from another tab) overruns the window.
	s, _ := h.sessions.Get(sid)
	if err := s.Write("tab-other", 0, []byte("for i in $(seq 1 600); do printf 'pad %04d %s\\n' $i "+strings.Repeat("x", 60)+"; done\r")); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "buffer overwritten", func() bool { return s.Info().BaseSeq > at })

	again := h.connect(ctx, c, "tab-1", []protocol.ResumeReq{{SID: sid, OutSeq: at}}, first.InstanceID)
	w := again.welcome()
	if len(w.Resumed) != 1 || w.Resumed[0].Status != protocol.ResumeSnapshot {
		t.Fatalf("resumed = %+v, want status snapshot", w.Resumed)
	}
	waitFor(t, "snapshot received", func() bool { return again.snapshotCount(sid) == 1 })
	frames := again.binaryFrames()
	if frames[0].Type != protocol.TypeSnapshot || frames[0].Seq != w.Resumed[0].FromSeq {
		t.Fatalf("first frame = %+v, want SNAPSHOT seq=%d (= from_seq)", frames[0], w.Resumed[0].FromSeq)
	}
	if order := again.arrival(); order[0] != protocol.TWelcome {
		t.Fatalf("first message to arrive was %q; welcome must come first", order[0])
	}
}

// IT-hb-1: a connection silent for 60 seconds is closed (AC-2.8). The idle
// timeout is injectable so the test doesn't wait a minute.
func TestITHb1_IdleConnectionClosed(t *testing.T) {
	h := newHarness(t, func(c *agent.Config) { c.WSIdleTimeout = 700 * time.Millisecond })
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab-1", nil, "")
	cl.welcome()

	waitFor(t, "idle connection closed", func() bool { return cl.isClosed() })
}

// Heartbeats keep a connection alive: one that keeps pinging must not be
// timed out.
func TestHeartbeatKeepsConnectionAlive(t *testing.T) {
	h := newHarness(t, func(c *agent.Config) { c.WSIdleTimeout = 700 * time.Millisecond })
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab-1", nil, "")
	cl.welcome()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		cl.send(&protocol.Ping{TS: time.Now().UnixMilli()})
		time.Sleep(200 * time.Millisecond)
		if cl.isClosed() {
			t.Fatal("connection that kept pinging was timed out")
		}
	}
}

// Closing a session doesn't block the connection's read loop. A shell that
// ignores SIGHUP takes the 2-second grace period to close, and meanwhile pings
// and input to other sessions on the same connection keep flowing.
func TestSlowCloseDoesNotStallConnection(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab-1", nil, "")
	cl.welcome()
	dir := t.TempDir()
	slow, other := cl.createSession(dir), cl.createSession(dir)
	cl.input(slow, "trap '' HUP; echo HUP-$((1+1))\r")
	waitFor(t, "slow shell ignores SIGHUP", func() bool { return cl.screenHas(slow, "HUP-2") })

	start := time.Now()
	cl.send(&protocol.SessionClose{ReqID: "cl", SID: slow})
	cl.send(&protocol.Ping{TS: 4242})
	cl.input(other, "echo OTHER-$((40+2))\r")
	waitFor(t, "pong and output from the other session", func() bool {
		if !cl.screenHas(other, "OTHER-42") {
			return false
		}
		for _, m := range cl.messages() {
			if p, ok := m.(*protocol.Pong); ok && p.TS == 4242 {
				return true
			}
		}
		return false
	})
	if d := time.Since(start); d > time.Second {
		t.Fatalf("connection stalled %v while closing a session", d)
	}
	waitFor(t, "session.closed", func() bool {
		for _, m := range cl.messages() {
			if v, ok := m.(*protocol.SessionClosed); ok && v.ReqID == "cl" {
				return true
			}
		}
		return false
	})
	if d := time.Since(start); d < 1500*time.Millisecond {
		t.Fatalf("close took only %v; the premise failed, the shell did not hold out for the grace period", d)
	}
}

// Unknown control messages are ignored, not fatal (protocol §4, forward
// compatibility).
func TestUnknownControlMessageIgnored(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab-1", nil, "")
	cl.welcome()

	raw, _ := json.Marshal(map[string]any{"t": "session.split", "sid": 1})
	if err := cl.ws.Write(ctx, 1 /* text */, raw); err != nil {
		t.Fatal(err)
	}
	// The connection stays up and later messages still work.
	cl.send(&protocol.Ping{TS: 999})
	waitFor(t, "ping still works after an unknown message", func() bool {
		for _, m := range cl.messages() {
			if p, ok := m.(*protocol.Pong); ok && p.TS == 999 {
				return true
			}
		}
		return false
	})
	if cl.isClosed() {
		t.Fatal("unknown t value closed the connection; forward compatibility is broken")
	}
}

// A protocol version mismatch gets a readable error message, not a bare
// handshake failure.
//
// That is exactly why versions are not negotiated via subprotocols
// (protocol §1).
func TestProtocolVersionMismatch(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cl := h.connectRaw(ctx, c, "tab-1")
	cl.send(&protocol.Hello{Protocol: 999, ClientID: "tab-1"})

	waitFor(t, "protocol_unsupported received", func() bool {
		for _, e := range cl.errors() {
			if e.Code == protocol.CodeProtocolUnsupported {
				if !strings.Contains(e.Message, "999") {
					t.Errorf("error message doesn't state both versions: %q", e.Message)
				}
				return true
			}
		}
		return false
	})
	waitFor(t, "connection closed afterwards", func() bool { return cl.isClosed() })
}

// A first message other than hello → expected_hello and close (protocol §4.1).
func TestFirstMessageMustBeHello(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cl := h.connectRaw(ctx, c, "tab-1")
	cl.send(&protocol.Ping{TS: 1}) // not hello

	waitFor(t, "expected_hello received", func() bool {
		for _, e := range cl.errors() {
			if e.Code == protocol.CodeExpectedHello {
				return true
			}
		}
		return false
	})
	waitFor(t, "connection closed afterwards", func() bool { return cl.isClosed() })
}

// assertNotInDataDir greps the whole data dir and asserts needle is absent.
func assertNotInDataDir(t *testing.T, dir, needle string) {
	t.Helper()
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		if strings.Contains(string(b), needle) {
			t.Errorf("%q found in %s", needle, path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// IT-queue-2: a full connection write queue closes that connection instead of
// blocking the Session (protocol §5.5).
//
// Blocking would push back into PTY.Read(), letting one slow client slow down
// the real work running on the server.
func TestITQueue2_SlowClientDisconnectedNotBlocking(t *testing.T) {
	h := newHarness(t, func(c *agent.Config) {
		c.WSWriteQueueMax = 32 << 10 // small, so slow-client protection is testable
	})
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab-1", nil, "")
	cl.welcome()
	flooding := cl.createSession(t.TempDir())
	other := cl.createSession(t.TempDir())

	// Stop reading, then flood output to overflow the write queue. It must be
	// far more than the kernel socket buffers (a few hundred KB), or the
	// kernel absorbs it and the application queue never grows.
	cl.stopReading()
	cl.input(flooding, "tr '\\0' 'x' < /dev/zero | head -c 16000000\r")

	// Check from the server side: the client isn't reading, so it can't
	// observe the close.
	waitFor(t, "server drops the slow client", func() bool { return h.agent.Hub().Count() == 0 })

	// The key assertion: a slow client must not slow down the real work. The
	// other session must respond right away, not after the 16 MB drain.
	cl2 := h.connect(ctx, h.reuse(c), "tab-2", nil, "")
	cl2.welcome()
	cl2.send(&protocol.Subscribe{SID: other, OutSeq: 0})
	cl2.input(other, "printf 'ALIVE-%s\\n' OK\r")

	start := time.Now()
	waitFor(t, "other session still usable", func() bool {
		return cl2.screenHas(other, "ALIVE-OK")
	})
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("other session took %v to respond; the slow client dragged it down", d)
	}
}

// Resume over a real socket: after reconnecting, output catches up
// incrementally from out_seq and input is resent from in_ack.
func TestResumeOverRealSocket(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab-1", nil, "")
	w := cl.welcome()
	sid := cl.createSession(t.TempDir())

	cl.input(sid, "printf 'BEFORE-%s\\n' MARK\r")
	waitFor(t, "first output", func() bool { return cl.screenHas(sid, "BEFORE-MARK") })

	// Start a loop that keeps producing output, so "the session doesn't pause
	// while disconnected" is actually tested.
	cl.input(sid, "for i in $(seq 1 400); do printf 'tick %03d\\n' $i; sleep 0.01; done\r")
	waitFor(t, "loop starts producing", func() bool { return cl.screenHas(sid, "tick 001") })

	cl.mu.Lock()
	at := cl.outSeq[sid]
	sentBefore := cl.inSeq[sid]
	cl.mu.Unlock()

	// Hard-drop the connection (simulating a network outage).
	cl.ws.CloseNow()
	waitFor(t, "old connection gone", func() bool { return cl.isClosed() })

	// While disconnected the PTY keeps running and the ring buffer keeps
	// filling (AC-2.2).
	waitFor(t, "session keeps advancing while disconnected", func() bool {
		s, ok := h.sessions.Get(sid)
		return ok && s.HeadSeq() > at
	})

	// Reconnect with the same client_id.
	cl2 := h.connect(ctx, c, "tab-1", []protocol.ResumeReq{{SID: sid, OutSeq: at}}, w.InstanceID)
	w2 := cl2.welcome()
	if len(w2.Resumed) != 1 {
		t.Fatalf("resumed = %+v", w2.Resumed)
	}
	r := w2.Resumed[0]
	if r.Status != protocol.ResumeOK {
		t.Fatalf("status = %q, want ok", r.Status)
	}
	if r.InAck != sentBefore {
		t.Fatalf("in_ack = %d, want %d; input accounting was lost across the reconnect", r.InAck, sentBefore)
	}

	// The client trims to in_ack and continues; no input_gap expected.
	cl2.mu.Lock()
	cl2.inSeq[sid] = r.InAck
	cl2.mu.Unlock()
	cl2.input(sid, "printf 'AFTER-%s\\n' MARK\r")
	waitFor(t, "input works after reconnect", func() bool {
		return cl2.screenHas(sid, "AFTER-MARK")
	})
	for _, e := range cl2.errors() {
		if e.Code == protocol.CodeInputGap {
			t.Fatal("input_gap after reconnect")
		}
	}
}

// Resume catch-up larger than the write queue still gets the client back in
// (ADR-0047 §2). The catch-up for hello is bounded by the sessions the client
// resumes and is exempt from the queue limit; counting it closed the
// connection before welcome, and every reconnect after that did the same.
func TestResumeCatchUpLargerThanWriteQueue(t *testing.T) {
	h := newHarness(t, func(c *agent.Config) { c.WSWriteQueueMax = 64 << 10 })
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab-1", nil, "")
	w := cl.welcome()
	a, b := cl.createSession(t.TempDir()), cl.createSession(t.TempDir())
	cl.mu.Lock()
	atA, atB := cl.outSeq[a], cl.outSeq[b]
	cl.mu.Unlock()

	// Drop the connection, then let both sessions produce 60 KB each.
	cl.ws.CloseNow()
	waitFor(t, "old connection gone", func() bool { return h.agent.Hub().Count() == 0 })
	for _, sid := range []uint16{a, b} {
		s, _ := h.sessions.Get(sid)
		if err := s.Write("tab-1", 0, []byte("head -c 60000 /dev/zero | tr '\\0' x; echo; echo DONE-$((6*7))\r")); err != nil {
			t.Fatal(err)
		}
	}
	waitFor(t, "output produced", func() bool {
		sa, _ := h.sessions.Get(a)
		sb, _ := h.sessions.Get(b)
		return sa.HeadSeq() > atA+60000 && sb.HeadSeq() > atB+60000
	})

	cl2 := h.connect(ctx, c, "tab-1", []protocol.ResumeReq{{SID: a, OutSeq: atA}, {SID: b, OutSeq: atB}}, w.InstanceID)
	w2 := cl2.welcome()
	for _, r := range w2.Resumed {
		if r.Status != protocol.ResumeOK {
			t.Fatalf("resumed = %+v, want ok for both", w2.Resumed)
		}
	}
	waitFor(t, "both sessions caught up", func() bool { return cl2.screenHas(a, "DONE-42") && cl2.screenHas(b, "DONE-42") })
}

// A page holds one socket at a time: a second connection with the same
// client_id means the page gave up on the first, so the agent closes it
// instead of feeding it until the idle timeout (ADR-0047 §2).
func TestNewConnectionSupersedesOldOne(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	old := h.connect(ctx, c, "tab-1", nil, "")
	w := old.welcome()
	sid := old.createSession(t.TempDir())
	other := h.connect(ctx, h.reuse(c), "tab-2", nil, "")
	other.welcome()

	cur := h.connect(ctx, h.reuse(c), "tab-1", []protocol.ResumeReq{{SID: sid}}, w.InstanceID)
	cur.welcome()
	waitFor(t, "abandoned connection closed", func() bool { return old.isClosed() })
	if other.isClosed() {
		t.Fatal("a connection of another page was closed")
	}
	cur.mu.Lock()
	cur.inSeq[sid] = old.inSeqOf(sid)
	cur.mu.Unlock()
	cur.input(sid, "printf 'NEW-%s\\n' OK\r")
	waitFor(t, "input over the new connection", func() bool { return cur.screenHas(sid, "NEW-OK") })
}

// Multiple tabs: a session created in A is visible in B (broadcast rule,
// protocol §4.2).
func TestSessionEventsBroadcastToAllTabs(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	tabA := h.connect(ctx, c, "tab-a", nil, "")
	tabA.welcome()
	tabB := h.connect(ctx, c, "tab-b", nil, "")
	tabB.welcome()

	sid := tabA.createSession(t.TempDir())

	waitFor(t, "B also receives session.created", func() bool {
		for _, m := range tabB.messages() {
			if v, ok := m.(*protocol.SessionCreated); ok && v.Session.SID == sid {
				// Only the originator's copy carries req_id.
				if v.ReqID != "" {
					t.Errorf("copy broadcast to other tabs must not carry req_id, got %q", v.ReqID)
				}
				return true
			}
		}
		return false
	})

	// B isn't subscribed but must be able to derive unread from head_seq.
	tabA.input(sid, "printf 'FOR-%s\\n' A\r")
	waitFor(t, "B receives head_seq updates (basis for unread)", func() bool {
		for _, m := range tabB.messages() {
			if u, ok := m.(*protocol.SessionUpdated); ok && u.SID == sid && u.HeadSeq != nil {
				return true
			}
		}
		return false
	})
	if tabB.screenHas(sid, "FOR-A") {
		t.Fatal("B received output bytes without subscribing")
	}
}

// Hitting the session limit returns session_limit instead of silently doing
// nothing (US-7.3 / AC-4.2).
func TestSessionLimitReported(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab-1", nil, "")
	cl.welcome()

	dir := t.TempDir()
	for range 5 { // MaxSessions = 5 in the harness
		cl.createSession(dir)
	}
	cwd := dir
	cl.send(&protocol.SessionCreate{ReqID: "over", CWD: &cwd, Cols: 80, Rows: 24})
	waitFor(t, "session_limit received", func() bool {
		for _, e := range cl.errors() {
			if e.Code == protocol.CodeSessionLimit && e.ReqID == "over" {
				return true
			}
		}
		return false
	})
	if cl.isClosed() {
		t.Fatal("session limit must not close the connection")
	}
}

// A snapshot larger than one frame (256 KiB) is split: all parts share the
// seq, all but the last carry MORE, and no other frame for the same sid lands
// between them (protocol §3).
func TestSnapshotSplitIntoFrames(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	cl := h.connect(ctx, c, "tab-1", nil, "")
	w := cl.welcome()
	cwd := t.TempDir()
	cl.send(&protocol.SessionCreate{ReqID: "wide", CWD: &cwd, Cols: 400, Rows: 50})
	var sid uint16
	waitFor(t, "session created", func() bool {
		for _, m := range cl.messages() {
			if v, ok := m.(*protocol.SessionCreated); ok && v.ReqID == "wide" {
				sid = v.Session.SID
				return true
			}
		}
		return false
	})
	cl.send(&protocol.Subscribe{SID: sid, OutSeq: 0}) // creating doesn't subscribe
	// 2000 lines of 400 columns with frequent color changes: far over 256 KiB.
	cl.input(sid, `for i in $(seq 1 2100); do for j in 0 1 2 3 4 5 6 7; do printf '\033[3%d;4%dm%049d' $j $((7-j)) $i; done; printf '\033[0m\n'; done; printf 'WIDE-%s\n' DONE`+"\r")
	s, _ := h.sessions.Get(sid)
	waitFor(t, "output done", func() bool { return cl.screenHas(sid, "WIDE-DONE") })
	_, snap := s.TermSnapshot()
	if len(snap) <= protocol.MaxPayload {
		t.Fatalf("snapshot is only %d bytes; can't test splitting", len(snap))
	}

	// Page reload: a new connection with out_seq = 0 → snapshot.
	cl2 := h.connect(ctx, h.reuse(c), "tab-2", []protocol.ResumeReq{{SID: sid, OutSeq: 0}}, w.InstanceID)
	w2 := cl2.welcome()
	if w2.Resumed[0].Status != protocol.ResumeSnapshot {
		t.Fatalf("status = %q", w2.Resumed[0].Status)
	}
	waitFor(t, "snapshot complete", func() bool { return cl2.snapshotCount(sid) == 1 })
	var snapFrames []protocol.Frame
	for _, f := range cl2.binaryFrames() {
		if f.Type == protocol.TypeSnapshot && f.SID == sid {
			snapFrames = append(snapFrames, f)
		}
	}
	want := (len(snap) + protocol.MaxPayload - 1) / protocol.MaxPayload
	if len(snapFrames) < 2 || len(snapFrames) != want {
		t.Fatalf("%d-byte snapshot split into %d frames, want %d", len(snap), len(snapFrames), want)
	}
	for i, f := range snapFrames {
		if f.Seq != w2.Resumed[0].FromSeq {
			t.Fatalf("frame %d seq = %d, want %d (all frames of a snapshot share the seq)", i, f.Seq, w2.Resumed[0].FromSeq)
		}
		if last := i == len(snapFrames)-1; f.More() == last {
			t.Fatalf("frame %d MORE=%v; every frame but the last must carry MORE", i, f.More())
		}
		if len(f.Payload) > protocol.MaxPayload {
			t.Fatalf("frame %d payload of %d bytes exceeds the limit", i, len(f.Payload))
		}
	}
	if errs := cl2.seqErrors(); len(errs) != 0 {
		t.Fatalf("seq / framing errors: %v", errs)
	}
}

// A client frame in the wrong direction (OUTPUT / SNAPSHOT) → bad_frame and
// close (protocol §3).
func TestClientCannotSendServerFrames(t *testing.T) {
	for _, typ := range []uint8{protocol.TypeOutput, protocol.TypeSnapshot} {
		h := newHarness(t)
		c := h.client()
		h.pair(c).Body.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		cl := h.connect(ctx, c, "tab-1", nil, "")
		cl.welcome()
		f := protocol.EncodeFrame(protocol.Frame{Type: typ, SID: 1, Payload: []byte("x")})
		if err := cl.ws.Write(ctx, 2 /* binary */, f); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "bad_frame received", func() bool {
			for _, e := range cl.errors() {
				if e.Code == protocol.CodeBadFrame {
					return true
				}
			}
			return false
		})
		waitFor(t, "connection closed afterwards", func() bool { return cl.isClosed() })
		cancel()
	}
}

// Empty collections serialize as [], never null.
//
// encoding/json encodes a nil slice as null, but the http-api.md contract
// says array; a client calling .length on null crashes and the UI goes blank.
func TestEmptyCollectionsSerializeAsArrays(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()

	for _, path := range []string{"/api/devices"} {
		t.Run(path, func(t *testing.T) {
			resp := h.do(c, http.MethodGet, path, nil)
			defer resp.Body.Close()
			body, err := io.ReadAll(resp.Body)
			if err != nil {
				t.Fatal(err)
			}
			var probe any
			if err := json.Unmarshal(body, &probe); err != nil {
				t.Fatal(err)
			}
			if _, ok := probe.([]any); !ok {
				t.Fatalf("response = %#v; must be an array, not null (a client .length would crash)", probe)
			}
		})
	}
}

// Creating a session doesn't subscribe (protocol §4.1): after session.created
// and before the originator sends subscribe, no frames for that session
// arrive; subscribe{out_seq:0} gets the first screen as a snapshot.
func TestSessionCreateDoesNotAutoSubscribe(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cl := h.connect(ctx, c, "tab-1", nil, "")
	cl.welcome()
	cwd := t.TempDir()
	cl.send(&protocol.SessionCreate{ReqID: "r", CWD: &cwd, Cols: 80, Rows: 24})
	var sid uint16
	waitFor(t, "session.created received", func() bool {
		for _, m := range cl.messages() {
			if v, ok := m.(*protocol.SessionCreated); ok && v.ReqID == "r" {
				sid = v.Session.SID
				return true
			}
		}
		return false
	})
	cl.input(sid, "printf 'NOSUB-%s\\n' MARK\r")
	s, _ := h.sessions.Get(sid)
	waitFor(t, "command ran", func() bool { return s.HeadSeq() > 0 })
	time.Sleep(300 * time.Millisecond)
	for _, f := range cl.binaryFrames() {
		if f.SID == sid {
			t.Fatalf("received frame %+v without subscribing; creating must not subscribe", f)
		}
	}

	cl.send(&protocol.Subscribe{SID: sid, OutSeq: 0})
	waitFor(t, "snapshot after subscribing", func() bool { return cl.snapshotCount(sid) == 1 })
	if f := cl.binaryFrames()[0]; f.Type != protocol.TypeSnapshot || f.SID != sid {
		t.Fatalf("first frame = %+v, want a SNAPSHOT for this session", f)
	}
}

// The exit message follows the last output on the same connection: the last
// OUTPUT frame arrives first, then session.updated{status:"exited"} whose
// head_seq equals the end of that frame. The connection layer must not
// swallow it as a head_seq-only unread update.
func TestExitedAfterLastOutputOverSocket(t *testing.T) {
	h := newHarness(t)
	c := h.client()
	h.pair(c).Body.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab-1", nil, "")
	cl.welcome()
	sid := cl.createSession(t.TempDir())

	cl.input(sid, "for i in $(seq 1 3000); do printf 'tail-%05d xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n' $i; done; exit 3\r")
	var upd *protocol.SessionUpdated
	waitFor(t, "exited received", func() bool {
		for _, m := range cl.messages() {
			if u, ok := m.(*protocol.SessionUpdated); ok && u.SID == sid && u.Status != nil && *u.Status == protocol.StatusExited {
				upd = u
				return true
			}
		}
		return false
	})
	time.Sleep(300 * time.Millisecond) // give any late frame a chance to show up

	// Non-binary arrival entries map one-to-one onto messages; use that to
	// locate exited.
	order, msgs := cl.arrival(), cl.messages()
	k, at := 0, -1
	for i, typ := range order {
		if typ == "binary" {
			continue
		}
		if msgs[k] == any(upd) {
			at = i
		}
		k++
	}
	if at < 0 {
		t.Fatal("exited not found in arrival order")
	}
	for _, typ := range order[at+1:] {
		if typ == "binary" {
			t.Fatal("binary frames after exited; exit was announced before the output was drained")
		}
	}
	cl.mu.Lock()
	got := cl.outSeq[sid]
	cl.mu.Unlock()
	if upd.HeadSeq == nil || *upd.HeadSeq != got {
		t.Fatalf("head_seq in exited = %v, end of the client's last frame = %d", upd.HeadSeq, got)
	}
	if upd.ExitCode == nil || *upd.ExitCode != 3 {
		t.Fatalf("exit_code = %v", upd.ExitCode)
	}
	if !cl.screenHas(sid, "tail-03000") {
		t.Fatal("last output line never arrived")
	}
}
