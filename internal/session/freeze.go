package session

import (
	"fmt"
	"sync"
	"time"
)

// freezer 让一个会话的 readLoop / writeLoop 停在安全点（ADR-0016 热升级交接）。
//
// 两个循环平时阻塞在 ptmx.Read / ptmx.Write 里。冻结时给 ptmx 设一个已过期的
// deadline 把它们打断，循环看到超时错误就来 park 报到、等解冻；解冻先清 deadline
// 再放行，循环回去继续阻塞读写。停在安全点的含义：readLoop 在 consume 之后
// （ring 与 out_seq 一致），writeLoop 在 pop 之前（inAck 与真正写进 PTY 的字节一致），
// 于是 Export 拍到的是一个自洽的切面。
type freezer struct {
	mu     sync.Mutex
	frozen bool
	thaw   chan struct{} // 冻结时新建，解冻时 close
	wake   chan struct{} // cap 1：把 writeLoop 从 select 里叫出来
	parked chan struct{} // 循环停好了（或冻结期间退出了）就发一个
}

func newFreezer() freezer {
	return freezer{wake: make(chan struct{}, 1), parked: make(chan struct{}, 8)}
}

func (f *freezer) isFrozen() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.frozen
}

// park 由循环调用：没冻结直接返回；冻结了就报到并等解冻。
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

// exiting 由循环在退出前调用：冻结期间退出也算"停好了"，否则 freeze 会等到超时。
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

// freeze 停住这个会话的两个循环。timeout 内没停好就解冻并报错。
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
			return fmt.Errorf("session %d: 冻结超时（%d/%d 个循环没停下来）", s.sid, got, need)
		}
	}
	return nil
}

// thaw 放行两个循环。幂等。
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
