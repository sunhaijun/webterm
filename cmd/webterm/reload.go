package main

import (
	"errors"
	"flag"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/sunhaijun/webterm/internal/agent"
)

// runReload asks the running agent to hot-upgrade: exec the new binary on disk
// in place, keeping sessions (ADR-0016).
//
// It uses the local control socket (<data-dir>/run/agent.sock), not HTTP. The
// upgrade script runs on the server as the same user, so file permissions are
// the authentication.
//
//	--probe      only check whether the running agent supports hot upgrade (exit 0 if so); used by install.sh
//	--when-idle  wait until every session is idle at a prompt first
//	--wait-idle  only wait for idle, do not trigger (used before falling back to a restart)
//	-- serve …   the command line the new process starts with, instead of the
//	             running one's; install.sh passes the unit's, so a changed
//	             address or port takes effect (ADR-0047 §1)
func runReload(args []string) error {
	fs := flag.NewFlagSet("reload", flag.ContinueOnError)
	var c commonFlags
	c.register(fs)
	probe := fs.Bool("probe", false, "only check whether the running agent supports hot upgrade")
	whenIdle := fs.Bool("when-idle", false, "wait until every session is idle at a prompt before upgrading")
	waitIdle := fs.Bool("wait-idle", false, "only wait until every session is idle; do not upgrade")
	timeout := fs.Duration("timeout", 30*time.Minute, "maximum wait for --when-idle")
	if err := applyConfig(fs, args); err != nil {
		return err
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	newArgs := fs.Args()
	if len(newArgs) > 0 && newArgs[0] != "serve" {
		return fmt.Errorf("the command line after -- must start with serve, got %q", newArgs[0])
	}
	sock := controlSocketPath(c.dataDir)

	st, err := controlStatus(sock)
	if err != nil {
		if *probe {
			return fmt.Errorf("the running agent does not support hot upgrade, or is not running: %v", err)
		}
		return fmt.Errorf("the running agent does not support hot upgrade, or is not running (%v).\n"+
			"  Versions without hot upgrade support can only be restarted: %s (closes all sessions)", err, detectUnit().ctl("restart"))
	}
	if *probe {
		fmt.Printf("ok version=%s pid=%d generation=%d sessions=%d busy=%d\n", st.Version, st.PID, st.Generation, st.Sessions, st.Busy)
		return nil
	}

	if *whenIdle || *waitIdle {
		if err := waitUntilIdle(sock, *timeout); err != nil {
			return err
		}
	}
	if *waitIdle {
		return nil
	}

	fmt.Printf("webterm %s\n\n", version)
	fmt.Printf("  Asking the running agent to hot-upgrade: %s (pid %d, %s)\n", st.Version, st.PID, plural(st.Sessions, "session"))
	req := agent.ControlRequest{Op: "reexec"}
	if len(newArgs) > 0 && st.ExecArgs {
		req.Args = newArgs
	}
	if _, err := agent.ControlCall(sock, req, 5*time.Second); err != nil {
		return fmt.Errorf("the agent refused the hot upgrade: %w", err)
	}
	after, err := waitTakeover(sock, st, 30*time.Second)
	if err != nil || len(newArgs) == 0 || req.Args != nil {
		return err
	}
	// The agent predates command-line handoff and kept its old one. It now
	// runs the new binary, which takes the new command line: one more hot
	// upgrade, sessions still kept.
	if !after.ExecArgs {
		fmt.Printf("  Note: the agent still runs with its old command line; restart it to apply %v\n", newArgs)
		return nil
	}
	fmt.Printf("  Applying the new command line: %s\n", strings.Join(newArgs, " "))
	if _, err := agent.ControlCall(sock, agent.ControlRequest{Op: "reexec", Args: newArgs}, 5*time.Second); err != nil {
		return fmt.Errorf("the agent refused the hot upgrade: %w", err)
	}
	_, err = waitTakeover(sock, after, 30*time.Second)
	return err
}

func controlSocketPath(dataDir string) string { return filepath.Join(dataDir, "run", "agent.sock") }

func controlStatus(sock string) (*agent.ControlStatus, error) {
	resp, err := agent.ControlCall(sock, agent.ControlRequest{Op: "status"}, 3*time.Second)
	if err != nil {
		return nil, err
	}
	if resp.Status == nil || !resp.Status.Handoff {
		return nil, errors.New("the agent answered but does not support handoff")
	}
	return resp.Status, nil
}

// waitUntilIdle waits until no session is running a foreground command: in
// every live session, the PTY's foreground process group is the shell itself.
// A session whose foreground process group cannot be read counts as idle.
func waitUntilIdle(sock string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	announced := false
	for {
		st, err := controlStatus(sock)
		if err != nil {
			return err
		}
		if st.Busy == 0 {
			if announced {
				fmt.Println("  All sessions are idle at a prompt")
			}
			return nil
		}
		if !announced {
			fmt.Printf("  Waiting for %s to finish running commands (--when-idle, up to %s)...\n", plural(st.Busy, "session"), timeout)
			announced = true
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("after %s, %s still running commands; drop --when-idle to upgrade now, or try again later", timeout, plural(st.Busy, "session"))
		}
		time.Sleep(2 * time.Second)
	}
}

// waitTakeover waits for the new process to take over (generation + 1) and
// returns its status. If the old process fails the preflight, it records the
// reason in status.last_error, which is reported right away instead of after
// the timeout. A different instance id means the agent didn't take over but
// started from scratch (the new binary crashed and systemd restarted it), so
// the sessions are gone and the error says so.
func waitTakeover(sock string, before *agent.ControlStatus, timeout time.Duration) (*agent.ControlStatus, error) {
	u := detectUnit()
	restarted := func(st *agent.ControlStatus) error {
		return fmt.Errorf("the new process didn't take over: the agent restarted (pid %d → %d) and all sessions were lost. Why: %s -n 50", before.PID, st.PID, u.journal())
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		time.Sleep(200 * time.Millisecond)
		st, err := controlStatus(sock)
		if err != nil {
			continue // the socket briefly disappears around exec
		}
		if st.InstanceID != before.InstanceID {
			return nil, restarted(st)
		}
		if st.Generation > before.Generation {
			fmt.Printf("\n  Hot upgrade complete: webterm %s (pid %d unchanged, %s kept, generation %d)\n", st.Version, st.PID, plural(st.Sessions, "session"), st.Generation)
			if st.Version != version {
				fmt.Printf("  Note: the running version %s differs from this command's %s\n", st.Version, version)
			}
			return st, nil
		}
		if st.LastError != "" && st.Generation == before.Generation {
			return nil, fmt.Errorf("the agent aborted the hot upgrade: %s\n  Sessions are intact and the service was not restarted. Fix the cause and retry, or restart and lose all sessions: %s", st.LastError, u.ctl("restart"))
		}
	}
	st, err := controlStatus(sock)
	switch {
	case err == nil && st.InstanceID != before.InstanceID:
		return nil, restarted(st)
	case err == nil && st.Generation == before.Generation:
		return nil, fmt.Errorf("the agent did not complete the hot upgrade (see %s -n 50). Sessions are intact and the service was not restarted", u.journal())
	}
	return nil, fmt.Errorf("no answer from the new process within 30 seconds of the hot upgrade; check %s and %s -n 50", u.ctl("status"), u.journal())
}
