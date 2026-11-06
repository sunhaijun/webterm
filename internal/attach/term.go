package attach

import (
	"errors"
	"os"
	"strconv"

	"golang.org/x/sys/unix"
)

// ErrNoTerminal means stdin or stdout isn't a terminal: attach was run
// without ssh -t, or with redirected input.
var ErrNoTerminal = errors.New("attach needs a terminal: run it as `ssh -t host webterm attach`")

// isTerminal reports whether f is a terminal.
func isTerminal(f *os.File) bool {
	_, err := unix.IoctlGetTermios(int(f.Fd()), unix.TCGETS)
	return err == nil
}

// makeRaw puts the terminal in raw mode (cfmakeraw) and returns a function
// that restores the previous settings.
func makeRaw(f *os.File) (restore func(), err error) {
	fd := int(f.Fd())
	old, err := unix.IoctlGetTermios(fd, unix.TCGETS)
	if err != nil {
		return nil, err
	}
	t := *old
	t.Iflag &^= unix.IGNBRK | unix.BRKINT | unix.PARMRK | unix.ISTRIP | unix.INLCR | unix.IGNCR | unix.ICRNL | unix.IXON
	t.Oflag &^= unix.OPOST
	t.Lflag &^= unix.ECHO | unix.ECHONL | unix.ICANON | unix.ISIG | unix.IEXTEN
	t.Cflag &^= unix.CSIZE | unix.PARENB
	t.Cflag |= unix.CS8
	t.Cc[unix.VMIN] = 1
	t.Cc[unix.VTIME] = 0
	if err := unix.IoctlSetTermios(fd, unix.TCSETS, &t); err != nil {
		return nil, err
	}
	return func() { _ = unix.IoctlSetTermios(fd, unix.TCSETS, old) }, nil
}

// termSize returns the terminal's size, or 80×24 when it doesn't know one
// (a PTY nobody sized reports 0×0).
func termSize(f *os.File) (cols, rows uint16) {
	ws, err := unix.IoctlGetWinsize(int(f.Fd()), unix.TIOCGWINSZ)
	if err != nil || ws.Col == 0 || ws.Row == 0 {
		return 80, 24
	}
	return clampDim(ws.Col), clampDim(ws.Row)
}

// clampDim keeps a size inside what the protocol accepts (1..1000, §4.1).
func clampDim(v uint16) uint16 {
	if v > 1000 {
		return 1000
	}
	return v
}

// Escape sequences the client writes itself (ADR-0050 §3).
const (
	// titlePush saves the window title; titlePop restores it on exit, so a
	// session's title doesn't stay on the window.
	titlePush = "\x1b[22;0t"
	titlePop  = "\x1b[23;0t"

	// beforeSnapshot resets the terminal (RIS) and clears its scrollback, so
	// the snapshot draws on a clean terminal and a later snapshot replaces the
	// history instead of adding a second copy.
	beforeSnapshot = "\x1bc\x1b[3J"

	// exitReset turns off what a program may have left on, then puts the
	// cursor on the bottom row for the shell that comes back. The screen's
	// content stays.
	exitReset = "\x1b[?1049l" + // alternate screen
		"\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l" + // mouse tracking and encodings
		"\x1b[?1004l" + // focus events
		"\x1b[?2004l" + // bracketed paste
		"\x1b[?2026l" + // synchronized output
		"\x1b[?1l\x1b>" + // normal cursor keys and keypad
		"\x1b[<99u" + // pop every kitty keyboard flag set
		"\x1b[>4m" + // modifyOtherKeys back to default
		"\x1b[r" + // full-screen scroll region
		"\x1b[?6l" + // origin mode off
		"\x1b[?7h" + // autowrap on
		"\x1b[?25h" + // cursor visible
		"\x1b[0 q" + // default cursor shape
		"\x1b[0m" + // SGR attributes
		"\x1b(B\x0f" + // G0 = ASCII, shifted in
		"\x1b[999;1H\r\n"
)

// exitLine is the line shown when the session's shell exits, the same text the
// browser writes (AC-4.5). Like the browser, it starts a new line only when the
// cursor isn't already at the start of one; atLineStart is the client's guess
// from the last byte it wrote.
func exitLine(code *int, atLineStart bool) string {
	text := "[Exited · Enter to close]"
	if code != nil {
		text = "[Exited (code " + strconv.Itoa(*code) + ") · Enter to close]"
	}
	nl := "\r\n"
	if atLineStart {
		nl = ""
	}
	return nl + "\x1b[0;2m" + text + "\x1b[0m"
}
