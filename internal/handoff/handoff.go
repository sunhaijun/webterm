// Package handoff carries session state across a hot upgrade (ADR-0016), from
// the old process to the new one it execs in place.
//
// It only moves data: types, encoding, memfd, the pre-flight check, and exec.
// internal/session decides what goes into the snapshot (this package's Session
// is the part of session.Session that must survive) and how to rebuild a
// session from it, so the dependency runs one way: session -> handoff.
//
// The snapshot lives in a memfd, in memory only and never on disk
// (invariant 3). The fd is inherited across exec, and the new process closes
// it after reading.
package handoff

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// Schema is the snapshot format version. Fields are only ever added, never
// removed, and the new process treats missing fields as zero values. An
// incompatible change bumps this number so the old process's pre-flight check
// fails before exec.
//
//	1  initial (ADR-0016): sticky modes (termstate), OSC parser, shell-integration state
//	2  ADR-0026: emulator state (VTerm) replaces sticky modes; shell-integration fields removed.
//	   Schema 1 still loads: without VTerm the emulator is rebuilt best-effort
//	   from the ring buffer instead of aborting the upgrade (§8)
const Schema = 2

// FlagName is the flag through which the new process receives the snapshot fd
// (serve --handoff-fd=N).
const FlagName = "handoff-fd"

// Listener is a listening socket inherited across exec.
type Listener struct {
	Name string `json:"name"` // "http" / "https"
	FD   int    `json:"fd"`
}

// PendingInput is input that was queued but not yet written to the PTY.
type PendingInput struct {
	ClientID string `json:"client_id"`
	Data     []byte `json:"data"`
}

// Session is everything about a session that must survive a handoff. The
// field list is documented in docs/50-backend/session-manager.md (hot-upgrade
// handoff section).
//
// Schema 1 fields (integration, prompt_state, osc, modes, command records, ...)
// are gone. The decoder ignores them, so sessions handed over by an older
// version still load.
type Session struct {
	SID       uint16    `json:"sid"`
	PtmxFD    int       `json:"ptmx_fd"`   // -1 = none (session exited)
	ShellPID  int       `json:"shell_pid"` // 0 = none
	CreatedAt time.Time `json:"created_at"`

	Name       string `json:"name,omitempty"`
	NameManual bool   `json:"name_manual,omitempty"`
	// Title and TitlePgrp are the terminal title in use and the foreground
	// process group it belongs to (ADR-0043 §4). Without them the name would
	// flash back to the directory name after an upgrade until the program
	// sets its title again. Absent in older snapshots, meaning no title in use.
	Title     string `json:"title,omitempty"`
	TitlePgrp int    `json:"title_pgrp,omitempty"`
	// Attention is "waiting for you" (ADR-0052 §5), with a bell or
	// notification the poll hadn't seen yet folded in. Absent in older
	// snapshots, meaning not set.
	Attention bool   `json:"attention,omitempty"`
	CWD       string `json:"cwd"`
	Status    string `json:"status"`
	ExitCode  *int   `json:"exit_code,omitempty"`
	Cols      uint16 `json:"cols"`
	Rows      uint16 `json:"rows"`

	RingBase uint64 `json:"ring_base"`
	RingData []byte `json:"ring_data"`

	// VTerm is the full terminal emulator state (internal/vterm Export, with
	// the full 2000 lines of scrollback; opaque bytes at this layer). It must
	// be handed over: the screen, modes, and scrollback cannot be rebuilt from
	// the ring buffer, which holds only the last 256 KiB. Absent in schema 1.
	VTerm []byte `json:"vterm,omitempty"`

	InQueued map[string]uint64 `json:"in_queued,omitempty"`
	InAck    map[string]uint64 `json:"in_ack,omitempty"`

	Pending []PendingInput `json:"pending,omitempty"`
}

// Snapshot is everything passed in one handoff.
type Snapshot struct {
	Schema      int        `json:"schema"`
	Generation  int        `json:"generation"` // new process's generation; +1 per handoff
	FromVersion string     `json:"from_version"`
	InstanceID  string     `json:"instance_id"`
	NextSID     uint16     `json:"next_sid"`
	Listeners   []Listener `json:"listeners"`
	Sessions    []Session  `json:"sessions"` // in display order (ADR-0040)
}

// CloseFDs closes the session fds duplicated for the handoff; used when the
// handoff is aborted. Listener fds are owned by the *os.File values returned
// from the agent's ExportListeners.
func (s *Snapshot) CloseFDs() {
	for i := range s.Sessions {
		if s.Sessions[i].PtmxFD >= 0 {
			unix.Close(s.Sessions[i].PtmxFD)
			s.Sessions[i].PtmxFD = -1
		}
	}
}

// Validate checks a snapshot in the new process, both in handoff-check and in
// the real restore.
func Validate(s *Snapshot) error {
	if s == nil {
		return errors.New("handoff: snapshot is nil")
	}
	if s.Schema <= 0 || s.Schema > Schema {
		return fmt.Errorf("handoff: snapshot schema %d, this build supports 1..%d (is the new binary older than the running one?)", s.Schema, Schema)
	}
	if s.InstanceID == "" {
		return errors.New("handoff: snapshot has no instance_id")
	}
	seen := make(map[uint16]bool, len(s.Sessions))
	for _, se := range s.Sessions {
		if se.SID == 0 || seen[se.SID] {
			return fmt.Errorf("handoff: invalid or duplicate session sid %d", se.SID)
		}
		seen[se.SID] = true
		if se.Status == "running" && (se.PtmxFD < 0 || se.ShellPID <= 0) {
			return fmt.Errorf("handoff: running session %d has no ptmx fd or pid", se.SID)
		}
	}
	return nil
}

// Encode serializes a snapshot to its wire format (JSON).
func Encode(s *Snapshot) ([]byte, error) { return json.Marshal(s) }

// Decode reads a snapshot and validates it.
func Decode(r io.Reader) (*Snapshot, error) {
	var s Snapshot
	dec := json.NewDecoder(r)
	if err := dec.Decode(&s); err != nil {
		return nil, fmt.Errorf("handoff: decode snapshot: %w", err)
	}
	if err := Validate(&s); err != nil {
		return nil, err
	}
	return &s, nil
}

// Write stores the snapshot in a memory-only file and returns it, seeked to 0
// with CLOEXEC cleared so it is ready to be inherited across exec.
func Write(s *Snapshot) (*os.File, error) {
	raw, err := Encode(s)
	if err != nil {
		return nil, err
	}
	f, err := memFile()
	if err != nil {
		return nil, err
	}
	if _, err := f.Write(raw); err != nil {
		f.Close()
		return nil, fmt.Errorf("handoff: write snapshot: %w", err)
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		f.Close()
		return nil, err
	}
	if err := Inherit(int(f.Fd())); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

// memFile creates an anonymous in-memory file. It prefers memfd and falls back
// to an immediately unlinked file on /dev/shm (tmpfs) on old kernels or in
// containers without memfd. Neither touches disk.
func memFile() (*os.File, error) {
	fd, err := unix.MemfdCreate("webterm-handoff", 0)
	if err == nil {
		return os.NewFile(uintptr(fd), "memfd:webterm-handoff"), nil
	}
	f, err2 := os.CreateTemp("/dev/shm", "webterm-handoff-*")
	if err2 != nil {
		return nil, fmt.Errorf("handoff: memfd_create: %v; /dev/shm unavailable too: %w", err, err2)
	}
	_ = os.Remove(f.Name())
	return f, nil
}

// Read loads the snapshot in the new process and closes fd.
func Read(fd int) (*Snapshot, error) {
	f := os.NewFile(uintptr(fd), "handoff")
	if f == nil {
		return nil, fmt.Errorf("handoff: invalid fd %d", fd)
	}
	defer f.Close()
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	return Decode(f)
}

// Inherit clears CLOEXEC on fd so it survives exec. Go sets CLOEXEC on every fd
// by default.
func Inherit(fd int) error {
	if _, err := unix.FcntlInt(uintptr(fd), unix.F_SETFD, 0); err != nil {
		return fmt.Errorf("handoff: clear CLOEXEC on fd %d: %w", fd, err)
	}
	return nil
}

// Check is the pre-flight check: it runs the new binary's handoff-check as a
// child process, with the serve arguments the new process will get, and feeds
// it the metadata snapshot. If the new binary cannot read the snapshot or
// rejects the arguments or config file, fail here; there is no way back after
// exec. argv starts with "serve".
func Check(exe string, argv []string, meta *Snapshot, timeout time.Duration) error {
	raw, err := Encode(meta)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, append([]string{"handoff-check"}, argv...)...)
	cmd.Stdin = bytes.NewReader(raw)
	cmd.WaitDelay = time.Second // after the kill, don't wait for its children to close the pipe
	out, err := cmd.CombinedOutput()
	var exit *exec.ExitError
	switch {
	case err == nil:
	case ctx.Err() != nil:
		return errors.New("handoff: new binary pre-flight check timed out")
	case !errors.As(err, &exit):
		return fmt.Errorf("handoff: cannot start new binary %s: %w", exe, err)
	default:
		return fmt.Errorf("handoff: new binary rejected the upgrade: %s", bytes.TrimSpace(out))
	}
	if !bytes.HasPrefix(bytes.TrimSpace(out), []byte("ok schema=")) {
		return fmt.Errorf("handoff: unexpected pre-flight output from new binary: %q", out)
	}
	return nil
}

// CheckOutput is the line handoff-check prints on success.
func CheckOutput() string { return "ok schema=" + strconv.Itoa(Schema) }

// Exec replaces the process with the new binary. It returns only on error.
//
// argv is the full serve argument list without --handoff-fd; Exec appends the
// snapshot fd.
func Exec(exe string, argv []string, fd int) error {
	args := append([]string{exe}, argv...)
	args = append(args, "--"+FlagName+"="+strconv.Itoa(fd))
	return syscall.Exec(exe, args, os.Environ())
}

// StripFlag removes --handoff-fd from args so the new process can hand off
// again with its original arguments. It handles all four forms the flag
// package accepts: --x=N, -x=N, --x N, -x N.
func StripFlag(args []string) []string {
	out := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		switch a := args[i]; {
		case a == "--"+FlagName || a == "-"+FlagName:
			i++ // value is the next arg
		case strings.HasPrefix(a, "--"+FlagName+"="), strings.HasPrefix(a, "-"+FlagName+"="):
		default:
			out = append(out, a)
		}
	}
	return out
}
