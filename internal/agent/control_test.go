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
		Reexec: func([]string) error { reexecs++; return nil },
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

// A second agent with the same data directory must not take over a live
// control socket (ADR-0047 §3): that cut the running agent off from reload,
// and the second agent's exit then removed the socket for good.
func TestControlSocketNotStolen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.sock")
	deps := ControlDeps{Status: func() ControlStatus { return ControlStatus{Version: "first", Handoff: true} }}
	first, err := ServeControl(path, deps, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()

	if _, err := ServeControl(path, deps, nil); !errors.Is(err, ErrAgentRunning) {
		t.Fatalf("second ServeControl = %v, want ErrAgentRunning", err)
	}
	if resp, err := ControlCall(path, ControlRequest{Op: "status"}, time.Second); err != nil || resp.Status.Version != "first" {
		t.Fatalf("the running agent lost its control socket: %+v %v", resp, err)
	}
}

// Close removes the socket file only if it is still the one this server
// created: a newer agent may have replaced it.
func TestControlCloseLeavesNewerSocket(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.sock")
	old, err := ServeControl(path, ControlDeps{Status: func() ControlStatus { return ControlStatus{Version: "old"} }}, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(path) // the old one is unreachable now; a new agent starts
	cur, err := ServeControl(path, ControlDeps{Status: func() ControlStatus { return ControlStatus{Version: "new"} }}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cur.Close()

	old.Close()
	if resp, err := ControlCall(path, ControlRequest{Op: "status"}, time.Second); err != nil || resp.Status.Version != "new" {
		t.Fatalf("closing the old server removed the new socket: %+v %v", resp, err)
	}
}
