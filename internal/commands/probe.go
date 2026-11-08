package commands

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// probeTimeout bounds one probe; claude answers in about a second.
const probeTimeout = 5 * time.Second

// deadEndpoint is where the probe's network goes: nothing listens on port 9
// (discard), so claude can't reach Anthropic and spends no usage.
const deadEndpoint = "http://127.0.0.1:9"

// probeFlags make claude print its init message without side effects: no
// hooks, plugin sync or auto-memory (--bare), no MCP servers, no transcript.
var probeFlags = []string{"-p", "--bare", "--strict-mcp-config", "--no-session-persistence", "--output-format", "stream-json", "--verbose", "x"}

// Result is what claude's init message says.
type Result struct {
	Version  string
	Commands []string
	Skills   []string
}

// Prober runs and caches claude's init probe, keyed by the resolved paths of
// the command (the native executable's path carries the version).
type Prober struct {
	dir   string
	mu    sync.Mutex
	cache map[string]Result
}

// NewProber returns a prober that runs claude in dir (created 0700 on use).
func NewProber(dir string) *Prober {
	return &Prober{dir: dir, cache: map[string]Result{}}
}

// Forget drops the cache, so the next Get asks claude again (Refresh).
func (p *Prober) Forget() {
	p.mu.Lock()
	p.cache = map[string]Result{}
	p.mu.Unlock()
}

// Get returns the init message of the claude that command runs, from the cache
// if that executable was probed before. Failures aren't cached.
func (p *Prober) Get(ctx context.Context, command []string) (Result, error) {
	if len(command) == 0 {
		return Result{}, errors.New("no command")
	}
	key := cacheKey(command)
	p.mu.Lock()
	defer p.mu.Unlock()
	if r, ok := p.cache[key]; ok {
		return r, nil
	}
	r, err := p.run(ctx, command)
	if err != nil {
		return Result{}, err
	}
	p.cache[key] = r
	return r, nil
}

func cacheKey(command []string) string {
	parts := make([]string, len(command))
	for i, c := range command {
		if r, err := filepath.EvalSymlinks(c); err == nil {
			c = r
		}
		parts[i] = c
	}
	return strings.Join(parts, "\x00")
}

func (p *Prober) run(ctx context.Context, command []string) (Result, error) {
	if err := os.MkdirAll(p.dir, 0o700); err != nil {
		return Result{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, command[0], append(append([]string{}, command[1:]...), probeFlags...)...)
	cmd.Dir = p.dir
	cmd.Env = append(os.Environ(),
		"HTTPS_PROXY="+deadEndpoint, "HTTP_PROXY="+deadEndpoint, "ALL_PROXY="+deadEndpoint,
		"https_proxy="+deadEndpoint, "http_proxy="+deadEndpoint, "all_proxy="+deadEndpoint,
		"NO_PROXY=", "no_proxy=", "ANTHROPIC_BASE_URL="+deadEndpoint,
	)
	// Its own process group, so stopping it stops anything it started too.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	out, err := cmd.StdoutPipe()
	if err != nil {
		return Result{}, err
	}
	if err := cmd.Start(); err != nil {
		return Result{}, err
	}
	defer func() {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = cmd.Wait()
	}()
	return readInit(ctx, bufio.NewReaderSize(out, 64<<10))
}

// maxProbeLines bounds how far the probe reads looking for the init message.
const maxProbeLines = 50

// readInit reads stream-json lines until the init message. Other system
// messages may come first (2.1.319 starts with "ui_invalidate"); anything
// else means the session has begun without one.
func readInit(ctx context.Context, r *bufio.Reader) (Result, error) {
	for range maxProbeLines {
		line, err := r.ReadString('\n')
		if err != nil && line == "" {
			if ctx.Err() != nil {
				return Result{}, fmt.Errorf("no init message within %v", probeTimeout)
			}
			return Result{}, errors.New("it exited without an init message")
		}
		var m struct {
			Type     string   `json:"type"`
			Subtype  string   `json:"subtype"`
			Version  string   `json:"claude_code_version"`
			Commands []string `json:"slash_commands"`
			Skills   []string `json:"skills"`
		}
		if json.Unmarshal([]byte(line), &m) != nil {
			continue // a stray warning on stdout
		}
		if m.Type == "system" && m.Subtype == "init" {
			return Result{Version: m.Version, Commands: m.Commands, Skills: m.Skills}, nil
		}
		if m.Type != "system" {
			return Result{}, fmt.Errorf("a %q message came before any init message", m.Type)
		}
	}
	return Result{}, fmt.Errorf("no init message in its first %d lines", maxProbeLines)
}

// interpreters run claude installed from npm (claude's cli.js is argv[1]).
var interpreters = map[string]bool{"node": true, "bun": true, "deno": true, "bash": true, "sh": true}

// ProbeCommand is how to run the claude in front again: its executable, or
// the interpreter and script it was started with.
func ProbeCommand(exe string, argv []string) []string {
	if exe == "" {
		return nil
	}
	if interpreters[filepath.Base(exe)] && len(argv) > 1 {
		return []string{exe, argv[1]}
	}
	return []string{exe}
}
