package agent

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"time"
)

// Local control socket (ADR-0016): `<data-dir>/run/agent.sock`, mode 0600.
//
// `webterm reload` and install.sh use it to check whether the running agent
// supports hot upgrade, ask whether it is busy (--when-idle), and tell it to
// re-exec. One line of JSON in, one line of JSON out. It is not HTTP because
// HTTP needs a device cookie, while the upgrade script runs on the server as
// the same user; file permissions are the authentication.

// ControlStatus is the reply to status.
type ControlStatus struct {
	Version    string `json:"version"`
	PID        int    `json:"pid"`
	Generation int    `json:"generation"`
	InstanceID string `json:"instance_id"`
	Sessions   int    `json:"sessions"`
	Busy       int    `json:"busy"`
	Handoff    bool   `json:"handoff"` // supports hot upgrade handoff
	// LastError is why the last hot upgrade was aborted (empty in a new
	// process that took over successfully). webterm reload uses it to fail
	// immediately instead of waiting for a timeout.
	LastError string `json:"last_error,omitempty"`
}

// ControlRequest and ControlResponse are the wire format.
type ControlRequest struct {
	Op string `json:"op"` // "status" | "reexec"
}

type ControlResponse struct {
	OK     bool           `json:"ok"`
	Error  string         `json:"error,omitempty"`
	Status *ControlStatus `json:"status,omitempty"`
}

// ControlDeps holds the two callbacks the control socket needs. Reexec only
// triggers the upgrade (hands the request to serve's main loop) and does not
// wait for it; completion shows up as status.generation + 1 once the new
// process takes over.
type ControlDeps struct {
	Status func() ControlStatus
	Reexec func() error
}

// ControlServer is a listening control socket.
type ControlServer struct {
	ln   net.Listener
	path string
	log  *slog.Logger
}

// ServeControl opens the control socket at path. A stale socket file (left by
// a crash, or by the old process that just exec'd) is removed first.
func ServeControl(path string, deps ControlDeps, log *slog.Logger) (*ControlServer, error) {
	if log == nil {
		log = slog.Default()
	}
	_ = os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, fmt.Errorf("control socket %s: %w", path, err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		ln.Close()
		return nil, fmt.Errorf("chmod control socket: %w", err)
	}
	cs := &ControlServer{ln: ln, path: path, log: log}
	go cs.accept(deps)
	return cs, nil
}

// Path returns the socket path.
func (c *ControlServer) Path() string { return c.path }

// Close stops listening and removes the socket file.
func (c *ControlServer) Close() error {
	err := c.ln.Close()
	_ = os.Remove(c.path)
	return err
}

func (c *ControlServer) accept(deps ControlDeps) {
	for {
		conn, err := c.ln.Accept()
		if err != nil {
			return // closed
		}
		go c.handle(conn, deps)
	}
}

func (c *ControlServer) handle(conn net.Conn, deps ControlDeps) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	var req ControlRequest
	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil && len(line) == 0 {
		return
	}
	if err := json.Unmarshal(line, &req); err != nil {
		c.reply(conn, ControlResponse{Error: "request is not valid JSON"})
		return
	}
	switch req.Op {
	case "status":
		st := deps.Status()
		c.reply(conn, ControlResponse{OK: true, Status: &st})
	case "reexec":
		if deps.Reexec == nil {
			c.reply(conn, ControlResponse{Error: "this process does not support hot upgrade"})
			return
		}
		if err := deps.Reexec(); err != nil {
			c.reply(conn, ControlResponse{Error: err.Error()})
			return
		}
		st := deps.Status()
		c.reply(conn, ControlResponse{OK: true, Status: &st})
	default:
		c.reply(conn, ControlResponse{Error: "unknown op " + req.Op})
	}
}

func (c *ControlServer) reply(conn net.Conn, resp ControlResponse) {
	raw, _ := json.Marshal(resp)
	raw = append(raw, '\n')
	_, _ = conn.Write(raw)
}

// ControlCall is the client: it connects, sends one request and reads one
// reply. If the socket is missing or refuses the connection it returns
// ErrNoControl (the running agent is too old, or not running at all).
func ControlCall(path string, req ControlRequest, timeout time.Duration) (*ControlResponse, error) {
	conn, err := net.DialTimeout("unix", path, timeout)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrNoControl, err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))
	raw, _ := json.Marshal(req)
	if _, err := conn.Write(append(raw, '\n')); err != nil {
		return nil, err
	}
	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil && len(line) == 0 {
		return nil, fmt.Errorf("no reply from control socket: %w", err)
	}
	var resp ControlResponse
	if err := json.Unmarshal(line, &resp); err != nil {
		return nil, fmt.Errorf("control socket reply is not valid JSON: %w", err)
	}
	if !resp.OK {
		return &resp, errors.New(resp.Error)
	}
	return &resp, nil
}

// ErrNoControl means the control socket could not be reached.
var ErrNoControl = errors.New("cannot reach the agent's control socket")
