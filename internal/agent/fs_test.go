package agent_test

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

// IT-fs-1：/api/fs 要认证、cwd 必须绝对、返回形状（ADR-0011 ③）。
func TestITFS1_Endpoint(t *testing.T) {
	h := newHarness(t)

	t.Run("未配对 401", func(t *testing.T) {
		resp := h.do(h.client(), http.MethodGet, "/api/fs?cwd=/&path=", nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", resp.StatusCode)
		}
	})

	c := h.client()
	h.pair(c).Body.Close()

	t.Run("cwd 不是绝对路径 400", func(t *testing.T) {
		for _, cwd := range []string{"", "relative", "~/x"} {
			resp := h.do(c, http.MethodGet, "/api/fs?cwd="+url.QueryEscape(cwd)+"&path=", nil)
			resp.Body.Close()
			if resp.StatusCode != http.StatusBadRequest {
				t.Errorf("cwd=%q: status = %d, want 400", cwd, resp.StatusCode)
			}
		}
	})

	t.Run("列目录：目录在前，带 dir 标记", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.Mkdir(filepath.Join(dir, "alpha"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "beta.txt"), nil, 0o644); err != nil {
			t.Fatal(err)
		}
		resp := h.do(c, http.MethodGet, "/api/fs?cwd="+url.QueryEscape(dir)+"&path=", nil)
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
		var body struct {
			Items []struct {
				Name string `json:"name"`
				Dir  bool   `json:"dir"`
			} `json:"items"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if len(body.Items) != 2 || body.Items[0].Name != "alpha" || !body.Items[0].Dir || body.Items[1].Name != "beta.txt" || body.Items[1].Dir {
			t.Fatalf("items = %+v", body.Items)
		}
	})

	t.Run("目录不存在也是 200 空列表", func(t *testing.T) {
		resp := h.do(c, http.MethodGet, "/api/fs?cwd="+url.QueryEscape(t.TempDir())+"&path=nope/", nil)
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status = %d, want 200", resp.StatusCode)
		}
		var body map[string]json.RawMessage
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if string(body["items"]) != "[]" {
			t.Fatalf("items = %s, want []", body["items"])
		}
	})
}
