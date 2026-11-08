package agent_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/sunhaijun/webterm/internal/agent"
)

const sameSite = "http://127.0.0.1:8080"

// fsReq sends one file browser request; body is JSON unless it is an io.Reader.
func (h *harness) fsReq(c *http.Client, method, path, origin string, body any, hdr ...string) *http.Response {
	h.t.Helper()
	var r io.Reader = http.NoBody
	switch b := body.(type) {
	case nil:
	case io.Reader:
		r = b
	default:
		j, _ := json.Marshal(b)
		r = bytes.NewReader(j)
	}
	req, _ := http.NewRequest(method, h.srv.URL+path, r)
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	resp, err := c.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	return resp
}

func q(s string) string { return url.QueryEscape(s) }

func status(t *testing.T, resp *http.Response) int {
	t.Helper()
	resp.Body.Close()
	return resp.StatusCode
}

// IT-fs-1: authentication, the Origin check, absolute paths, nothing in the log (AC-9.12).
func TestITFs1(t *testing.T) {
	home := t.TempDir()
	h := newHarness(t, func(c *agent.Config) { c.Home = home })
	secret := filepath.Join(home, "SECRET-plan")
	if err := os.WriteFile(secret, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	anon := h.client()
	for _, r := range []struct{ method, path string }{
		{"GET", "/api/fs/list?path=" + q(home)},
		{"GET", "/api/fs/raw?path=" + q(secret)},
		{"POST", "/api/fs/upload?dir=" + q(home) + "&name=a"},
		{"POST", "/api/fs/mkdir"},
		{"POST", "/api/fs/rename"},
		{"DELETE", "/api/fs?path=" + q(secret)},
	} {
		if s := status(t, h.fsReq(anon, r.method, r.path, sameSite, nil)); s != http.StatusUnauthorized {
			t.Errorf("%s %s unauthenticated: %d, want 401", r.method, r.path, s)
		}
	}

	c := h.client()
	h.pair(c).Body.Close()
	const evil = "https://evil.example.com"
	for _, r := range []struct {
		method, path string
		body         any
	}{
		{"POST", "/api/fs/upload?dir=" + q(home) + "&name=evil", strings.NewReader("x")},
		{"POST", "/api/fs/mkdir", map[string]string{"dir": home, "name": "evil"}},
		{"POST", "/api/fs/rename", map[string]string{"path": secret, "name": "evil"}},
		{"DELETE", "/api/fs?path=" + q(secret), nil},
	} {
		if s := status(t, h.fsReq(c, r.method, r.path, evil, r.body)); s != http.StatusForbidden {
			t.Errorf("%s %s cross-site: %d, want 403", r.method, r.path, s)
		}
	}
	if _, err := os.Stat(secret); err != nil {
		t.Error("a cross-site request changed something")
	}
	if _, err := os.Stat(filepath.Join(home, "evil")); err == nil {
		t.Error("a cross-site request created a file")
	}

	for _, p := range []string{"/api/fs/list?path=relative", "/api/fs/raw?path=", "/api/fs/list?path=" + q("/a\x00b")} {
		resp := h.fsReq(c, "GET", p, "", nil)
		if resp.StatusCode != http.StatusBadRequest || errorCode(t, resp) != "bad_request" {
			t.Errorf("GET %s: %d, want 400 bad_request", p, resp.StatusCode)
		}
	}

	// Exercise every route once, then check the log
	h.fsReq(c, "GET", "/api/fs/list?path="+q(home), "", nil).Body.Close()
	h.fsReq(c, "GET", "/api/fs/raw?path="+q(secret), "", nil).Body.Close()
	h.fsReq(c, "POST", "/api/fs/upload?dir="+q(home)+"&name=SECRET-up", sameSite, strings.NewReader("y")).Body.Close()
	h.fsReq(c, "POST", "/api/fs/mkdir", sameSite, map[string]string{"dir": home, "name": "SECRET-dir"}).Body.Close()
	h.fsReq(c, "POST", "/api/fs/rename", sameSite, map[string]string{"path": secret, "name": "SECRET-renamed"}).Body.Close()
	h.fsReq(c, "DELETE", "/api/fs?path="+q(home+"/SECRET-dir"), sameSite, nil).Body.Close()
	h.fsReq(c, "GET", "/api/fs/list?path="+q(home+"/SECRET-missing"), "", nil).Body.Close()
	if strings.Contains(h.logs.String(), "SECRET") || strings.Contains(h.logs.String(), home) {
		t.Errorf("a path reached the log:\n%s", h.logs.String())
	}
}

// IT-fs-2: listing and serving (AC-9.12, http-api.md#files).
func TestITFs2(t *testing.T) {
	home := t.TempDir()
	h := newHarness(t, func(c *agent.Config) { c.Home = home })
	c := h.client()
	h.pair(c).Body.Close()

	page := []byte("<html><script>alert(1)</script></html>")
	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{7}, 3000)...)
	write := func(name string, b []byte) {
		if err := os.WriteFile(filepath.Join(home, name), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("page.html", page)
	write("shot.png", png)
	write("icon.svg", []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`))
	write("截图 1.txt", []byte("0123456789"))
	if err := os.Mkdir(filepath.Join(home, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(home, "fifo"), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Run("list", func(t *testing.T) {
		resp := h.fsReq(c, "GET", "/api/fs/list?path="+q(home+"/./sub/.."), "", nil)
		defer resp.Body.Close()
		var l struct {
			Path    string
			Total   int
			Entries []struct {
				Name, Type  string
				Size, MTime int64
			}
		}
		if resp.StatusCode != 200 || json.NewDecoder(resp.Body).Decode(&l) != nil {
			t.Fatalf("status %d", resp.StatusCode)
		}
		if l.Path != home || l.Total != 6 || len(l.Entries) != 6 {
			t.Fatalf("%+v", l)
		}
		for _, e := range l.Entries {
			if e.Name == "sub" && e.Type != "dir" || e.Name == "shot.png" && (e.Type != "file" || e.Size != int64(len(png))) || e.Name == "fifo" && e.Type != "other" {
				t.Errorf("entry %+v", e)
			}
			if e.MTime == 0 {
				t.Errorf("%s: no mtime", e.Name)
			}
		}
		if s := status(t, h.fsReq(c, "GET", "/api/fs/list?path="+q(home+"/shot.png"), "", nil)); s != 400 {
			t.Errorf("list a file: %d, want 400", s)
		}
		resp2 := h.fsReq(c, "GET", "/api/fs/list?path="+q(home+"/missing"), "", nil)
		if resp2.StatusCode != 404 || errorCode(t, resp2) != "not_found" {
			t.Errorf("missing: %d", resp2.StatusCode)
		}
	})

	raw := func(name string, hdr ...string) *http.Response {
		return h.fsReq(c, "GET", "/api/fs/raw?path="+q(filepath.Join(home, name)), "", nil, hdr...)
	}

	t.Run("a page never runs", func(t *testing.T) {
		for _, name := range []string{"page.html", "icon.svg"} {
			resp := raw(name)
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			hd := resp.Header
			if resp.StatusCode != 200 || !strings.HasPrefix(hd.Get("Content-Disposition"), "attachment") ||
				!strings.Contains(hd.Get("Content-Security-Policy"), "sandbox") || hd.Get("X-Content-Type-Options") != "nosniff" {
				t.Errorf("%s: %d %v", name, resp.StatusCode, hd)
			}
			if name == "page.html" && (hd.Get("Content-Type") != "application/octet-stream" || !bytes.Equal(body, page)) {
				t.Errorf("page.html: type %q", hd.Get("Content-Type"))
			}
			if name == "icon.svg" && hd.Get("Content-Type") != "image/svg+xml" {
				t.Errorf("icon.svg: type %q", hd.Get("Content-Type"))
			}
		}
	})

	t.Run("images inline, downloads attached", func(t *testing.T) {
		resp := raw("shot.png")
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.Header.Get("Content-Type") != "image/png" || resp.Header.Get("Content-Disposition") != `inline; filename=shot.png` || !bytes.Equal(body, png) {
			t.Errorf("png: %v", resp.Header)
		}
		if resp.Header.Get("Cache-Control") != "no-store" || resp.Header.Get("ETag") == "" {
			t.Errorf("caching: %v", resp.Header)
		}
		resp = h.fsReq(c, "GET", "/api/fs/raw?download=1&path="+q(filepath.Join(home, "shot.png")), "", nil)
		resp.Body.Close()
		if !strings.HasPrefix(resp.Header.Get("Content-Disposition"), "attachment") {
			t.Errorf("download=1: %q", resp.Header.Get("Content-Disposition"))
		}
		resp = raw("截图 1.txt")
		resp.Body.Close()
		if d := resp.Header.Get("Content-Disposition"); d != `attachment; filename*=utf-8''%E6%88%AA%E5%9B%BE%201.txt` {
			t.Errorf("non-ASCII name: %q", d)
		}
	})

	t.Run("range and revalidation", func(t *testing.T) {
		resp := raw("截图 1.txt", "Range", "bytes=-4")
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusPartialContent || string(body) != "6789" {
			t.Errorf("suffix range: %d %q", resp.StatusCode, body)
		}
		etag := resp.Header.Get("ETag")
		if s := status(t, raw("截图 1.txt", "If-None-Match", etag)); s != http.StatusNotModified {
			t.Errorf("If-None-Match: %d, want 304", s)
		}
	})

	t.Run("only regular files", func(t *testing.T) {
		for _, name := range []string{"sub", "fifo"} {
			resp := raw(name)
			if resp.StatusCode != 400 || errorCode(t, resp) != "bad_request" {
				t.Errorf("%s: %d, want 400", name, resp.StatusCode)
			}
		}
		if s := status(t, raw("missing")); s != 404 {
			t.Errorf("missing: %d", s)
		}
	})
}

// IT-fs-3: upload, mkdir, rename, delete (AC-9.12).
func TestITFs3(t *testing.T) {
	home := t.TempDir()
	h := newHarness(t, func(c *agent.Config) { c.Home = home })
	c := h.client()
	h.pair(c).Body.Close()
	dir := filepath.Join(home, "proj")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}

	upload := func(name string, body io.Reader) *http.Response {
		return h.fsReq(c, "POST", "/api/fs/upload?dir="+q(dir)+"&name="+q(name), sameSite, body)
	}
	var got struct {
		Path, Name string
		Size       int64
	}

	t.Run("upload", func(t *testing.T) {
		big := bytes.Repeat([]byte("abcdefgh"), 4<<20) // 32 MiB: past ADR-0051's 20 MiB limit
		resp := upload("shot 1.png", bytes.NewReader(big))
		if resp.StatusCode != http.StatusCreated || json.NewDecoder(resp.Body).Decode(&got) != nil {
			t.Fatalf("status %d", resp.StatusCode)
		}
		resp.Body.Close()
		if got.Path != filepath.Join(dir, "shot 1.png") || got.Name != "shot 1.png" || got.Size != int64(len(big)) {
			t.Errorf("%+v", got)
		}
		if data, _ := os.ReadFile(got.Path); !bytes.Equal(data, big) {
			t.Error("content differs")
		}
		resp = upload("shot 1.png", strings.NewReader("second"))
		json.NewDecoder(resp.Body).Decode(&got)
		resp.Body.Close()
		if resp.StatusCode != http.StatusCreated || got.Name != "shot 1-1.png" {
			t.Errorf("conflict: %d %+v", resp.StatusCode, got)
		}
		for _, bad := range []string{"", "..", "a/b", "x\ny"} {
			if s := status(t, upload(bad, strings.NewReader("x"))); s != 400 {
				t.Errorf("name %q: %d, want 400", bad, s)
			}
		}
		resp = h.fsReq(c, "POST", "/api/fs/upload?dir="+q(home+"/nope")+"&name=a", sameSite, strings.NewReader("x"))
		if resp.StatusCode != 404 || errorCode(t, resp) != "not_found" {
			t.Errorf("missing folder: %d", resp.StatusCode)
		}
		des, _ := os.ReadDir(dir)
		for _, de := range des {
			if strings.HasSuffix(de.Name(), ".part") {
				t.Errorf("part file left: %s", de.Name())
			}
		}
	})

	t.Run("mkdir", func(t *testing.T) {
		resp := h.fsReq(c, "POST", "/api/fs/mkdir", sameSite, map[string]string{"dir": dir, "name": "made"})
		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("status %d", resp.StatusCode)
		}
		resp.Body.Close()
		resp = h.fsReq(c, "POST", "/api/fs/mkdir", sameSite, map[string]string{"dir": dir, "name": "made"})
		if resp.StatusCode != http.StatusConflict || errorCode(t, resp) != "exists" {
			t.Errorf("twice: %d", resp.StatusCode)
		}
		if s := status(t, h.fsReq(c, "POST", "/api/fs/mkdir", sameSite, strings.NewReader("{not json"))); s != 400 {
			t.Errorf("malformed: %d", s)
		}
		if s := status(t, h.fsReq(c, "POST", "/api/fs/mkdir", sameSite, map[string]string{"dir": dir, "name": "../escaped"})); s != 400 {
			t.Errorf("a name with ..: %d, want 400", s)
		}
		if _, err := os.Stat(home + "/escaped"); err == nil {
			t.Error("mkdir escaped its folder")
		}
	})

	t.Run("rename", func(t *testing.T) {
		resp := h.fsReq(c, "POST", "/api/fs/rename", sameSite, map[string]string{"path": dir + "/shot 1.png", "name": "shot 1-1.png"})
		if resp.StatusCode != http.StatusConflict || errorCode(t, resp) != "exists" {
			t.Errorf("onto a taken name: %d", resp.StatusCode)
		}
		if data, _ := os.ReadFile(dir + "/shot 1-1.png"); string(data) != "second" {
			t.Error("the target was replaced")
		}
		resp = h.fsReq(c, "POST", "/api/fs/rename", sameSite, map[string]string{"path": dir + "/shot 1.png", "name": "renamed.png"})
		var r struct{ Path string }
		json.NewDecoder(resp.Body).Decode(&r)
		resp.Body.Close()
		if resp.StatusCode != 200 || r.Path != dir+"/renamed.png" {
			t.Errorf("rename: %d %q", resp.StatusCode, r.Path)
		}
	})

	t.Run("delete", func(t *testing.T) {
		if err := os.WriteFile(dir+"/made/inner", []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		if s := status(t, h.fsReq(c, "DELETE", "/api/fs?path="+q(dir+"/made"), sameSite, nil)); s != http.StatusNoContent {
			t.Errorf("folder: %d", s)
		}
		if _, err := os.Stat(dir + "/made"); err == nil {
			t.Error("folder still there")
		}
		resp := h.fsReq(c, "POST", "/api/fs/rename", sameSite, map[string]string{"path": home, "name": "moved"})
		if resp.StatusCode != 400 || errorCode(t, resp) != "bad_request" {
			t.Errorf("rename home: %d, want 400", resp.StatusCode)
		}
		for _, p := range []string{"/", home, home + "/"} {
			resp := h.fsReq(c, "DELETE", "/api/fs?path="+q(p), sameSite, nil)
			if resp.StatusCode != 400 || errorCode(t, resp) != "bad_request" {
				t.Errorf("delete %q: %d, want 400", p, resp.StatusCode)
			}
		}
		if s := status(t, h.fsReq(c, "DELETE", "/api/fs?path="+q(dir+"/missing"), sameSite, nil)); s != 404 {
			t.Errorf("missing: %d", s)
		}
	})

	t.Run("permission denied", func(t *testing.T) {
		if os.Geteuid() == 0 {
			t.Skip("root ignores permissions")
		}
		locked := filepath.Join(home, "locked")
		if err := os.Mkdir(locked, 0o000); err != nil {
			t.Fatal(err)
		}
		defer os.Chmod(locked, 0o755)
		resp := h.fsReq(c, "GET", "/api/fs/list?path="+q(locked), "", nil)
		if resp.StatusCode != 403 || errorCode(t, resp) != "forbidden" {
			t.Errorf("list: %d, want 403", resp.StatusCode)
		}
		resp = h.fsReq(c, "POST", "/api/fs/upload?dir="+q(locked)+"&name=a", sameSite, strings.NewReader("x"))
		if resp.StatusCode != 403 || errorCode(t, resp) != "forbidden" {
			t.Errorf("upload: %d, want 403", resp.StatusCode)
		}
	})
}
