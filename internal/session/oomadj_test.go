package session

import (
	"errors"
	"reflect"
	"testing"
)

// fakeOOM 替掉 /proc/self/oom_score_adj 的读写，记下每一次写入。
type fakeOOM struct {
	cur       int
	readErr   error
	failWrite map[int]bool // 写这个值时失败
	writes    []int
}

func (f *fakeOOM) install(t *testing.T) {
	t.Helper()
	oldR, oldW := readOOMAdj, writeOOMAdj
	readOOMAdj = func() (int, error) { return f.cur, f.readErr }
	writeOOMAdj = func(v int) error {
		f.writes = append(f.writes, v)
		if f.failWrite[v] {
			return errors.New("EACCES")
		}
		f.cur = v
		return nil
	}
	t.Cleanup(func() { readOOMAdj, writeOOMAdj = oldR, oldW })
}

// UT-oom-1（ADR-0034 §3）：agent 是负数时，起 shell 的那一下自己是 0，起完回到原值。
func TestUTOOM1_ChildStartsAtZero(t *testing.T) {
	f := &fakeOOM{cur: -900}
	f.install(t)

	var atStart []int
	if err := withChildOOMAdj(func() error { atStart = append(atStart, f.cur); return nil }); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(atStart, []int{0}) {
		t.Errorf("起 shell 时 agent 的值 = %v，want [0]（子进程在 fork 时继承它）", atStart)
	}
	if !reflect.DeepEqual(f.writes, []int{0, -900}) {
		t.Errorf("写入顺序 = %v，want [0 -900]", f.writes)
	}
	if f.cur != -900 {
		t.Errorf("起完之后 agent = %d，want -900", f.cur)
	}
}

// self >= 0（手动 webterm serve、用户服务的 200）：子进程照常继承，一次都不写。
func TestUTOOM1_NonNegativeSelfUntouched(t *testing.T) {
	for _, self := range []int{0, 100, 200} {
		f := &fakeOOM{cur: self}
		f.install(t)
		called := 0
		if err := withChildOOMAdj(func() error { called++; return nil }); err != nil {
			t.Fatal(err)
		}
		if called != 1 || len(f.writes) != 0 {
			t.Errorf("self=%d：start 调了 %d 次、写了 %v，want 1 次、不写", self, called, f.writes)
		}
	}
}

// 读不到（没有 /proc）：照常起 shell，不写。
func TestUTOOM1_ReadErrorStillStarts(t *testing.T) {
	f := &fakeOOM{cur: -900, readErr: errors.New("no /proc")}
	f.install(t)
	called := 0
	if err := withChildOOMAdj(func() error { called++; return nil }); err != nil {
		t.Fatal(err)
	}
	if called != 1 || len(f.writes) != 0 {
		t.Errorf("start 调了 %d 次、写了 %v，want 1 次、不写", called, f.writes)
	}
}

// 写 0 失败：照常起 shell（子进程继承 -900，退化但不挡路），也不去"写回"。
func TestUTOOM1_RaiseFailsStillStarts(t *testing.T) {
	f := &fakeOOM{cur: -900, failWrite: map[int]bool{0: true}}
	f.install(t)
	called := 0
	if err := withChildOOMAdj(func() error { called++; return nil }); err != nil {
		t.Fatal(err)
	}
	if called != 1 {
		t.Errorf("start 调了 %d 次，want 1", called)
	}
	if !reflect.DeepEqual(f.writes, []int{0}) {
		t.Errorf("写入 = %v，want 只试过一次 [0]", f.writes)
	}
}

// 写回失败：只记日志，不当成起 shell 失败 —— shell 已经起来了。
func TestUTOOM1_RestoreFailsNotAnError(t *testing.T) {
	f := &fakeOOM{cur: -900, failWrite: map[int]bool{-900: true}}
	f.install(t)
	if err := withChildOOMAdj(func() error { return nil }); err != nil {
		t.Fatalf("写回失败被当成了错误：%v", err)
	}
	if f.cur != 0 {
		t.Errorf("agent = %d，want 留在 0", f.cur)
	}
}

// 起 shell 失败：错误原样返回，值照样写回。
func TestUTOOM1_StartErrorStillRestores(t *testing.T) {
	f := &fakeOOM{cur: -900}
	f.install(t)
	boom := errors.New("pty 起不来")
	if err := withChildOOMAdj(func() error { return boom }); !errors.Is(err, boom) {
		t.Fatalf("err = %v，want %v", err, boom)
	}
	if f.cur != -900 {
		t.Errorf("agent = %d，want 写回 -900", f.cur)
	}
}
