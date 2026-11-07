package agent_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/sunhaijun/webterm/internal/agent"
)

// upload posts body as a file named name, with an optional Origin. chunked
// hides the length, so the limit is enforced while streaming rather than up
// front from Content-Length.
func (h *harness) upload(c *http.Client, name, origin string, body []byte, chunked bool) *http.Response {
	h.t.Helper()
	var r io.Reader = bytes.NewReader(body)
	if chunked {
		r = io.MultiReader(bytes.NewReader(body)) // not a known type: no Content-Length
	}
	req, _ := http.NewRequest(http.MethodPost, h.srv.URL+"/api/uploads?name="+url.QueryEscape(name), r)
	req.Header.Set("Content-Type", "application/octet-stream")
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	resp, err := c.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	return resp
}

func errorCode(t *testing.T, resp *http.Response) string {
	t.Helper()
	defer resp.Body.Close()
	var e struct{ Code string }
	if err := json.NewDecoder(resp.Body).Decode(&e); err != nil {
		t.Fatalf("error body: %v", err)
	}
	return e.Code
}

// IT-upload-1: POST /api/uploads (AC-8.7, ADR-0051, http-api.md#uploads).
func TestITUpload1(t *testing.T) {
	root := filepath.Join(t.TempDir(), "webterm-it")
	h := newHarness(t, func(c *agent.Config) { c.UploadRoot = root })
	dir := filepath.Join(root, "uploads")
	const secretName = "quarterly-plan-SECRET.png"
	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{1}, 2000)...)

	t.Run("unauthenticated → 401", func(t *testing.T) {
		resp := h.upload(h.client(), "a.png", "", png, false)
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("status %d, want 401", resp.StatusCode)
		}
	})

	c := h.client()
	h.pair(c).Body.Close()

	t.Run("cross-site Origin → 403", func(t *testing.T) {
		resp := h.upload(c, "a.png", "https://evil.example.com", png, false)
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Errorf("status %d, want 403", resp.StatusCode)
		}
	})

	t.Run("saved", func(t *testing.T) {
		resp := h.upload(c, secretName, "http://127.0.0.1:8080", png, false)
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("status %d, want 201", resp.StatusCode)
		}
		var got struct {
			Path string
			Size int64
		}
		if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
			t.Fatal(err)
		}
		if got.Size != int64(len(png)) {
			t.Errorf("size %d, want %d", got.Size, len(png))
		}
		if filepath.Dir(got.Path) != dir || !regexp.MustCompile(`^quarterly-plan-SECRET-[0-9a-f]{6}\.png$`).MatchString(filepath.Base(got.Path)) {
			t.Errorf("path %s", got.Path)
		}
		data, err := os.ReadFile(got.Path)
		if err != nil || !bytes.Equal(data, png) {
			t.Errorf("content differs (err %v)", err)
		}
		if fi, _ := os.Stat(got.Path); fi == nil || fi.Mode().Perm() != 0o600 {
			t.Errorf("mode %v, want 0600", fi)
		}
	})

	t.Run("empty → 400", func(t *testing.T) {
		if resp := h.upload(c, "e.png", "", nil, false); resp.StatusCode != http.StatusBadRequest || errorCode(t, resp) != "bad_request" {
			t.Errorf("status %d, want 400 bad_request", resp.StatusCode)
		}
	})

	t.Run("over 20 MiB → 413, nothing kept", func(t *testing.T) {
		before := entries(t, dir)
		big := make([]byte, 20<<20+1)
		for _, chunked := range []bool{false, true} {
			resp := h.upload(c, "big.bin", "", big, chunked)
			if resp.StatusCode != http.StatusRequestEntityTooLarge || errorCode(t, resp) != "too_large" {
				t.Errorf("chunked=%v: status %d, want 413 too_large", chunked, resp.StatusCode)
			}
		}
		if after := entries(t, dir); after != before {
			t.Errorf("directory went from %d to %d entries", before, after)
		}
	})

	t.Run("an unsafe directory → 500, nothing written", func(t *testing.T) {
		if err := os.Chmod(root, 0o755); err != nil {
			t.Fatal(err)
		}
		defer os.Chmod(root, 0o700)
		before := entries(t, dir)
		resp := h.upload(c, secretName, "", png, false)
		if resp.StatusCode != http.StatusInternalServerError || errorCode(t, resp) != "internal" {
			t.Errorf("status %d, want 500 internal", resp.StatusCode)
		}
		if after := entries(t, dir); after != before {
			t.Errorf("wrote into an unsafe directory")
		}
		if !strings.Contains(h.logs.String(), "accessible to other users") {
			t.Errorf("the reason isn't logged:\n%s", h.logs.String())
		}
	})

	t.Run("file names stay out of the log", func(t *testing.T) {
		if strings.Contains(h.logs.String(), "quarterly-plan") {
			t.Errorf("log contains the file name:\n%s", h.logs.String())
		}
	})
}

func entries(t *testing.T, dir string) int {
	t.Helper()
	des, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	return len(des)
}
