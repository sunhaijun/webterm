package session

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/sunhaijun/webterm/internal/handoff"
	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/ringbuf"
	"github.com/sunhaijun/webterm/internal/vterm"
)

const (
	ptyReadBuf = 32 << 10
	// killGrace is the grace period between SIGHUP and SIGKILL.
	killGrace = 2 * time.Second
	// drainGrace bounds how long to wait, after the shell exits, for readLoop to
	// hit EOF. A background process holding the PTY slave keeps EOF from
	// arriving, so the exit is announced anyway when it expires.
	drainGrace = 500 * time.Millisecond
	// maxDim is the upper bound for cols and rows.
	maxDim = 1000
)

var (
	ErrInputGap       = errors.New("session: gap in input sequence")
	ErrSessionExited  = errors.New("session: session has exited")
	ErrUnknownSession = errors.New("session: no such session")
	ErrBadSize        = errors.New("session: cols/rows must be in 1..1000")
)

// Session is a PTY, the shell running on it, an output ring buffer, and a
// terminal emulator.
//
// Sessions do not survive an agent restart (ADR-0003) but do survive a hot
// upgrade (ADR-0016): the in-place exec hands the ptmx fd and shell process to
// the new process, and state travels through export / restore. When adding a
// field, decide whether it must be handed over (handoff.Session is the list).
type Session struct {
	mgr *Manager
	sid uint16
	// ptmx is a pollable master: dup'ed, set O_NONBLOCK, wrapped with
	// os.NewFile. SetReadDeadline works only on pollable files, and the
	// hot-upgrade freeze relies on it to interrupt blocked reads. Never call
	// Fd() on it; that switches it back to blocking mode (see winsize.go). The
	// raw fd is kept separately.
	ptmx      *os.File
	fd        int
	proc      *os.Process // the shell; handed-over sessions reattach via os.FindProcess
	createdAt time.Time
	// winMu orders size changes end to end: the emulator update under mu and
	// the TIOCSWINSZ after it. Without it two resizes could reach the emulator
	// as A, B and the PTY as B, A, leaving the program drawing for the wrong
	// size. Taken before mu, never while holding it.
	winMu sync.Mutex

	mu         sync.RWMutex // guards all fields below
	name       string
	nameManual bool
	// Terminal title as automatic name (ADR-0043): title is the one in use
	// (sanitized, "" = none), titlePgrp is the foreground process group when
	// it was last written, and titleSeen is the write count seen by the last
	// poll. title and titlePgrp are handed over; titleSeen restarts with the
	// imported emulator.
	title      string
	titlePgrp  int
	titleSeen  uint64
	cwd        string
	status     string
	exitCode   *int
	cols, rows uint16
	// ring and term are updated with the same bytes under the same lock, so
	// the bytes the emulator has consumed always equal ring.HeadSeq(), which a
	// snapshot uses as its seq (ADR-0026 §1).
	ring *ringbuf.Buffer
	term *vterm.Terminal
	subs map[Subscriber]struct{}
	// inQueued and inAck are kept per client_id and survive reconnects
	// (protocol §5.4). inQueued counts bytes accepted into the queue (for seq
	// continuity checks); inAck counts bytes actually written to the PTY (for
	// acks and the resend point after a reconnect).
	inQueued map[string]uint64
	inAck    map[string]uint64

	inputQ    *inputQueue
	done      chan struct{}
	readDone  chan struct{} // closed when readLoop exits (EOF / EIO)
	closeOnce sync.Once

	// Hot-upgrade freeze (ADR-0016); see freeze.go.
	fz         freezer
	readAlive  atomic.Bool
	writeAlive atomic.Bool
}

// SID returns the session id.
func (s *Session) SID() uint16 { return s.sid }

// Info returns session metadata (welcome.sessions[] / session.created).
func (s *Session) Info() protocol.SessionInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return protocol.SessionInfo{
		SID:          s.sid,
		Name:         s.displayNameLocked(),
		NameIsManual: s.nameManual,
		CWD:          s.cwd,
		Status:       s.status,
		ExitCode:     s.exitCode,
		Cols:         s.cols,
		Rows:         s.rows,
		BaseSeq:      s.ring.BaseSeq(),
		HeadSeq:      s.ring.HeadSeq(),
		CreatedAt:    s.createdAt.UnixMilli(),
	}
}

// displayNameLocked implements automatic naming (AC-4.4): manual name, then the
// terminal title set by the foreground program (ADR-0043), then the CWD
// basename. Duplicates are not disambiguated; two sessions in the same
// directory should share a name.
func (s *Session) displayNameLocked() string {
	if s.nameManual {
		return s.name
	}
	if s.title != "" {
		return s.title
	}
	if s.cwd == "" {
		return "shell"
	}
	if home, err := os.UserHomeDir(); err == nil && s.cwd == home {
		return "~"
	}
	if b := filepath.Base(s.cwd); b != "" && b != "/" && b != "." {
		return b
	}
	return "/"
}

// Status returns the session status.
func (s *Session) Status() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.status
}

// HeadSeq returns the total PTY output bytes of the session.
func (s *Session) HeadSeq() uint64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.ring.HeadSeq()
}

// InAck returns how many of a client's input bytes have been written to the
// PTY.
func (s *Session) InAck(clientID string) uint64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.inAck[clientID]
}

// TermSnapshot returns a snapshot and its seq (head_seq), for tests and
// debugging. On the protocol path snapshots go out only through Subscribe and
// Resize.
func (s *Session) TermSnapshot() (seq uint64, data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ring.HeadSeq(), s.term.Snapshot()
}

// Rename sets a manual name. nil restores automatic naming (terminal title /
// CWD).
func (s *Session) Rename(name *string) {
	s.mu.Lock()
	if name == nil || *name == "" {
		s.nameManual = false
		s.name = ""
	} else {
		s.nameManual = true
		s.name = *name
	}
	msg := &protocol.SessionUpdated{
		SID:          s.sid,
		Name:         strPtr(s.displayNameLocked()),
		NameIsManual: boolPtr(s.nameManual),
	}
	s.mu.Unlock()
	s.emit(msg)
}

func validSize(cols, rows uint16) bool {
	return cols > 0 && rows > 0 && cols <= maxDim && rows <= maxDim
}

// Resize changes the terminal size (protocol §4.1 resize).
//
//	Columns changed: under the lock, resize the emulator, take a snapshot
//	    (seq = head_seq), and push it to every subscriber; TIOCSWINSZ outside
//	    the lock. Agent and browser reflow differently; the agent wins
//	    (ADR-0026 §4).
//	Rows only: resize the emulator and TIOCSWINSZ, no snapshot. Phones change
//	    rows every time the on-screen keyboard opens; resending hundreds of
//	    KiB and resetting the browser's scrollback each time costs too much.
func (s *Session) Resize(cols, rows uint16) error {
	if !validSize(cols, rows) {
		return ErrBadSize
	}
	s.winMu.Lock()
	defer s.winMu.Unlock()
	s.mu.Lock()
	changed := s.applySizeLocked(cols, rows, nil)
	running := s.status == protocol.StatusRunning
	s.mu.Unlock()
	if changed && running {
		// Outside the lock and after enqueueing, so bytes redrawn on SIGWINCH
		// always follow the snapshot.
		return setWinsize(s.ptmx, cols, rows)
	}
	return nil
}

// applySizeLocked applies the size to the emulator and reports whether it
// changed. The caller holds the write lock.
//
// If the column count changed, it pushes a snapshot to every subscriber and to
// extra (a new subscriber not yet in the set). The caller does TIOCSWINSZ
// outside the lock.
func (s *Session) applySizeLocked(cols, rows uint16, extra Subscriber) bool {
	if cols == s.cols && rows == s.rows {
		return false
	}
	colsChanged := cols != s.cols
	s.cols, s.rows = cols, rows
	s.term.Resize(int(cols), int(rows))
	if colsChanged {
		seq, snap := s.ring.HeadSeq(), s.term.Snapshot()
		for sub := range s.subs {
			sub.Snapshot(s.sid, seq, snap)
		}
		if extra != nil {
			if _, already := s.subs[extra]; !already {
				extra.Snapshot(s.sid, seq, snap)
			}
		}
	}
	return true
}

// ---------- subscriptions ----------

// Subscribe adds sub to the subscriber set and fills in the output it is
// missing, per protocol §5.1:
//
//	cols differ from the session's        -> resize emulator, snapshot to every subscriber
//	outSeq > 0 and base <= outSeq <= head -> incremental: push raw bytes [outSeq, head)
//	otherwise (outSeq 0, out of window, ahead of head) -> snapshot
//
// It returns the path taken (protocol.ResumeOK / ResumeSnapshot) and from_seq
// (outSeq for incremental, the snapshot's seq for snapshot). cols/rows that
// are 0 or out of range keep the session's size; hello.resume carries no size.
//
// Deciding, pushing, and joining the set happen under one lock. Done
// separately, output arriving in between would be sent twice or not at all,
// and per protocol §3 a client closes the connection on a gap. Push is
// non-blocking by contract, so this never stalls PTY reads.
//
// TIOCSWINSZ for a size change happens outside the lock, after enqueueing, so
// bytes a program redraws on SIGWINCH always follow the snapshot or delta.
// In the other order they would land before the snapshot and the client would
// miss that screen (protocol §4.1).
func (s *Session) Subscribe(sub Subscriber, outSeq uint64, cols, rows uint16) (status string, fromSeq uint64) {
	s.winMu.Lock()
	defer s.winMu.Unlock()
	s.mu.Lock()
	resized, colsChanged := false, false
	if validSize(cols, rows) {
		colsChanged = cols != s.cols
		// On a column change this pushes the snapshot to every subscriber,
		// sub included.
		resized = s.applySizeLocked(cols, rows, sub)
	}
	if colsChanged {
		status, fromSeq = protocol.ResumeSnapshot, s.ring.HeadSeq()
	} else {
		var data []byte
		ok := false
		if outSeq > 0 {
			data, ok = s.ring.Slice(outSeq)
		}
		if ok {
			status, fromSeq = protocol.ResumeOK, outSeq
			if len(data) > 0 {
				sub.Push(s.sid, outSeq, data)
			}
		} else {
			status, fromSeq = protocol.ResumeSnapshot, s.ring.HeadSeq()
			sub.Snapshot(s.sid, fromSeq, s.term.Snapshot())
		}
	}
	s.subs[sub] = struct{}{}
	running := s.status == protocol.StatusRunning
	s.mu.Unlock()

	if resized && running {
		_ = setWinsize(s.ptmx, cols, rows)
	}
	return status, fromSeq
}

// Unsubscribe removes sub from the subscriber set. The session keeps running
// and feeding its emulator.
func (s *Session) Unsubscribe(sub Subscriber) {
	s.mu.Lock()
	delete(s.subs, sub)
	s.mu.Unlock()
}

// DetachClient is called when a connection drops. It discards the client's
// input that was queued but not yet written to the PTY.
//
// Those bytes were never acked, so the client still holds them as pending and
// resends from in_ack after reconnecting. Keeping them would write them twice.
//
// Accounting subtracts only the dropped bytes rather than resetting to
// in_ack: the chunk writeLoop has already taken and is writing (which can
// block for a long time when the PTY input buffer is full) still counts as
// accepted, so the resend skips it as a duplicate instead of writing it twice.
//
// Dropping and subtracting happen under mu, like Write's accept-and-enqueue,
// so export never sees the count and the queue disagree.
func (s *Session) DetachClient(clientID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if dropped := s.inputQ.dropClient(clientID); dropped > 0 {
		s.inQueued[clientID] -= uint64(dropped)
	}
}

// ---------- input ----------

// Write accepts the payload of an INPUT frame.
//
// seq check (protocol §3; in_ack is per (client_id, sid)):
//
//	seq == accepted bytes -> normal
//	seq <  accepted bytes -> resend of processed data; drop the duplicate prefix (normal on reconnect)
//	seq >  accepted bytes -> gap: ErrInputGap, caller closes the connection
func (s *Session) Write(clientID string, seq uint64, data []byte) error {
	s.mu.Lock()
	if s.status == protocol.StatusExited {
		s.mu.Unlock()
		return ErrSessionExited
	}
	queued := s.inQueued[clientID]
	if seq == 0 && queued > 0 {
		// The client reset in_seq while we still hold its accounting. A normal
		// reconnect looks different: the client trims to in_ack and resends
		// from there (protocol §5.4). Treat it as a resend anyway, but the drop
		// is invisible in the browser (ADR-0020 item 5), so log it loudly.
		slog.Warn("input in_seq restarted at 0 but this client_id already has accounting; dropping the overlap as a resend (protocol §5.4)",
			"sid", s.sid, "client", clientID, "accepted", queued, "len", len(data))
	}
	switch {
	case seq > queued:
		s.mu.Unlock()
		return ErrInputGap
	case seq < queued:
		skip := queued - seq
		if skip >= uint64(len(data)) {
			s.mu.Unlock() // the whole chunk is an already-processed resend
			return nil
		}
		data = data[skip:]
	}
	// Count and enqueue under one lock (push never blocks). Apart, a handoff
	// export in between would carry a count that includes bytes missing from
	// its queue; the new process would then skip their resend as a duplicate
	// and they would never reach the PTY.
	cp := make([]byte, len(data))
	copy(cp, data)
	if err := s.inputQ.push(clientID, cp); err != nil {
		s.mu.Unlock()
		return err
	}
	s.inQueued[clientID] = queued + uint64(len(data))
	s.mu.Unlock()
	return nil
}

// ---------- goroutines ----------

// consume handles one PTY read: append to the ring buffer, feed the emulator,
// push to subscribers.
//
// The agent never rewrites the output stream; seq is the cumulative PTY output
// byte count (ADR-0026 §2).
//
// Pushing happens under the lock too. Push is non-blocking by contract, so the
// cost is a few enqueues, and in exchange every frame of a session (live
// output, subscribe catch-up, column-change snapshots) enters each connection's
// write queue in lock order. Outside the lock, output already included in a
// snapshot could reach the client after that snapshot, breaking seq
// continuity (protocol §3).
func (s *Session) consume(chunk []byte) {
	if len(chunk) == 0 {
		return
	}
	// Copy: chunk is readLoop's reused buffer and subscriber write queues keep
	// a reference.
	data := make([]byte, len(chunk))
	copy(data, chunk)

	s.mu.Lock()
	seq := s.ring.Append(data)
	s.term.Write(data)
	for sub := range s.subs {
		sub.Push(s.sid, seq, data)
	}
	s.mu.Unlock()

	// Unsubscribed connections derive unread state from head_seq. The
	// connection layer throttles this to 1s and drops it for subscribers.
	head := seq + uint64(len(data))
	s.emit(&protocol.SessionUpdated{SID: s.sid, HeadSeq: &head})
}

// startLoops starts the four goroutines. The alive flags are set before the go
// statements because freeze counts them to know how many loops to wait for.
func (s *Session) startLoops() {
	s.readAlive.Store(true)
	s.writeAlive.Store(true)
	go s.readLoop()
	go s.writeLoop()
	go s.waitLoop()
	go s.cwdLoop(s.mgr.cfg.CWDPollInterval)
}

func (s *Session) readLoop() {
	defer func() {
		s.fz.exiting()
		s.readAlive.Store(false)
		close(s.readDone)
	}()
	buf := make([]byte, ptyReadBuf)
	for {
		n, err := s.ptmx.Read(buf)
		if n > 0 {
			s.consume(buf[:n])
		}
		if err != nil {
			if errors.Is(err, os.ErrDeadlineExceeded) {
				// Hot-upgrade freeze: only freeze sets a deadline. Park here, with
				// consume finished so ring, emulator, and out_seq agree, and
				// resume reading after thaw.
				s.fz.park()
				continue
			}
			return // EIO: the shell exited
		}
	}
}

// writeLoop takes input from the queue, writes it to the PTY, and updates
// in_ack.
func (s *Session) writeLoop() {
	defer func() {
		s.fz.exiting()
		s.writeAlive.Store(false)
	}()
	for {
		// Park before pop: queued input goes into the handoff snapshot as is,
		// and inAck matches the bytes written.
		s.fz.park()
		it, ok := s.inputQ.pop()
		if !ok {
			select {
			case <-s.inputQ.notify:
				continue
			case <-s.fz.wake:
				continue // go park
			case <-s.done:
				return
			}
		}
		n, err := s.ptmx.Write(it.data)
		if n > 0 {
			s.mu.Lock()
			s.inAck[it.clientID] += uint64(n)
			ack := s.inAck[it.clientID]
			s.mu.Unlock()
			// Acks go only to the same client; accounting is per client.
			s.emitTo(it.clientID, &protocol.Ack{SID: s.sid, InAck: ack})
		}
		if err != nil {
			if errors.Is(err, os.ErrDeadlineExceeded) {
				// The freeze interrupted a write (the foreground program isn't
				// reading stdin and the PTY input buffer is full). Put the
				// unwritten rest back at the head of the queue so it travels with
				// the snapshot, neither lost nor duplicated.
				if n < len(it.data) {
					s.inputQ.pushFront(inputItem{clientID: it.clientID, data: it.data[n:]})
				}
				continue
			}
			return
		}
	}
}

// waitLoop waits for the shell to exit and records the exited status and
// exit code.
//
// It first lets readLoop drain the PTY. When the shell exits, the kernel often
// still holds its last lines of output; announcing the exit first would queue
// those OUTPUT frames behind it, and the frontend's "process exited" line
// would appear above them. EOF (EIO) means every slave fd is closed and the
// output is drained. A background process holding the slave keeps EOF from
// arriving, so the wait is capped at drainGrace.
//
// The session.updated carries head_seq at that moment, so the client knows how
// much output precedes the exit; it matches the end of the last OUTPUT frame.
func (s *Session) waitLoop() {
	// Use *os.Process rather than exec.Cmd.Wait: a handed-over session has only
	// a pid (os.FindProcess). Since exec keeps the PID, the shell is still our
	// child and Wait returns its exit code as usual.
	st, err := s.proc.Wait()
	code := -1
	if err == nil && st != nil {
		code = st.ExitCode() // -1 when killed by a signal
	}

	select {
	case <-s.readDone:
	case <-time.After(drainGrace):
	}

	s.mu.Lock()
	s.status = protocol.StatusExited
	s.exitCode = &code
	head := s.ring.HeadSeq()
	s.mu.Unlock()

	s.inputQ.close() // stop accepting input
	close(s.done)

	s.emit(&protocol.SessionUpdated{
		SID:      s.sid,
		Status:   strPtr(protocol.StatusExited),
		ExitCode: &code,
		HeadSeq:  &head,
	})
	// Keep the ring and emulator: after a failed build the user must be able to
	// scroll back to the error (AC-4.5), and switching back or reloading still
	// gets a snapshot.
}

// emit sends a control message to every connection, not just subscribers.
//
// Unsubscribed connections need session.updated too, for session names and
// unread dots. Subscribing only controls OUTPUT / SNAPSHOT frames.
func (s *Session) emit(msg any) {
	if s.mgr != nil {
		s.mgr.fanout(msg)
	}
}

// emitTo sends a message only to one client's connections.
func (s *Session) emitTo(clientID string, msg any) {
	if s.mgr != nil {
		s.mgr.fanoutTo(clientID, msg)
	}
}

// ---------- close ----------

// close ends the session: SIGHUP, wait 2 seconds, then SIGKILL.
//
// The graceful path sends SIGHUP to the shell's process group and lets bash
// forward it to all its jobs. An interactive shell runs with job control, so
// each job has its own process group that kill(-pgid) does not reach.
//
// The fallback (not gone within the grace period) must sweep the whole
// session: bash no longer gets a chance to forward, and unswept jobs would
// keep running as orphans. See killSession, which spares processes that
// ignore SIGHUP: that is what nohup does, and it is the user asking for the
// process to outlive the terminal.
//
// A session closed during a hot-upgrade freeze is thawed at the end: it is no
// longer listed, so the manager's Thaw would never release its loops.
func (s *Session) close() {
	s.closeOnce.Do(func() {
		if s.Status() == protocol.StatusRunning && s.proc != nil {
			pid := s.proc.Pid
			_ = syscall.Kill(-pid, syscall.SIGHUP)
			select {
			case <-s.done:
			case <-time.After(killGrace):
				killSession(pid, syscall.SIGKILL)
				_ = syscall.Kill(-pid, syscall.SIGKILL)
				select {
				case <-s.done:
				case <-time.After(killGrace):
				}
			}
			// Sweep again after the shell exits. This is the last line of
			// defense for jobs that survived the forwarded SIGHUP (programs
			// that ignore it).
			killSession(pid, syscall.SIGKILL)
		}
		if s.ptmx != nil {
			s.ptmx.Close()
		}
		s.inputQ.close()
		s.mu.Lock()
		s.subs = map[Subscriber]struct{}{}
		s.mu.Unlock()
		s.thaw()
	})
}

// export captures the session's handoff state (ADR-0016 / ADR-0026 §8). It must
// be called after freeze, when readLoop has stopped and the ring and emulator
// no longer change.
//
// The ptmx handed over is a dup with a new fd number and CLOEXEC cleared. The
// session's own fd is untouched, so an aborted handoff needs no undo, and an
// in-process restore (tests) doesn't collide with the fd already registered
// in epoll.
func (s *Session) export() (handoff.Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	base, data := s.ring.Export()
	vt, err := s.term.Export()
	if err != nil {
		return handoff.Session{}, fmt.Errorf("session %d: export emulator state: %w", s.sid, err)
	}
	h := handoff.Session{
		SID: s.sid, PtmxFD: -1, CreatedAt: s.createdAt,
		Name: s.name, NameManual: s.nameManual, Title: s.title, TitlePgrp: s.titlePgrp,
		CWD: s.cwd, Status: s.status, ExitCode: s.exitCode,
		Cols: s.cols, Rows: s.rows,
		RingBase: base, RingData: data,
		VTerm:    vt,
		InQueued: cloneCounts(s.inQueued), InAck: cloneCounts(s.inAck),
		Pending: s.inputQ.snapshot(),
	}
	if s.status == protocol.StatusRunning {
		nfd, err := unix.Dup(s.fd)
		if err != nil {
			return h, fmt.Errorf("session %d: dup ptmx: %w", s.sid, err)
		}
		if err := handoff.Inherit(nfd); err != nil {
			unix.Close(nfd)
			return h, err
		}
		h.PtmxFD = nfd
		if s.proc != nil {
			h.ShellPID = s.proc.Pid
		}
	}
	return h, nil
}

func cloneCounts(m map[string]uint64) map[string]uint64 {
	out := make(map[string]uint64, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func strPtr(s string) *string { return &s }
func boolPtr(b bool) *bool    { return &b }
