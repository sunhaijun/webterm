package attach

import (
	"strings"
	"testing"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"
)

// Raw mode while attached, and the terminal's own settings back on exit
// (ADR-0050 §3).
func TestMakeRawRestores(t *testing.T) {
	master, slave, err := pty.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer master.Close()
	defer slave.Close()
	if !isTerminal(slave) {
		t.Fatal("a PTY is a terminal")
	}
	before, err := unix.IoctlGetTermios(int(slave.Fd()), unix.TCGETS)
	if err != nil {
		t.Fatal(err)
	}
	if before.Lflag&unix.ICANON == 0 {
		t.Fatal("a fresh PTY should be in cooked mode")
	}
	restore, err := makeRaw(slave)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := unix.IoctlGetTermios(int(slave.Fd()), unix.TCGETS)
	if raw.Lflag&(unix.ICANON|unix.ECHO|unix.ISIG) != 0 || raw.Oflag&unix.OPOST != 0 || raw.Iflag&unix.ICRNL != 0 {
		t.Fatalf("not raw: %+v", raw)
	}
	restore()
	after, _ := unix.IoctlGetTermios(int(slave.Fd()), unix.TCGETS)
	if *after != *before {
		t.Fatalf("settings not restored:\nbefore %+v\nafter  %+v", before, after)
	}
}

func TestTermSizeFallback(t *testing.T) {
	master, slave, err := pty.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer master.Close()
	defer slave.Close()
	if c, r := termSize(slave); c != 80 || r != 24 {
		t.Fatalf("unsized PTY: %dx%d, want 80x24", c, r)
	}
	if err := pty.Setsize(master, &pty.Winsize{Cols: 2000, Rows: 50}); err != nil {
		t.Fatal(err)
	}
	if c, r := termSize(slave); c != 1000 || r != 50 {
		t.Fatalf("got %dx%d, want columns clamped to 1000", c, r)
	}
}

// The exit sequence turns off every mode ADR-0050 §3 lists.
func TestExitResetCoversModes(t *testing.T) {
	for name, seq := range map[string]string{
		"alternate screen": "\x1b[?1049l", "mouse 1000": "\x1b[?1000l", "mouse 1002": "\x1b[?1002l",
		"mouse 1003": "\x1b[?1003l", "SGR mouse": "\x1b[?1006l", "focus": "\x1b[?1004l",
		"bracketed paste": "\x1b[?2004l", "sync output": "\x1b[?2026l", "cursor keys": "\x1b[?1l",
		"keypad": "\x1b>", "kitty keyboard": "\x1b[<99u", "modifyOtherKeys": "\x1b[>4m",
		"scroll region": "\x1b[r", "origin mode": "\x1b[?6l", "cursor visible": "\x1b[?25h",
		"SGR": "\x1b[0m", "charset": "\x1b(B",
	} {
		if !strings.Contains(exitReset, seq) {
			t.Errorf("exit reset misses %s (%q)", name, seq)
		}
	}
	if !strings.HasSuffix(exitReset, "\r\n") {
		t.Error("exit reset must leave the cursor on a fresh line")
	}
	if got := exitLine(nil, true); got != "\x1b[0;2m[Exited · Enter to close]\x1b[0m" {
		t.Errorf("exit line at line start: %q", got)
	}
	code := 3
	if got := exitLine(&code, false); got != "\r\n\x1b[0;2m[Exited (code 3) · Enter to close]\x1b[0m" {
		t.Errorf("exit line mid-line: %q", got)
	}
}
