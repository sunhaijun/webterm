package session

import (
	"os"

	"github.com/creack/pty"
)

func setWinsize(f *os.File, cols, rows uint16) error {
	return pty.Setsize(f, &pty.Winsize{Cols: cols, Rows: rows})
}
