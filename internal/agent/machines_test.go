package agent_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/sunhaijun/webterm/internal/agent"
	"github.com/sunhaijun/webterm/internal/auth"
)

// Several machines in one page (ADR-0062). These run the agent with a
// production configuration: under --dev every local origin counts as the
// agent's own, so the binding of §4 can only be seen with a real domain. The
// agent is tokyo; la is another machine on the same site whose page pairs
// with it.
const (
	tokyo = "https://tokyo.example.com:8443"
	la    = "https://la.example.com:8443"
	blog  = "https://blog.example.com"
	evil  = "https://la.example.org:8443"
)

func newMachineHarness(t *testing.T, domain string, port int) *harness {
	return newHarness(t, func(c *agent.Config) {
		c.Dev = false
		c.Domain = domain
		c.HTTPSPort = port
	})
}

// mreq sends one request the way a browser on page `origin` would, with an
// explicit cookie (the cookies are Secure and the test server is plain HTTP,
// so a cookie jar wouldn't send them).
func (h *harness) mreq(method, path, origin, token string, body []byte, hdr map[string]string) *http.Response {
	h.t.Helper()
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, _ := http.NewRequest(method, h.srv.URL+path, rd)
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if token != "" {
		req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: token})
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	return resp
}

// pairFrom pairs from a page at origin and returns the status, the token and
// the device the agent reports.
func (h *harness) pairFrom(origin, code string) (int, string, map[string]any) {
	h.t.Helper()
	b, _ := json.Marshal(map[string]string{"code": code})
	resp := h.mreq(http.MethodPost, "/auth/pair", origin, "", b, map[string]string{"User-Agent": "Mozilla/5.0 (iPhone) Safari/605"})
	defer resp.Body.Close()
	var out struct {
		Device map[string]any `json:"device"`
		Code   string         `json:"code"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	token := ""
	for _, c := range resp.Cookies() {
		if c.Name == auth.CookieName {
			token = c.Value
		}
	}
	if resp.StatusCode != http.StatusOK {
		return resp.StatusCode, out.Code, nil
	}
	return resp.StatusCode, token, out.Device
}

func (h *harness) newCode() string {
	h.t.Helper()
	code, err := h.agent.Auth().NewPairingCode(time.Now())
	if err != nil {
		h.t.Fatal(err)
	}
	return code
}

// IT-machines-1: pairing from another machine's page (AC-10.2).
func TestITMachines1_PairingOrigin(t *testing.T) {
	h := newMachineHarness(t, "tokyo.example.com", 8443)

	for _, tc := range []struct {
		name, origin, bound string
	}{
		{"no Origin", "", ""},
		{"its own page", tokyo, ""},
		{"another machine's page on the site", la, la},
	} {
		t.Run(tc.name, func(t *testing.T) {
			status, token, dev := h.pairFrom(tc.origin, h.newCode())
			if status != http.StatusOK || token == "" {
				t.Fatalf("status %d, token %q", status, token)
			}
			got, _ := dev["origin"].(string)
			if got != tc.bound {
				t.Errorf("device origin = %q, want %q", got, tc.bound)
			}
			d, err := h.store.DeviceByToken(token)
			if err != nil || d == nil || d.Origin != tc.bound {
				t.Errorf("stored device = %+v (%v), want origin %q", d, err, tc.bound)
			}
		})
	}

	t.Run("another site is refused before the code is used", func(t *testing.T) {
		code := h.newCode()
		for _, origin := range []string{evil, "http://la.example.com:8443", "null"} {
			status, errCode, _ := h.pairFrom(origin, code)
			if status != http.StatusForbidden || errCode != "cross_site" {
				t.Fatalf("pair from %s: %d %q, want 403 cross_site", origin, status, errCode)
			}
		}
		if status, _, _ := h.pairFrom(tokyo, code); status != http.StatusOK {
			t.Fatalf("the code no longer pairs after cross-site attempts: %d", status)
		}
	})

	t.Run("the device list shows the bound origin", func(t *testing.T) {
		_, token, _ := h.pairFrom(la, h.newCode())
		resp := h.mreq(http.MethodGet, "/api/devices", la, token, nil, nil)
		defer resp.Body.Close()
		var list []map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
			t.Fatal(err)
		}
		found := false
		for _, d := range list {
			if d["current"] == true {
				found = d["origin"] == la
			}
		}
		if !found {
			t.Errorf("current device in %v lacks origin %s", list, la)
		}
	})
}

// IT-machines-1 (IP mode): an agent on an IP address accepts no other origin.
func TestITMachines1_IPModeAcceptsNoOtherOrigin(t *testing.T) {
	h := newMachineHarness(t, "203.0.113.5", 443)
	for _, origin := range []string{"https://203.0.113.6", "https://x.example.com"} {
		if status, errCode, _ := h.pairFrom(origin, h.newCode()); status != http.StatusForbidden || errCode != "cross_site" {
			t.Errorf("pair from %s: %d %q, want 403 cross_site", origin, status, errCode)
		}
	}
	if status, _, _ := h.pairFrom("https://203.0.113.5", h.newCode()); status != http.StatusOK {
		t.Errorf("pair from its own origin: %d", status)
	}
}

// IT-machines-2: a device is bound to the origin it was paired from (AC-10.3),
// and signing out from another machine's page sends no Clear-Site-Data (AC-10.6).
func TestITMachines2_BoundOrigin(t *testing.T) {
	h := newMachineHarness(t, "tokyo.example.com", 8443)
	_, bound, _ := h.pairFrom(la, h.newCode())
	_, own, _ := h.pairFrom(tokyo, h.newCode())

	status := func(method, path, origin, token string, body []byte) int {
		resp := h.mreq(method, path, origin, token, body, nil)
		resp.Body.Close()
		return resp.StatusCode
	}
	for _, tc := range []struct {
		name, origin, token string
		want                int
	}{
		{"bound device from its page", la, bound, http.StatusOK},
		{"bound device from the agent's own page", tokyo, bound, http.StatusOK},
		{"bound device without Origin", "", bound, http.StatusOK},
		{"bound device from another same-site page", blog, bound, http.StatusForbidden},
		{"bound device from another site", evil, bound, http.StatusForbidden},
		{"own device from another machine's page", la, own, http.StatusForbidden},
		{"own device from its page", tokyo, own, http.StatusOK},
	} {
		t.Run("GET /api/devices: "+tc.name, func(t *testing.T) {
			if got := status(http.MethodGet, "/api/devices", tc.origin, tc.token, nil); got != tc.want {
				t.Errorf("status %d, want %d", got, tc.want)
			}
		})
	}

	t.Run("writes", func(t *testing.T) {
		body, _ := json.Marshal(map[string]string{"dir": t.TempDir(), "name": "x"})
		if got := status(http.MethodPost, "/api/fs/mkdir", blog, bound, body); got != http.StatusForbidden {
			t.Errorf("mkdir from another same-site page: %d, want 403", got)
		}
		if got := status(http.MethodPost, "/api/fs/mkdir", la, bound, body); got != http.StatusCreated {
			t.Errorf("mkdir from the bound page: %d, want 201", got)
		}
	})

	t.Run("the WebSocket upgrade", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		dial := func(origin string) (*websocket.Conn, *http.Response, error) {
			hdr := http.Header{}
			hdr.Set("Origin", origin)
			hdr.Set("Cookie", auth.CookieName+"="+bound)
			return websocket.Dial(ctx, h.wsURL(), &websocket.DialOptions{HTTPHeader: hdr})
		}
		if _, resp, err := dial(blog); err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
			t.Errorf("upgrade from another same-site page: err=%v resp=%v, want 403", err, resp)
		}
		ws, _, err := dial(la)
		if err != nil {
			t.Fatalf("upgrade from the bound page: %v", err)
		}
		ws.CloseNow()
		if !strings.Contains(h.logs.String(), blog) {
			t.Error("the refused upgrade isn't logged with its Origin")
		}
	})

	t.Run("sign-out from another machine's page", func(t *testing.T) {
		resp := h.mreq(http.MethodPost, "/auth/logout", la, bound, nil, nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusNoContent {
			t.Fatalf("status %d", resp.StatusCode)
		}
		if got := resp.Header.Get("Clear-Site-Data"); got != "" {
			t.Errorf("Clear-Site-Data = %q to another machine's page, want none", got)
		}
		cleared := false
		for _, c := range resp.Cookies() {
			cleared = cleared || (c.Name == auth.CookieName && c.MaxAge < 0)
		}
		if !cleared {
			t.Error("the cookie isn't cleared")
		}
		if got := status(http.MethodGet, "/api/devices", "", bound, nil); got != http.StatusUnauthorized {
			t.Errorf("signed-out token: %d, want 401", got)
		}
		if got := status(http.MethodGet, "/api/devices", tokyo, own, nil); got != http.StatusOK {
			t.Errorf("the other device was signed out too: %d", got)
		}
	})
}

// IT-machines-3: CORS answers origins on the site, refusals included, and
// nobody else (AC-10.4).
func TestITMachines3_CORS(t *testing.T) {
	h := newMachineHarness(t, "tokyo.example.com", 8443)
	_, bound, _ := h.pairFrom(la, h.newCode())

	corsOf := func(resp *http.Response) (string, string) {
		resp.Body.Close()
		return resp.Header.Get("Access-Control-Allow-Origin"), resp.Header.Get("Access-Control-Allow-Credentials")
	}
	for _, tc := range []struct {
		name, method, path, origin, token string
		status                            int
		acao                              string
	}{
		{"200 to the bound page", http.MethodGet, "/api/devices", la, bound, http.StatusOK, la},
		{"401 to a page on the site", http.MethodGet, "/api/devices", la, "", http.StatusUnauthorized, la},
		{"403 to another page on the site", http.MethodGet, "/api/devices", blog, bound, http.StatusForbidden, blog},
		{"403 cross_site pairing to another site", http.MethodPost, "/auth/pair", evil, "", http.StatusForbidden, ""},
		{"401 to another site", http.MethodGet, "/api/devices", evil, "", http.StatusUnauthorized, ""},
		{"not under /api or /auth", http.MethodGet, "/healthz", la, "", http.StatusOK, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var body []byte
			if tc.method == http.MethodPost {
				body = []byte(`{"code":"x"}`)
			}
			resp := h.mreq(tc.method, tc.path, tc.origin, tc.token, body, nil)
			if resp.StatusCode != tc.status {
				t.Errorf("status %d, want %d", resp.StatusCode, tc.status)
			}
			vary := resp.Header.Values("Vary")
			acao, acac := corsOf(resp)
			if acao != tc.acao {
				t.Errorf("Access-Control-Allow-Origin = %q, want %q", acao, tc.acao)
			}
			if tc.acao != "" {
				if acac != "true" {
					t.Errorf("Access-Control-Allow-Credentials = %q", acac)
				}
				if !strings.Contains(strings.Join(vary, ","), "Origin") {
					t.Errorf("Vary = %v, want Origin", vary)
				}
			}
		})
	}

	preflight := func(path, origin string) *http.Response {
		return h.mreq(http.MethodOptions, path, origin, "", nil, map[string]string{
			"Access-Control-Request-Method":  "POST",
			"Access-Control-Request-Headers": "content-type",
		})
	}
	for _, path := range []string{"/auth/pair", "/api/fs/list", "/api/uploads"} {
		t.Run("preflight "+path, func(t *testing.T) {
			resp := preflight(path, la)
			resp.Body.Close()
			if resp.StatusCode != http.StatusNoContent {
				t.Fatalf("status %d, want 204", resp.StatusCode)
			}
			for k, want := range map[string]string{
				"Access-Control-Allow-Origin":      la,
				"Access-Control-Allow-Credentials": "true",
				"Access-Control-Allow-Methods":     "GET, POST, PUT, PATCH, DELETE",
				"Access-Control-Allow-Headers":     "Content-Type, Range",
				"Access-Control-Max-Age":           "600",
			} {
				if got := resp.Header.Get(k); got != want {
					t.Errorf("%s = %q, want %q", k, got, want)
				}
			}
		})
	}
	t.Run("preflight from another site", func(t *testing.T) {
		resp := preflight("/auth/pair", evil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden || resp.Header.Get("Access-Control-Allow-Origin") != "" {
			t.Errorf("status %d, ACAO %q; want 403 without CORS", resp.StatusCode, resp.Header.Get("Access-Control-Allow-Origin"))
		}
	})
}
