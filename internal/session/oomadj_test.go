package session

import (
	"errors"
	"reflect"
	"testing"
)

// fakeOOM replaces reads and writes of /proc/self/oom_score_adj and records
// every write.
type fakeOOM struct {
	cur       int
	readErr   error
	failWrite map[int]bool // writing this value fails
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

// UT-oom-1 (ADR-0034 §3): when the agent is negative, it is at 0 while the
// shell starts and returns to its original value afterward.
func TestUTOOM1_ChildStartsAtZero(t *testing.T) {
	f := &fakeOOM{cur: -900}
	f.install(t)

	var atStart []int
	if err := withChildOOMAdj(func() error { atStart = append(atStart, f.cur); return nil }); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(atStart, []int{0}) {
		t.Errorf("agent value while starting the shell = %v, want [0] (the child inherits it at fork)", atStart)
	}
	if !reflect.DeepEqual(f.writes, []int{0, -900}) {
		t.Errorf("writes = %v, want [0 -900]", f.writes)
	}
	if f.cur != -900 {
		t.Errorf("agent after start = %d, want -900", f.cur)
	}
}

// self >= 0 (manual webterm serve, or 200 for the user service): the child
// inherits as usual and nothing is written.
func TestUTOOM1_NonNegativeSelfUntouched(t *testing.T) {
	for _, self := range []int{0, 100, 200} {
		f := &fakeOOM{cur: self}
		f.install(t)
		called := 0
		if err := withChildOOMAdj(func() error { called++; return nil }); err != nil {
			t.Fatal(err)
		}
		if called != 1 || len(f.writes) != 0 {
			t.Errorf("self=%d: start called %d times, writes %v; want 1 call, no writes", self, called, f.writes)
		}
	}
}

// Read fails (no /proc): start the shell anyway, write nothing.
func TestUTOOM1_ReadErrorStillStarts(t *testing.T) {
	f := &fakeOOM{cur: -900, readErr: errors.New("no /proc")}
	f.install(t)
	called := 0
	if err := withChildOOMAdj(func() error { called++; return nil }); err != nil {
		t.Fatal(err)
	}
	if called != 1 || len(f.writes) != 0 {
		t.Errorf("start called %d times, writes %v; want 1 call, no writes", called, f.writes)
	}
}

// Writing 0 fails: start the shell anyway (the child inherits -900, degraded
// but not blocking) and don't try to restore.
func TestUTOOM1_RaiseFailsStillStarts(t *testing.T) {
	f := &fakeOOM{cur: -900, failWrite: map[int]bool{0: true}}
	f.install(t)
	called := 0
	if err := withChildOOMAdj(func() error { called++; return nil }); err != nil {
		t.Fatal(err)
	}
	if called != 1 {
		t.Errorf("start called %d times, want 1", called)
	}
	if !reflect.DeepEqual(f.writes, []int{0}) {
		t.Errorf("writes = %v, want a single attempt [0]", f.writes)
	}
}

// Restore fails: log only; it is not a shell start failure, since the shell is
// already running.
func TestUTOOM1_RestoreFailsNotAnError(t *testing.T) {
	f := &fakeOOM{cur: -900, failWrite: map[int]bool{-900: true}}
	f.install(t)
	if err := withChildOOMAdj(func() error { return nil }); err != nil {
		t.Fatalf("restore failure was treated as an error: %v", err)
	}
	if f.cur != 0 {
		t.Errorf("agent = %d, want it left at 0", f.cur)
	}
}

// Shell start fails: the error is returned as is and the value is still
// restored.
func TestUTOOM1_StartErrorStillRestores(t *testing.T) {
	f := &fakeOOM{cur: -900}
	f.install(t)
	boom := errors.New("pty start failed")
	if err := withChildOOMAdj(func() error { return boom }); !errors.Is(err, boom) {
		t.Fatalf("err = %v, want %v", err, boom)
	}
	if f.cur != -900 {
		t.Errorf("agent = %d, want restored to -900", f.cur)
	}
}
