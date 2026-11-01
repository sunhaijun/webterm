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

// 快照写进 memfd 再读回来，一个字段都不能变。
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
		t.Fatalf("顶层字段变了: %+v", got)
	}
	if len(got.Sessions) != 2 || string(got.Sessions[0].RingData) != "hello\x1b[0m" || got.Sessions[0].InAck["tab"] != 10 {
		t.Fatalf("会话字段变了: %+v", got.Sessions)
	}
	if string(got.Sessions[0].VTerm) != `{"width":80}` {
		t.Fatalf("模拟器状态变了: %q", got.Sessions[0].VTerm)
	}
	if got.Sessions[1].ExitCode == nil || *got.Sessions[1].ExitCode != 3 || got.Sessions[1].PtmxFD != -1 {
		t.Fatalf("已退出会话变了: %+v", got.Sessions[1])
	}
	if len(got.Sessions[0].Pending) != 1 || string(got.Sessions[0].Pending[0].Data) != "ls\r" {
		t.Fatalf("待写输入变了: %+v", got.Sessions[0].Pending)
	}
}

func TestValidate(t *testing.T) {
	s := sample()
	if err := Validate(s); err != nil {
		t.Fatal(err)
	}
	s.Schema = Schema + 1
	if err := Validate(s); err == nil {
		t.Fatal("更新的 schema 必须被拒绝 —— 那意味着新二进制比快照旧")
	}
	s = sample()
	s.Sessions[0].PtmxFD = -1
	if err := Validate(s); err == nil {
		t.Fatal("运行中的会话没有 fd 必须被拒绝")
	}
	s = sample()
	s.Sessions = append(s.Sessions, Session{SID: 1, Status: "exited"})
	if err := Validate(s); err == nil {
		t.Fatal("sid 重复必须被拒绝")
	}
}

// 预检：新二进制说 ok 才放行；拒绝 / 输出不对 / 起不来都要在 exec 之前失败。
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
	if err := Check(ok, sample(), 5*time.Second); err != nil {
		t.Fatalf("应当通过: %v", err)
	}
	bad := write("bad", "cat >/dev/null; echo 'schema 太新' >&2; exit 1\n")
	if err := Check(bad, sample(), 5*time.Second); err == nil || !strings.Contains(err.Error(), "schema 太新") {
		t.Fatalf("退出码非零必须失败，并带上它的输出: %v", err)
	}
	weird := write("weird", "cat >/dev/null; echo 'hello'\n")
	if err := Check(weird, sample(), 5*time.Second); err == nil {
		t.Fatal("输出不是 ok schema= 必须失败 —— 可能是个不认识 handoff-check 的老二进制")
	}
	if err := Check(filepath.Join(dir, "missing"), sample(), time.Second); err == nil {
		t.Fatal("二进制不存在必须失败")
	}
	// 卡住的新二进制：到点就失败，不等它（连同它的子进程）自己退
	slow := write("slow", "sleep 10\n")
	start := time.Now()
	if err := Check(slow, sample(), 200*time.Millisecond); err == nil || !strings.Contains(err.Error(), "超时") {
		t.Fatalf("超时必须失败: %v", err)
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("超时之后又等了 %v", d)
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

// 从旧版本（schema 1）升级上来：旧字段被忽略，会话照样解得出来，VTerm 为空 ——
// session 那边据此改用环形缓冲尽力还原模拟器（ADR-0026 §8）。
func TestDecodeSchema1(t *testing.T) {
	const old = `{"schema":1,"generation":3,"from_version":"v0.1.0","instance_id":"abc","next_sid":4,
	"listeners":[],"sessions":[{"sid":2,"ptmx_fd":9,"shell_pid":1234,"rc_path":"/x/rc-2.bash",
	"created_at":"2026-10-01T00:00:00Z","cwd":"/tmp","status":"running","cols":80,"rows":24,
	"integration":"active","prompt_state":"input","hello_seen":true,"last_mark":"2026-10-01T00:00:00Z",
	"last_input":"2026-10-01T00:00:00Z","ring_base":5,"ring_data":"aGk=","osc":{"st":0},
	"modes":{"alt":true},"cur_cmd_at":"0001-01-01T00:00:00Z","unmarked_runs":1}]}`
	s, err := Decode(strings.NewReader(old))
	if err != nil {
		t.Fatalf("schema 1 必须读得出来（老版本升级上来的那一次）: %v", err)
	}
	if len(s.Sessions) != 1 || s.Sessions[0].SID != 2 || string(s.Sessions[0].RingData) != "hi" || s.Sessions[0].VTerm != nil {
		t.Fatalf("解出来的不对: %+v", s.Sessions)
	}
}
