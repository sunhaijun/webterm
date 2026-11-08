package agent_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/agent"
)

type stripReply struct {
	Program string `json:"program"`
	Items   []struct {
		ID     string   `json:"id"`
		Label  string   `json:"label"`
		Kind   string   `json:"kind"`
		Send   []string `json:"send"`
		Hidden bool     `json:"hidden"`
	} `json:"items"`
	Arrangement struct {
		Order []string `json:"order"`
	} `json:"arrangement"`
	Warning string `json:"warning"`
}

func (r stripReply) ids() []string {
	out := make([]string, len(r.Items))
	for i, it := range r.Items {
		out[i] = it.ID
	}
	return out
}

// IT-commands-1 (AC-3.25, ADR-0057 §4–§5): the command strip of the claude in
// front comes from that claude's init message; the arrangement is saved to
// the commands file, shared, and resettable; writes need the Origin check;
// a shell has no strip.
func TestITCommands1(t *testing.T) {
	home, bin := t.TempDir(), t.TempDir()
	cmdFile := filepath.Join(t.TempDir(), "webterm", "commands.json")
	h := newHarness(t, func(c *agent.Config) {
		c.Home = home
		c.CommandsFile = cmdFile
		c.ProbeDir = t.TempDir()
	})
	fake := filepath.Join(bin, "claude")
	initLine := `{"type":"system","subtype":"init","slash_commands":["clear","compact","deep-research"],"skills":["deep-research"]}`
	if err := os.WriteFile(fake, []byte("#!/bin/bash\nif [ \"$1\" = -p ]; then echo '"+initLine+"'; sleep 30; fi\necho FAKE-CLAUDE\nsleep 60\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	resp := h.do(h.client(), "GET", "/api/commands?sid=1", nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated: %d", resp.StatusCode)
	}

	c := h.client()
	h.pair(c).Body.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cl := h.connect(ctx, c, "tab", nil, "")
	cl.welcome()
	sid := cl.createSession(t.TempDir())
	cl.input(sid, "printf 'READY-%s\\n' MARK\r")
	waitFor(t, "session ready", func() bool { return cl.screenHas(sid, "READY-MARK") })

	get := func(q string) stripReply {
		t.Helper()
		resp := h.do(c, "GET", "/api/commands?sid="+strconv.Itoa(int(sid))+q, nil)
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET: %d", resp.StatusCode)
		}
		var r stripReply
		if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
			t.Fatal(err)
		}
		return r
	}

	// A shell has no strip
	if r := get(""); r.Program != "shell" || len(r.Items) != 0 {
		t.Fatalf("shell: %+v", r)
	}

	cl.input(sid, fake+"\r")
	waitFor(t, "fake claude running", func() bool { return cl.screenHas(sid, "FAKE-CLAUDE") })
	var r stripReply
	waitFor(t, "program is claude", func() bool { r = get(""); return r.Program == "claude" })
	if r.Warning != "" {
		t.Fatalf("warning: %s", r.Warning)
	}
	got := r.ids()
	if len(got) == 0 || got[0] != "key:shift-tab" {
		t.Fatalf("keys come first: %v", got)
	}
	has := func(id string) bool {
		for _, x := range got {
			if x == id {
				return true
			}
		}
		return false
	}
	for _, want := range []string{"/clear", "/compact", "/copy", "/resume", "/deep-research"} {
		if !has(want) {
			t.Errorf("missing %s: %v", want, got)
		}
	}
	for _, it := range r.Items {
		if it.ID == "/deep-research" && !it.Hidden {
			t.Error("the skill should start hidden")
		}
	}

	put := func(program, origin string, body string) int {
		t.Helper()
		req, _ := http.NewRequest(http.MethodPut, h.srv.URL+"/api/commands?program="+program, bytes.NewReader([]byte(body)))
		req.Header.Set("Content-Type", "application/json")
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		resp, err := c.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if code := put("claude", "https://evil.example.com", `{"order":["/compact"]}`); code != http.StatusForbidden {
		t.Fatalf("cross-site PUT: %d", code)
	}
	if code := put("shell", "", `{}`); code != http.StatusBadRequest {
		t.Fatalf("PUT for a shell: %d", code)
	}
	if code := put("claude", "", `{"order":["/compact"],"added":[{"id":"add:1","label":"go on","send":"continue","enter":true}]}`); code != http.StatusNoContent {
		t.Fatalf("PUT: %d", code)
	}
	if fi, err := os.Stat(cmdFile); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("commands file: %v %v", fi, err)
	}
	r = get("")
	if got := r.ids(); got[0] != "/compact" || got[len(got)-1] == "" || !contains(got, "add:1") {
		t.Fatalf("after PUT: %v", got)
	}
	if o := r.Arrangement.Order; len(o) != 1 || o[0] != "/compact" {
		t.Fatalf("the reply carries the arrangement: %v", o)
	}

	resp = h.do(c, "DELETE", "/api/commands?program=claude", nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE: %d", resp.StatusCode)
	}
	if got := get("").ids(); got[0] != "key:shift-tab" || contains(got, "add:1") {
		t.Fatalf("after reset: %v", got)
	}

	resp = h.do(c, "GET", "/api/commands?sid=999", nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown sid: %d", resp.StatusCode)
	}
}

func contains(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}
