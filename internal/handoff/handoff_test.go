package handoff

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func sample() *Snapshot {
	code := 3
	return &Snapshot{
		Schema: Schema, Generation: 2, FromVersion: "test", InstanceID: "abc", NextSID: 7,
		Listeners: []Listener{{Name: "http", FD: 5}},
		Sessions: []Session{
			{SID: 1, PtmxFD: 9, ShellPID: 1234, CWD: "/tmp", Status: "running", Cols: 80, Rows: 24,
				RingBase: 100, RingData: []byte("hello\x1b[0m"), VTerm: []byte(`{"width":80}`),
				InQueued: map[string]uint64{"tab": 12}, InAck: map[string]uint64{"tab": 10},
				Pending: []PendingInput{{ClientID: "tab", Data: []byte("ls\r")}}},
			{SID: 3, PtmxFD: -1, Status: "exited", ExitCode: &code, RingBase: 0, RingData: []byte("bye")},
		},
	}
}

// A snapshot written to a memfd and read back must be unchanged.
func TestWriteReadRoundTrip(t *testing.T) {
	want := sample()
	f, err := Write(want)
	if err != nil {
		t.Fatal(err)
	}
	got, err := Read(int(f.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	if got.InstanceID != want.InstanceID || got.NextSID != want.NextSID || got.Generation != want.Generation {
		t.Fatalf("top-level fields changed: %+v", got)
	}
	if len(got.Sessions) != 2 || string(got.Sessions[0].RingData) != "hello\x1b[0m" || got.Sessions[0].InAck["tab"] != 10 {
		t.Fatalf("session fields changed: %+v", got.Sessions)
	}
	if string(got.Sessions[0].VTerm) != `{"width":80}` {
		t.Fatalf("emulator state changed: %q", got.Sessions[0].VTerm)
	}
	if got.Sessions[1].ExitCode == nil || *got.Sessions[1].ExitCode != 3 || got.Sessions[1].PtmxFD != -1 {
		t.Fatalf("exited session changed: %+v", got.Sessions[1])
	}
	if len(got.Sessions[0].Pending) != 1 || string(got.Sessions[0].Pending[0].Data) != "ls\r" {
		t.Fatalf("pending input changed: %+v", got.Sessions[0].Pending)
	}
}

func TestValidate(t *testing.T) {
	s := sample()
	if err := Validate(s); err != nil {
		t.Fatal(err)
	}
	s.Schema = Schema + 1
	if err := Validate(s); err == nil {
		t.Fatal("a newer schema must be rejected: the new binary is older than the snapshot")
	}
	s = sample()
	s.Sessions[0].PtmxFD = -1
	if err := Validate(s); err == nil {
		t.Fatal("a running session without an fd must be rejected")
	}
	s = sample()
	s.Sessions = append(s.Sessions, Session{SID: 1, Status: "exited"})
	if err := Validate(s); err == nil {
		t.Fatal("a duplicate sid must be rejected")
	}
}

// The pre-flight check passes only when the new binary says ok. A rejection,
// unexpected output, or a binary that won't start must all fail before exec.
func TestCheck(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
			t.Fatal(err)
		}
		return p
	}
	ok := write("ok", "cat >/dev/null; echo '"+CheckOutput()+"'\n")
	if err := Check(ok, []string{"serve"}, sample(), 5*time.Second); err != nil {
		t.Fatalf("should pass: %v", err)
	}
	bad := write("bad", "cat >/dev/null; echo 'schema too new' >&2; exit 1\n")
	if err := Check(bad, []string{"serve"}, sample(), 5*time.Second); err == nil || !strings.Contains(err.Error(), "schema too new") {
		t.Fatalf("a non-zero exit must fail and include its output: %v", err)
	}
	weird := write("weird", "cat >/dev/null; echo 'hello'\n")
	if err := Check(weird, []string{"serve"}, sample(), 5*time.Second); err == nil {
		t.Fatal("output other than ok schema= must fail (likely an old binary without handoff-check)")
	}
	if err := Check(filepath.Join(dir, "missing"), []string{"serve"}, sample(), time.Second); err == nil {
		t.Fatal("a missing binary must fail")
	}
	// The new process's serve arguments reach handoff-check, which rejects
	// what the new binary can't start with (ADR-0047 §1).
	args := write("args", `cat >/dev/null; [ "$*" = "handoff-check serve --domain new.example.com" ] && echo '`+CheckOutput()+`' || { echo "got: $*" >&2; exit 1; }`+"\n")
	if err := Check(args, []string{"serve", "--domain", "new.example.com"}, sample(), 5*time.Second); err != nil {
		t.Fatalf("serve arguments not passed to handoff-check: %v", err)
	}
	// A hung new binary fails at the deadline without waiting for it (or its
	// children) to exit.
	slow := write("slow", "sleep 10\n")
	start := time.Now()
	if err := Check(slow, []string{"serve"}, sample(), 200*time.Millisecond); err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("a timeout must fail: %v", err)
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("kept waiting %v after the timeout", d)
	}
}

func TestStripFlag(t *testing.T) {
	in := []string{"--dev", "--handoff-fd=7", "--http-port", "8080", "--handoff-fd", "9",
		"-handoff-fd=7", "-handoff-fd", "3", "--domain", "x"}
	got := StripFlag(in)
	want := []string{"--dev", "--http-port", "8080", "--domain", "x"}
	if len(got) != len(want) {
		t.Fatalf("got %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v", got)
		}
	}
}

// Upgrading from schema 1: old fields are ignored, sessions still decode, and
// VTerm is empty, which tells the session package to rebuild the emulator
// best-effort from the ring buffer (ADR-0026 §8).
func TestDecodeSchema1(t *testing.T) {
	const old = `{"schema":1,"generation":3,"from_version":"v0.1.0","instance_id":"abc","next_sid":4,
	"listeners":[],"sessions":[{"sid":2,"ptmx_fd":9,"shell_pid":1234,"rc_path":"/x/rc-2.bash",
	"created_at":"2026-10-01T00:00:00Z","cwd":"/tmp","status":"running","cols":80,"rows":24,
	"integration":"active","prompt_state":"input","hello_seen":true,"last_mark":"2026-10-01T00:00:00Z",
	"last_input":"2026-10-01T00:00:00Z","ring_base":5,"ring_data":"aGk=","osc":{"st":0},
	"modes":{"alt":true},"cur_cmd_at":"0001-01-01T00:00:00Z","unmarked_runs":1}]}`
	s, err := Decode(strings.NewReader(old))
	if err != nil {
		t.Fatalf("schema 1 must decode (the first upgrade from an old version): %v", err)
	}
	if len(s.Sessions) != 1 || s.Sessions[0].SID != 2 || string(s.Sessions[0].RingData) != "hi" || s.Sessions[0].VTerm != nil {
		t.Fatalf("wrong decode result: %+v", s.Sessions)
	}
}
