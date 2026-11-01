package agent

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestControlSocket(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.sock")
	// A stale socket file must not block the new process.
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	reexecs := 0
	cs, err := ServeControl(path, ControlDeps{
		Status: func() ControlStatus {
			return ControlStatus{Version: "t", PID: os.Getpid(), Generation: 3, Sessions: 2, Busy: 1, Handoff: true}
		},
		Reexec: func() error { reexecs++; return nil },
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()
	fi, _ := os.Stat(path)
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("socket mode = %o, want 0600", fi.Mode().Perm())
	}

	resp, err := ControlCall(path, ControlRequest{Op: "status"}, time.Second)
	if err != nil || resp.Status == nil || resp.Status.Generation != 3 || resp.Status.Busy != 1 || !resp.Status.Handoff {
		t.Fatalf("unexpected status reply: %+v %v", resp, err)
	}
	if _, err := ControlCall(path, ControlRequest{Op: "reexec"}, time.Second); err != nil || reexecs != 1 {
		t.Fatalf("reexec should trigger once: %v (n=%d)", err, reexecs)
	}
	if _, err := ControlCall(path, ControlRequest{Op: "bogus"}, time.Second); err == nil {
		t.Fatal("unknown op should fail")
	}
	cs.Close()
	if _, err := ControlCall(path, ControlRequest{Op: "status"}, 300*time.Millisecond); !errors.Is(err, ErrNoControl) {
		t.Fatalf("after Close, want ErrNoControl, got %v", err)
	}
}
