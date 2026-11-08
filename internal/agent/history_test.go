package agent_test

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/sunhaijun/webterm/internal/agent"
)

// IT-history-1 (AC-3.24, ADR-0057 §1): GET /api/history needs a device session
// and returns what the program was sent recently, newest first, from its own
// history file under the user's home.
func TestITHistory1(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, ".claude"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".claude", "history.jsonl"),
		[]byte(`{"display":"/clear"}`+"\n"+`{"display":"继续"}`+"\n"+`{"display":"/clear"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".bash_history"), []byte("make test\nmake test\ngit status\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	h := newHarness(t, func(c *agent.Config) { c.Home = home })

	resp := h.do(h.client(), "GET", "/api/history?program=claude", nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated: status %d, want 401", resp.StatusCode)
	}

	c := h.client()
	h.pair(c).Body.Close()
	get := func(program string) []string {
		t.Helper()
		resp := h.do(c, "GET", "/api/history?program="+program, nil)
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s: status %d, want 200", program, resp.StatusCode)
		}
		var body struct {
			Items []string `json:"items"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Items == nil {
			t.Fatalf("%s: items is null, want an array", program)
		}
		return body.Items
	}
	if got, want := get("claude"), []string{"/clear", "继续"}; !slices.Equal(got, want) { // newest first, distinct
		t.Fatalf("claude: %q, want %q", got, want)
	}
	if got, want := get("shell"), []string{"git status", "make test"}; !slices.Equal(got, want) {
		t.Fatalf("shell (bash): %q, want %q", got, want)
	}
	if got := get("codex"); len(got) != 0 {
		t.Fatalf("codex without a history file: %q, want []", got)
	}
	if got := get("other"); len(got) != 0 {
		t.Fatalf("other: %q, want []", got)
	}
}
