package session

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/sunhaijun/webterm/internal/protocol"
)

// Which program is in front (ADR-0054 §2): the page picks the combo keys and
// the frequent-input source from it.
const (
	ProgramShell  = "shell"
	ProgramClaude = "claude"
	ProgramCodex  = "codex"
	ProgramOther  = "other"
)

// interpreters run a script or package given as argv[1]: a script named
// claude, or claude / codex installed from npm.
var interpreters = map[string]bool{
	"node": true, "bun": true, "deno": true, "env": true,
	"bash": true, "sh": true, "zsh": true, "python": true, "python3": true,
}

// classifyProgram names the program from its executable and argv. Not the
// process name: one claude process is "claude" and another "2.1.316" (the
// version file is the executable).
func classifyProgram(exe string, argv []string) string {
	args := argv
	if len(args) > 2 {
		args = args[:2]
	}
	interp := interpreters[filepath.Base(exe)] || (len(argv) > 0 && interpreters[filepath.Base(argv[0])])
	is := func(name, pkg string) bool {
		if filepath.Base(exe) == name || strings.Contains(exe, "/"+name+"/versions/") {
			return true
		}
		for i, a := range args {
			if strings.Contains(a, "/"+pkg+"/") {
				return true
			}
			if (i == 0 || interp) && filepath.Base(a) == name {
				return true
			}
		}
		return false
	}
	switch {
	case is("claude", "@anthropic-ai/claude-code"):
		return ProgramClaude
	case is("codex", "@openai/codex"):
		return ProgramCodex
	}
	return ProgramOther
}

// readProgram classifies the foreground process group's leader. The shell
// itself is ProgramShell; anything unreadable is ProgramOther.
func readProgram(pgrp, shell int) string {
	if shell > 0 && pgrp == shell {
		return ProgramShell
	}
	exe, argv := readProc(pgrp)
	return classifyProgram(exe, argv)
}

// readProc reads a process's executable and argv from /proc.
func readProc(pid int) (exe string, argv []string) {
	dir := "/proc/" + strconv.Itoa(pid)
	exe, _ = os.Readlink(dir + "/exe")
	raw, _ := os.ReadFile(dir + "/cmdline")
	if len(raw) > 0 {
		argv = strings.Split(strings.TrimRight(string(raw), "\x00"), "\x00")
	}
	return exe, argv
}

// Foreground returns the executable and argv of the program in front of the
// session (its foreground process group's leader), for running it again: the
// command strip asks the claude in front for its commands (ADR-0057 §4).
func (s *Session) Foreground() (exe string, argv []string, ok bool) {
	if s.Status() != protocol.StatusRunning {
		return "", nil, false
	}
	pgrp, err := foregroundPgrp(s.ptmx)
	if err != nil || pgrp <= 0 {
		return "", nil, false
	}
	exe, argv = readProc(pgrp)
	return exe, argv, exe != ""
}
