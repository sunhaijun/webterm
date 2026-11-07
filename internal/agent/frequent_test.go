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

// IT-frequent-1 (AC-3.24, ADR-0054 §3): GET /api/frequent needs a device
// session and returns the program's most frequent single-line inputs from its
// own history file under the user's home.
func TestITFrequent1(t *testing.T) {
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

	resp := h.do(h.client(), "GET", "/api/frequent?program=claude", nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated: status %d, want 401", resp.StatusCode)
	}

	c := h.client()
	h.pair(c).Body.Close()
	get := func(program string) []string {
		t.Helper()
		resp := h.do(c, "GET", "/api/frequent?program="+program, nil)
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
	if got, want := get("claude"), []string{"/clear", "继续"}; !slices.Equal(got, want) {
		t.Fatalf("claude: %q, want %q", got, want)
	}
	if got, want := get("shell"), []string{"make test", "git status"}; !slices.Equal(got, want) {
		t.Fatalf("shell (bash): %q, want %q", got, want)
	}
	if got := get("codex"); len(got) != 0 {
		t.Fatalf("codex without a history file: %q, want []", got)
	}
	if got := get("other"); len(got) != 0 {
		t.Fatalf("other: %q, want []", got)
	}
}
