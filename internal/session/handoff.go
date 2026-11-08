package session

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"time"

	"golang.org/x/sys/unix"

	"github.com/sunhaijun/webterm/internal/handoff"
	"github.com/sunhaijun/webterm/internal/protocol"
	"github.com/sunhaijun/webterm/internal/ringbuf"
	"github.com/sunhaijun/webterm/internal/vterm"
)

// Hot-upgrade handoff (ADR-0016): Freeze, Export, exec, Restore; Thaw on
// failure. The flow is described in docs/50-backend/session-manager.md
// (hot-upgrade handoff section).

// Generation returns the hot-upgrade generation: the value the new process read
// from the snapshot, or 0 on first start.
func (m *Manager) Generation() int {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.generation
}

// Freeze parks every session's read and write loops and refuses new sessions.
// If any session fails to park within timeout, everything is thawed and an
// error is returned: the handoff happens in full or not at all.
//
// It waits for Close, Rename and Move in progress to finish and holds them
// off until Thaw (see Manager.handoffMu).
func (m *Manager) Freeze(timeout time.Duration) error {
	m.handoffMu.Lock()
	m.mu.Lock()
	m.frozen = true
	m.mu.Unlock()
	for _, s := range m.List() {
		if err := s.freeze(timeout); err != nil {
			m.Thaw()
			return err
		}
	}
	return nil
}

// Thaw releases all sessions and accepts new ones again. It is idempotent.
func (m *Manager) Thaw() {
	for _, s := range m.List() {
		s.thaw()
	}
	m.mu.Lock()
	was := m.frozen
	m.frozen = false
	m.mu.Unlock()
	if was {
		m.handoffMu.Unlock()
	}
}

// Export captures the full snapshot. It must be called after a successful
// Freeze. The generation is incremented for the new process. On error, every
// fd dup'ed so far is closed.
//
// sessions[] is in display order (ADR-0040); order has no field of its own, so
// the schema is unchanged.
func (m *Manager) Export(fromVersion string) (*handoff.Snapshot, error) {
	m.mu.RLock()
	snap := &handoff.Snapshot{
		Schema:      handoff.Schema,
		Generation:  m.generation + 1,
		FromVersion: fromVersion,
		InstanceID:  m.instanceID,
		NextSID:     m.nextSID,
	}
	m.mu.RUnlock()
	for _, s := range m.List() {
		hs, err := s.export()
		if err != nil {
			snap.CloseFDs()
			return nil, err
		}
		snap.Sessions = append(snap.Sessions, hs)
	}
	return snap, nil
}

// Restore rebuilds the session table from a snapshot in the new process. It
// may be called only before the Manager has created any session.
//
// Display order is the order of sessions[] (ADR-0040). Older snapshots are in
// sid order, which is exactly the order older versions displayed.
//
// It is all or nothing: if any session can't be reattached, Restore fails and
// the new process should report the error and exit so systemd starts a clean
// one (sessions are lost, but the state is well defined). Emulator state is
// the exception: if it can't be imported, it is rebuilt best-effort from the
// ring buffer (see restoreTerm) rather than losing the session over one
// screen.
func (m *Manager) Restore(snap *handoff.Snapshot) error {
	if err := handoff.Validate(snap); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.sessions) != 0 {
		return errors.New("session: Restore must be called before any session exists")
	}
	restored := make(map[uint16]*Session, len(snap.Sessions))
	order := make([]uint16, 0, len(snap.Sessions))
	for _, hs := range snap.Sessions {
		s, err := m.restoreSession(hs)
		if err != nil {
			return fmt.Errorf("session: reattach session %d: %w", hs.SID, err)
		}
		restored[hs.SID] = s
		order = append(order, hs.SID)
	}
	m.instanceID = snap.InstanceID
	m.nextSID = snap.NextSID
	if m.nextSID == 0 {
		m.nextSID = 1
	}
	m.generation = snap.Generation
	m.sessions = restored
	m.order = order
	for _, s := range restored {
		if s.Status() == protocol.StatusRunning {
			s.startLoops()
		}
	}
	return nil
}

func (m *Manager) restoreSession(hs handoff.Session) (*Session, error) {
	ring := ringbuf.Restore(m.cfg.RingBytes, hs.RingBase, hs.RingData)
	s := &Session{
		mgr:        m,
		sid:        hs.SID,
		fd:         -1,
		createdAt:  hs.CreatedAt,
		name:       hs.Name,
		nameManual: hs.NameManual,
		title:      hs.Title,
		titlePgrp:  hs.TitlePgrp,
		attention:  hs.Attention,
		titleBusy:  busyTitle(hs.Title), // a ◐ before the upgrade and ✳ after still counts
		cwd:        hs.CWD,
		status:     hs.Status,
		exitCode:   hs.ExitCode,
		cols:       hs.Cols,
		rows:       hs.Rows,
		ring:       ring,
		term:       restoreTerm(hs),
		subs:       make(map[Subscriber]struct{}),
		inQueued:   cloneCounts(hs.InQueued),
		inAck:      cloneCounts(hs.InAck),
		inputQ:     newInputQueue(),
		done:       make(chan struct{}),
		readDone:   make(chan struct{}),
		fz:         newFreezer(),
	}
	// An emulator replayed from the ring buffer (schema 1) has already counted
	// the titles in that history; they were not just set.
	_, s.titleSeen = s.term.Title()
	s.signalSeen = s.term.Signals() // likewise for bells in a replayed history
	if hs.Status != protocol.StatusRunning {
		// Exited: keep ring and emulator for scrollback (AC-4.5); there is no
		// fd or process.
		s.inputQ.close()
		close(s.done)
		return s, nil
	}
	// O_NONBLOCK lives on the open file description and survives exec. Setting
	// it again is defensive: os.NewFile must see a pollable file, or
	// SetReadDeadline won't work and the next hot upgrade can't freeze.
	if err := unix.SetNonblock(hs.PtmxFD, true); err != nil {
		return nil, fmt.Errorf("ptmx fd %d: %w", hs.PtmxFD, err)
	}
	unix.CloseOnExec(hs.PtmxFD) // restore the CLOEXEC cleared for the handoff (see pollable)
	f := os.NewFile(uintptr(hs.PtmxFD), "ptmx")
	if f == nil {
		return nil, fmt.Errorf("invalid ptmx fd %d", hs.PtmxFD)
	}
	s.ptmx, s.fd = f, hs.PtmxFD
	proc, err := os.FindProcess(hs.ShellPID)
	if err != nil {
		return nil, fmt.Errorf("shell pid %d: %w", hs.ShellPID, err)
	}
	s.proc = proc
	s.inputQ.restore(hs.Pending)
	return s, nil
}

// restoreTerm reattaches the emulator (ADR-0026 §8).
//
// Normally it imports the handed-over state, and snapshots after the import
// are byte-identical to those before export.
//
// When upgrading from an older version (no emulator state in the handoff) or
// when the state can't be imported, it creates a new emulator and feeds it the
// ring buffer contents as a best effort. If the window starts in the middle
// of an alternate screen program, that session's screen is wrong once and
// recovers on the program's next redraw (or the user's next keystroke). The
// upgrade is not aborted for this; keeping the session alive matters more
// than one screen.
func restoreTerm(hs handoff.Session) *vterm.Terminal {
	if len(hs.VTerm) > 0 {
		t, err := vterm.Import(hs.VTerm)
		if err == nil {
			if c, r := t.Size(); c != int(hs.Cols) || r != int(hs.Rows) {
				t.Resize(int(hs.Cols), int(hs.Rows))
			}
			return t
		}
		slog.Warn("cannot import handed-over emulator state; rebuilding best-effort from the ring buffer", "sid", hs.SID, "err", err)
	}
	t := vterm.New(int(hs.Cols), int(hs.Rows))
	t.Write(hs.RingData)
	return t
}
