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
	// 残留的旧 socket 文件不该挡住新进程
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
		t.Fatalf("socket 权限应为 0600，实际 %o", fi.Mode().Perm())
	}

	resp, err := ControlCall(path, ControlRequest{Op: "status"}, time.Second)
	if err != nil || resp.Status == nil || resp.Status.Generation != 3 || resp.Status.Busy != 1 || !resp.Status.Handoff {
		t.Fatalf("status 应答不对: %+v %v", resp, err)
	}
	if _, err := ControlCall(path, ControlRequest{Op: "reexec"}, time.Second); err != nil || reexecs != 1 {
		t.Fatalf("reexec 应当触发一次: %v (n=%d)", err, reexecs)
	}
	if _, err := ControlCall(path, ControlRequest{Op: "bogus"}, time.Second); err == nil {
		t.Fatal("未知操作应当报错")
	}
	cs.Close()
	if _, err := ControlCall(path, ControlRequest{Op: "status"}, 300*time.Millisecond); !errors.Is(err, ErrNoControl) {
		t.Fatalf("关掉之后应当是 ErrNoControl，实际 %v", err)
	}
}
