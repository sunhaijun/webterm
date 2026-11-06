package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"strconv"

	"github.com/sunhaijun/webterm/internal/agent"
	"github.com/sunhaijun/webterm/internal/attach"
)

// runAttach joins one of the running agent's sessions from this terminal,
// usually one that came in through sshd (ADR-0050).
func runAttach(args []string) error {
	fs := flag.NewFlagSet("attach", flag.ExitOnError)
	dataDir := fs.String("data-dir", defaultDataDir(), "data directory of the agent to attach to")
	newSession := fs.Bool("new", false, "create a session and attach to it")
	list := fs.Bool("list", false, "list the sessions and exit (needs no terminal)")
	fs.Usage = func() {
		fmt.Fprint(fs.Output(), `Usage: webterm attach [flags] [name | number]

Attach this terminal to a session, usually over SSH: ssh -t host webterm attach
With no argument: one session attaches, several are listed to choose from.
A number picks by position (the [n] on the tab bar); anything else is a name
(exact, else a case-insensitive substring). Close ssh to detach.

Flags:
`)
		fs.PrintDefaults()
	}
	if err := applyConfig(fs, args); err != nil {
		return err
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 1 {
		fs.Usage()
		return exitCode(2)
	}
	if *newSession && fs.NArg() > 0 {
		return errors.New("--new takes no session name")
	}

	err := attach.Run(context.Background(), attach.Options{
		Socket: attachSocketPath(*dataDir),
		Target: fs.Arg(0),
		New:    *newSession,
		List:   *list,
		In:     os.Stdin,
		Out:    os.Stdout,
		Self:   selfSession(),
	})
	var pe *attach.PickError
	if errors.As(err, &pe) {
		fmt.Fprintf(os.Stderr, "webterm attach: %s\n", pe.Msg)
		home, _ := os.UserHomeDir()
		fmt.Fprint(os.Stderr, attach.FormatList(pe.List, home))
		return exitCode(1)
	}
	if errors.Is(err, attach.ErrNoAgent) && agent.ControlInUse(controlSocketPath(*dataDir)) {
		// An agent from before attach: it answers on the control socket only.
		err = errors.New("the running agent is too old for attach; upgrade it with `webterm update` (or `webterm reload` after replacing the binary)")
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "webterm attach: %v\n", err)
		return exitCode(1)
	}
	return nil
}

// selfSession is the session this command runs in, from the environment the
// agent gives every session; 0 outside webterm.
func selfSession() uint16 {
	v, err := strconv.ParseUint(os.Getenv("WEBTERM_SESSION"), 10, 16)
	if err != nil {
		return 0
	}
	return uint16(v)
}
