package agent_test

import (
	"net/http"
	"testing"
)

// IT-transcript-3：/api/transcript 要认证；sid 非法 400；没跟踪过 404。
func TestITTranscriptEndpoint(t *testing.T) {
	h := newHarness(t)
	resp := h.do(h.client(), http.MethodGet, "/api/transcript?sid=1", nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("未配对 status = %d, want 401", resp.StatusCode)
	}
	c := h.client()
	h.pair(c).Body.Close()
	for _, q := range []string{"", "sid=0", "sid=abc", "sid=70000"} {
		resp := h.do(c, http.MethodGet, "/api/transcript?"+q, nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("%q: status = %d, want 400", q, resp.StatusCode)
		}
	}
	resp = h.do(c, http.MethodGet, "/api/transcript?sid=42", nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("没跟踪过的会话 status = %d, want 404", resp.StatusCode)
	}
}
