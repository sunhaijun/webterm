package agent

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/session"
	"github.com/sunhaijun/webterm/internal/store"
)

// IT-transcript-4：跟踪起来之后，/api/transcript 回放已到的条目（转录服务挂在 agent 上）。
func TestTranscriptSnapshotRoundTrip(t *testing.T) {
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	mgr := session.NewManager(session.Config{}, st)
	defer mgr.Shutdown()
	home := t.TempDir()
	a := New(Config{TranscriptHome: home}, st, mgr)

	file := filepath.Join(home, ".claude", "projects", "-home-sun", "s.jsonl")
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(`{"type":"user","uuid":"u1","message":{"role":"user","content":"hi"}}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	a.transcripts.CommandStarted(5, "claude", "/home/sun")
	deadline := time.Now().Add(5 * time.Second)
	for {
		snap, ok := a.transcripts.Snapshot(5)
		if ok && len(snap.Items) == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("超时等待条目：%+v ok=%v", snap, ok)
		}
		time.Sleep(20 * time.Millisecond)
	}
	rr := httptest.NewRecorder()
	a.handleTranscript(rr, httptest.NewRequest(http.MethodGet, "/api/transcript?sid=5", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rr.Code, rr.Body.String())
	}
	var body struct {
		SID    int    `json:"sid"`
		Source string `json:"source"`
		Active bool   `json:"active"`
		Items  []struct {
			Role string `json:"role"`
			Text string `json:"text"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.SID != 5 || body.Source != "claude" || !body.Active || len(body.Items) != 1 || body.Items[0].Text != "hi" {
		t.Fatalf("body = %+v", body)
	}
	a.transcripts.SessionClosed(5)
}
