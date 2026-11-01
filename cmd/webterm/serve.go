package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/sunhaijun/webterm/internal/agent"
	"github.com/sunhaijun/webterm/internal/handoff"
	"github.com/sunhaijun/webterm/internal/session"
	"github.com/sunhaijun/webterm/internal/store"
)

// serveOpts holds the flags specific to serve.
//
// Registering them in one place lets serveFlagSet() back the config-file
// allowlist tests (TestConfigKeysAllExistOnServe / TestServeFlagsAreConfigurable)
// without a second flag list that would inevitably drift.
type serveOpts struct {
	httpPort          int
	httpsPort         int
	bind              string
	noTLS             bool
	trustProxy        bool
	maxSessions       int
	maxConns          int
	ringBytes         int
	noLoginShell      bool
	sessionEnv        envList
	noAltScreenCompat bool
	shell             string
	logLevel          string
	handoffFD         int
}

func (o *serveOpts) register(fs *flag.FlagSet) {
	fs.IntVar(&o.httpPort, "http-port", 80, "HTTP port for ACME challenges and HTTPS redirects")
	fs.IntVar(&o.httpsPort, "https-port", 443, "HTTPS port")
	fs.StringVar(&o.bind, "bind", "0.0.0.0", "listen address; use 127.0.0.1 behind a tunnel or reverse proxy")
	fs.BoolVar(&o.noTLS, "no-tls", false, "disable TLS (only allowed when --bind is a loopback or private address)")
	fs.BoolVar(&o.trustProxy, "trust-proxy", false, "trust X-Forwarded-For (only behind a reverse proxy; otherwise rate limits can be bypassed)")
	fs.IntVar(&o.maxSessions, "max-sessions", 20, "maximum number of sessions")
	fs.IntVar(&o.maxConns, "max-conns", 16, "maximum concurrent WebSocket connections")
	fs.IntVar(&o.ringBytes, "ring-bytes", session.DefaultRingBytes, "per-session output buffer: output missed while disconnected or switched away resumes incrementally if it fits, otherwise via a snapshot")
	fs.BoolVar(&o.noLoginShell, "no-login-shell", false, "start a non-login interactive shell with -i (bash reads only ~/.bashrc); the default is -l -i")
	fs.Var(&o.sessionEnv, "session-env", "environment variable for session PTYs, as KEY=VAL; repeatable")
	fs.BoolVar(&o.noAltScreenCompat, "no-altscreen-compat", false, "disable the built-in list of full-screen AI CLIs kept on the main screen (ADR-0024)")
	fs.StringVar(&o.shell, "shell", "bash", "shell to run in sessions; any shell that supports -l and -i works")
	fs.StringVar(&o.logLevel, "log-level", "info", "debug, info, warn or error")
	fs.IntVar(&o.handoffFD, handoff.FlagName, -1, "internal: hot-upgrade snapshot fd, passed by the old process at exec (ADR-0016)")
}

// serveFlagSet returns serve's full flag set. serve's flags are a superset of
// every other subcommand's, so the config-file allowlist is checked against it.
func serveFlagSet() *flag.FlagSet {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	var c commonFlags
	var o serveOpts
	c.register(fs)
	o.register(fs)
	return fs
}

func runServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	var c commonFlags
	var o serveOpts
	c.register(fs)
	o.register(fs)
	if err := applyConfig(fs, args); err != nil {
		return err
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	// --dev listens on 8080 unless a port is given explicitly (AC-1.2).
	if c.dev && !isFlagSet(fs, "http-port") {
		o.httpPort = 8080
	}

	log := newLogger(o.logLevel)
	slog.SetDefault(log)

	if !c.dev && !o.noTLS && c.domain == "" {
		return fmt.Errorf("production mode requires --domain (used for ACME and Origin checks); use --dev for local development")
	}

	// Hot upgrade (ADR-0016): a process started with --handoff-fd is taking
	// over, so read the snapshot back first.
	var snap *handoff.Snapshot
	if o.handoffFD >= 0 {
		read, err := handoff.Read(o.handoffFD)
		if err != nil {
			return fmt.Errorf("hot upgrade handoff failed, cannot restore sessions: %w", err)
		}
		snap = read
	}

	st, err := store.Open(c.dataDir)
	if err != nil {
		return err
	}
	defer st.Close()

	runDir := filepath.Join(c.dataDir, "run")
	if err := os.MkdirAll(runDir, 0o700); err != nil {
		return fmt.Errorf("create runtime directory: %w", err)
	}
	// Older versions left temporary rcfiles here for shell integration, which
	// ADR-0026 §6 removed. Clean them up after a handoff too: bash reads its
	// rcfile only at startup, so running sessions no longer need them.
	cleanupLegacyRCFiles(runDir, log)

	sessions := session.NewManager(session.Config{
		MaxSessions:       o.maxSessions,
		RingBytes:         o.ringBytes,
		Shell:             o.shell,
		NoLoginShell:      o.noLoginShell,
		SessionEnv:        o.sessionEnv,
		NoAltScreenCompat: o.noAltScreenCompat,
	})
	defer sessions.Shutdown()
	if snap != nil {
		if err := sessions.Restore(snap); err != nil {
			return fmt.Errorf("hot upgrade handoff failed, cannot restore sessions: %w", err)
		}
		log.Info("hot upgrade complete, sessions taken over", "generation", sessions.Generation(),
			"sessions", len(snap.Sessions), "from", snap.FromVersion, "to", version)
	}

	a := agent.New(agent.Config{
		Domain:     c.domain,
		HTTPSPort:  o.httpsPort,
		Dev:        c.dev,
		TrustProxy: o.trustProxy,
		MaxConns:   o.maxConns,
		Version:    version,
		Logger:     log,
	}, st, sessions)

	servers, errCh, err := a.Listen(agent.ServeConfig{
		Domain:    c.domain,
		Dev:       c.dev,
		NoTLS:     o.noTLS,
		Bind:      o.bind,
		HTTPPort:  o.httpPort,
		HTTPSPort: o.httpsPort,
		CertDir:   agent.CertDirDefault(c.dataDir),
		Inherited: inheritedListeners(snap),
	}, a.Handler())
	if err != nil {
		return err
	}

	// Start the purge loop only after Listen succeeds. It queries the store
	// immediately; if Listen failed, we return and the deferred st.Close() runs,
	// that query hits "database is closed", and two WARN lines bury the real
	// error. There is nothing to purge when exiting anyway.
	stopPurge := make(chan struct{})
	go a.PurgeLoop(stopPurge)
	defer close(stopPurge)

	// Hot-upgrade control plane (ADR-0016): probe, busy check, trigger reexec.
	// SIGUSR2 does the same as reexec.
	reexecReq := make(chan struct{}, 1)
	var lastErr sync.Mutex
	lastHandoffErr := ""
	ctl, err := agent.ServeControl(filepath.Join(runDir, "agent.sock"), agent.ControlDeps{
		Status: func() agent.ControlStatus {
			lastErr.Lock()
			le := lastHandoffErr
			lastErr.Unlock()
			return agent.ControlStatus{
				Version: version, PID: os.Getpid(), Generation: sessions.Generation(),
				InstanceID: sessions.InstanceID(), Sessions: len(sessions.List()), Busy: sessions.Busy(),
				Handoff: true, LastError: le,
			}
		},
		Reexec: func() error {
			select {
			case reexecReq <- struct{}{}:
				return nil
			default:
				return errors.New("a hot upgrade is already in progress")
			}
		},
	}, log)
	if err != nil {
		return err
	}
	defer ctl.Close()

	// On first start with no authorized devices, print a pairing code and QR
	// code (AC-1.3).
	if has, err := st.HasAnyDevice(); err == nil && !has {
		codes, err := a.Auth().NewPairingCodes(time.Now())
		if err != nil {
			return err
		}
		fmt.Println()
		fmt.Println("No authorized devices yet. This pairing code is valid for 5 minutes:")
		printPairing(c.baseURL(o.httpPort, o.httpsPort), codes)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	usr2 := make(chan os.Signal, 1)
	signal.Notify(usr2, syscall.SIGUSR2)
	exe := currentExe()
	// argv for exec: "serve" plus this run's arguments, minus the previous
	// --handoff-fd. args starts after the subcommand, so "serve" is added back.
	serveArgs := append([]string{"serve"}, handoff.StripFlag(args)...)
loop:
	for {
		select {
		case err := <-errCh:
			return err
		case s := <-sig:
			log.Info("received signal, shutting down", "signal", s.String())
			break loop
		case <-usr2:
		case <-reexecReq:
		}
		// Hot upgrade: on success exec never returns. On failure, thaw, keep
		// serving and record the reason.
		if err := hotReexec(exe, serveArgs, a, sessions, servers, log); err != nil {
			lastErr.Lock()
			lastHandoffErr = err.Error()
			lastErr.Unlock()
			log.Error("hot upgrade aborted, still serving", "err", err)
			a.Hub().NoticeAll("warn", "Hot upgrade aborted: "+err.Error()+". Sessions are intact and the service was not restarted.")
		}
	}

	// Graceful shutdown: tell users why their sessions are about to end, then
	// close (the mitigation from ADR-0003).
	a.Hub().NoticeAll("warn", "The agent is restarting. All sessions will end.")
	time.Sleep(2 * time.Second) // let the notice go out
	a.Hub().CloseAll()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	servers.Shutdown(ctx)
	sessions.Shutdown()
	return nil
}

func isFlagSet(fs *flag.FlagSet, name string) bool {
	found := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == name {
			found = true
		}
	})
	return found
}

func newLogger(level string) *slog.Logger {
	var lv slog.Level
	switch level {
	case "debug":
		lv = slog.LevelDebug
	case "warn":
		lv = slog.LevelWarn
	case "error":
		lv = slog.LevelError
	default:
		lv = slog.LevelInfo
	}
	// Logs must never contain pairing codes, cookie tokens, command text or
	// terminal output (AC-8.5). debug is no exception: redaction happens at the
	// call sites; this only sets the level.
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: lv}))
}

// cleanupLegacyRCFiles removes temporary rcfiles that older versions (with
// shell integration) left in the runtime directory.
func cleanupLegacyRCFiles(runDir string, log *slog.Logger) {
	entries, err := os.ReadDir(runDir)
	if err != nil {
		return
	}
	n := 0
	for _, e := range entries {
		if !e.IsDir() && len(e.Name()) > 3 && e.Name()[:3] == "rc-" {
			if os.Remove(filepath.Join(runDir, e.Name())) == nil {
				n++
			}
		}
	}
	if n > 0 {
		log.Debug("removed legacy rcfiles", "count", n)
	}
}

// currentExe returns this process's executable path. It must be read at
// startup: once an upgrade replaces the file on disk, /proc/self/exe reads
// "…/webterm (deleted)", and the new file at that same path is exactly what we
// want to exec.
func currentExe() string {
	p, err := os.Executable()
	if err != nil {
		return ""
	}
	return strings.TrimSuffix(p, " (deleted)")
}

// inheritedListeners turns the snapshot's listener fds into the name → fd map
// that Listen expects.
func inheritedListeners(snap *handoff.Snapshot) map[string]int {
	if snap == nil || len(snap.Listeners) == 0 {
		return nil
	}
	out := make(map[string]int, len(snap.Listeners))
	for _, l := range snap.Listeners {
		out[l.Name] = l.FD
	}
	return out
}

// hotReexec performs the hot upgrade (ADR-0016): preflight, freeze, snapshot,
// close connections, exec. It returns only on failure; on success the process
// image has been replaced.
func hotReexec(exe string, serveArgs []string, a *agent.Agent, sessions *session.Manager, servers *agent.Servers, log *slog.Logger) error {
	if exe == "" {
		return errors.New("cannot determine this process's executable path")
	}
	if fi, err := os.Stat(exe); err != nil || fi.IsDir() || fi.Mode()&0o111 == 0 {
		return fmt.Errorf("%s is not an executable file (has the upgrade installed the new binary there yet?)", exe)
	}
	// 1. Preflight: can the new binary read this snapshot schema? There is no
	// way back after exec, so ask first.
	probe := &handoff.Snapshot{Schema: handoff.Schema, InstanceID: sessions.InstanceID(), FromVersion: version}
	if err := handoff.Check(exe, probe, 15*time.Second); err != nil {
		return err
	}
	// 2. Freeze: both loops stop at a safe point.
	if err := sessions.Freeze(3 * time.Second); err != nil {
		return err
	}
	// 3. Snapshot.
	snap, err := sessions.Export(version)
	if err != nil {
		sessions.Thaw()
		return err
	}
	lns, lnFiles, err := servers.ExportListeners()
	if err != nil {
		snap.CloseFDs()
		sessions.Thaw()
		return err
	}
	snap.Listeners = lns
	memf, err := handoff.Write(snap)
	if err != nil {
		for _, f := range lnFiles {
			f.Close()
		}
		snap.CloseFDs()
		sessions.Thaw()
		return err
	}
	// 4. Tell users what is happening, then close connections. Clients
	// reconnect and resume from out_seq, so the UI barely notices.
	a.Hub().NoticeAll("info", "Upgrading webterm. Sessions are kept and will reconnect shortly.")
	time.Sleep(300 * time.Millisecond)
	a.Hub().CloseAll()
	log.Info("hot upgrade: exec new binary", "exe", exe, "sessions", len(snap.Sessions), "generation", snap.Generation)
	// 5. exec. The control socket and SQLite fds are CLOEXEC and go away with
	// the old image; the new process reopens them.
	err = handoff.Exec(exe, serveArgs, int(memf.Fd()))
	// Only reached on failure: roll everything back.
	memf.Close()
	for _, f := range lnFiles {
		f.Close()
	}
	snap.CloseFDs()
	sessions.Thaw()
	return fmt.Errorf("exec %s: %w", exe, err)
}
