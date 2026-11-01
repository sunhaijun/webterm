package session

import (
	"fmt"
	"sync"
	"time"
)

// freezer parks a session's readLoop and writeLoop at safe points for a
// hot-upgrade handoff (ADR-0016).
//
// Both loops normally block in ptmx.Read / ptmx.Write. Freezing sets an
// already-expired deadline on ptmx to interrupt them; on the timeout error each
// loop checks in at park and waits for thaw. Thawing clears the deadline before
// releasing them, and they go back to blocking I/O. The safe points are
// readLoop after consume (ring and out_seq agree) and writeLoop before pop
// (inAck matches the bytes actually written to the PTY), so Export captures a
// consistent cut.
type freezer struct {
	mu     sync.Mutex
	frozen bool
	thaw   chan struct{} // created on freeze, closed on thaw
	wake   chan struct{} // cap 1: wakes writeLoop out of its select
	parked chan struct{} // one send per loop that parked (or exited while frozen)
}

func newFreezer() freezer {
	return freezer{wake: make(chan struct{}, 1), parked: make(chan struct{}, 8)}
}

func (f *freezer) isFrozen() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.frozen
}

// park is called by the loops. It returns at once unless frozen; when frozen
// it checks in and waits for thaw.
func (f *freezer) park() {
	f.mu.Lock()
	if !f.frozen {
		f.mu.Unlock()
		return
	}
	ch := f.thaw
	f.mu.Unlock()
	f.parked <- struct{}{}
	<-ch
}

// exiting is called by a loop before it exits. Exiting while frozen counts as
// parked; otherwise freeze would wait until its timeout.
func (f *freezer) exiting() {
	f.mu.Lock()
	frozen := f.frozen
	f.mu.Unlock()
	if frozen {
		select {
		case f.parked <- struct{}{}:
		default:
		}
	}
}

// freeze parks both loops of the session. If they don't park within timeout,
// it thaws and returns an error.
func (s *Session) freeze(timeout time.Duration) error {
	f := &s.fz
	f.mu.Lock()
	if f.frozen {
		f.mu.Unlock()
		return nil
	}
	f.frozen = true
	f.thaw = make(chan struct{})
	for len(f.parked) > 0 {
		<-f.parked
	}
	need := 0
	if s.readAlive.Load() {
		need++
	}
	if s.writeAlive.Load() {
		need++
	}
	f.mu.Unlock()

	if s.ptmx != nil {
		past := time.Now().Add(-time.Second)
		_ = s.ptmx.SetReadDeadline(past)
		_ = s.ptmx.SetWriteDeadline(past)
	}
	select {
	case f.wake <- struct{}{}:
	default:
	}

	deadline := time.After(timeout)
	for got := 0; got < need; {
		select {
		case <-f.parked:
			got++
		case <-deadline:
			s.thaw()
			return fmt.Errorf("session %d: freeze timed out (%d of %d loops parked)", s.sid, got, need)
		}
	}
	return nil
}

// thaw releases both loops. It is idempotent.
func (s *Session) thaw() {
	f := &s.fz
	f.mu.Lock()
	if !f.frozen {
		f.mu.Unlock()
		return
	}
	f.frozen = false
	ch := f.thaw
	f.mu.Unlock()
	if s.ptmx != nil {
		_ = s.ptmx.SetReadDeadline(time.Time{})
		_ = s.ptmx.SetWriteDeadline(time.Time{})
	}
	close(ch)
}
