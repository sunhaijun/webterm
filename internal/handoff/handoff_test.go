package handoff

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/oscparse"
)

func sample() *Snapshot {
	code := 3
	id := int64(42)
	return &Snapshot{
		Schema: Schema, Generation: 2, FromVersion: "test", InstanceID: "abc", NextSID: 7,
		Listeners: []Listener{{Name: "http", FD: 5}},
		Sessions: []Session{
			{SID: 1, PtmxFD: 9, ShellPID: 1234, CWD: "/tmp", Status: "running", Cols: 80, Rows: 24,
				Integration: "active", PromptState: "running", RingBase: 100, RingData: []byte("hello\x1b[0m"),
				InQueued: map[string]uint64{"tab": 12}, InAck: map[string]uint64{"tab": 10},
				OSC:      oscparse.State{St: 3, ID: []byte("133"), Pay: []byte("C")},
				CurCmdID: &id, Pending: []PendingInput{{ClientID: "tab", Data: []byte("ls\r")}}},
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
	if got.Sessions[0].OSC.St != 3 || string(got.Sessions[0].OSC.Pay) != "C" {
		t.Fatalf("OSC 中间态变了: %+v", got.Sessions[0].OSC)
	}
	if got.Sessions[1].ExitCode == nil || *got.Sessions[1].ExitCode != 3 || got.Sessions[1].PtmxFD != -1 {
		t.Fatalf("已退出会话变了: %+v", got.Sessions[1])
	}
	if len(got.Sessions[0].Pending) != 1 || string(got.Sessions[0].Pending[0].Data) != "ls\r" {
		t.Fatalf("待写输入变了: %+v", got.Sessions[0].Pending)
	}
}

// Meta 不带缓冲与待写输入，其余照旧 —— 预检不用搬几十 MiB。
func TestMetaDropsBulk(t *testing.T) {
	m := sample().Meta()
	if m.Sessions[0].RingData != nil || m.Sessions[0].Pending != nil {
		t.Fatal("Meta 应当去掉 RingData 与 Pending")
	}
	if m.Sessions[0].RingBase != 100 || m.InstanceID != "abc" {
		t.Fatal("Meta 不该动其它字段")
	}
	if sample().Sessions[0].RingData == nil {
		t.Fatal("Meta 不能改到原快照")
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
	if err := Check(ok, sample().Meta(), 5*time.Second); err != nil {
		t.Fatalf("应当通过: %v", err)
	}
	bad := write("bad", "cat >/dev/null; echo 'schema 太新' >&2; exit 1\n")
	if err := Check(bad, sample().Meta(), 5*time.Second); err == nil {
		t.Fatal("退出码非零必须失败")
	}
	weird := write("weird", "cat >/dev/null; echo 'hello'\n")
	if err := Check(weird, sample().Meta(), 5*time.Second); err == nil {
		t.Fatal("输出不是 ok schema= 必须失败 —— 可能是个不认识 handoff-check 的老二进制")
	}
	if err := Check(filepath.Join(dir, "missing"), sample().Meta(), time.Second); err == nil {
		t.Fatal("二进制不存在必须失败")
	}
}

func TestStripFlag(t *testing.T) {
	in := []string{"--dev", "--handoff-fd=7", "--http-port", "8080", "--handoff-fd", "9", "--domain", "x"}
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
