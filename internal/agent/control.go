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

// 本机控制 socket（ADR-0016）：`<data-dir>/run/agent.sock`，0600。
//
// 给 `webterm reload` / install.sh 用：探测运行中的 agent 支不支持热升级、
// 问它忙不忙（--when-idle）、让它 reexec。一行 JSON 请求，一行 JSON 应答。
// 不走 HTTP：那条路要设备 Cookie，而升级脚本跑在服务器本机、以同一个用户
// 身份 —— 文件权限就是它的认证。

// ControlStatus 是 status 应答。
type ControlStatus struct {
	Version    string `json:"version"`
	PID        int    `json:"pid"`
	Generation int    `json:"generation"`
	InstanceID string `json:"instance_id"`
	Sessions   int    `json:"sessions"`
	Busy       int    `json:"busy"`
	Handoff    bool   `json:"handoff"` // 支持热升级交接
	// LastError 是最近一次热升级中止的原因（成功接手的新进程里为空）。
	// webterm reload 靠它立刻报错，而不是等到超时。
	LastError string `json:"last_error,omitempty"`
}

// ControlRequest / ControlResponse 是线格式。
type ControlRequest struct {
	Op string `json:"op"` // "status" | "reexec"
}

type ControlResponse struct {
	OK     bool           `json:"ok"`
	Error  string         `json:"error,omitempty"`
	Status *ControlStatus `json:"status,omitempty"`
}

// ControlDeps 是控制面需要的两个回调。Reexec 只负责【触发】（把请求交给 serve 的
// 主循环），不等它完成 —— 完成的标志是新进程接手后 status.generation +1。
type ControlDeps struct {
	Status func() ControlStatus
	Reexec func() error
}

// ControlServer 是监听中的控制 socket。
type ControlServer struct {
	ln   net.Listener
	path string
	log  *slog.Logger
}

// ServeControl 在 path 上开控制 socket。残留的旧 socket 文件先删（上次崩溃、或
// 刚被 exec 掉的旧进程留下的）。
func ServeControl(path string, deps ControlDeps, log *slog.Logger) (*ControlServer, error) {
	if log == nil {
		log = slog.Default()
	}
	_ = os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, fmt.Errorf("控制 socket %s: %w", path, err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		ln.Close()
		return nil, fmt.Errorf("控制 socket 权限: %w", err)
	}
	cs := &ControlServer{ln: ln, path: path, log: log}
	go cs.accept(deps)
	return cs, nil
}

// Path 返回 socket 路径。
func (c *ControlServer) Path() string { return c.path }

// Close 停止监听并删掉 socket 文件。
func (c *ControlServer) Close() error {
	err := c.ln.Close()
	_ = os.Remove(c.path)
	return err
}

func (c *ControlServer) accept(deps ControlDeps) {
	for {
		conn, err := c.ln.Accept()
		if err != nil {
			return // 关了
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
		c.reply(conn, ControlResponse{Error: "请求不是合法 JSON"})
		return
	}
	switch req.Op {
	case "status":
		st := deps.Status()
		c.reply(conn, ControlResponse{OK: true, Status: &st})
	case "reexec":
		if deps.Reexec == nil {
			c.reply(conn, ControlResponse{Error: "此进程不支持热升级"})
			return
		}
		if err := deps.Reexec(); err != nil {
			c.reply(conn, ControlResponse{Error: err.Error()})
			return
		}
		st := deps.Status()
		c.reply(conn, ControlResponse{OK: true, Status: &st})
	default:
		c.reply(conn, ControlResponse{Error: "未知操作 " + req.Op})
	}
}

func (c *ControlServer) reply(conn net.Conn, resp ControlResponse) {
	raw, _ := json.Marshal(resp)
	raw = append(raw, '\n')
	_, _ = conn.Write(raw)
}

// ControlCall 是客户端：连 socket、发一条请求、读一条应答。
// socket 不存在 / 连不上 → ErrNoControl（运行中的 agent 是老版本，或根本没在跑）。
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
		return nil, fmt.Errorf("控制 socket 没有应答: %w", err)
	}
	var resp ControlResponse
	if err := json.Unmarshal(line, &resp); err != nil {
		return nil, fmt.Errorf("控制 socket 应答不是合法 JSON: %w", err)
	}
	if !resp.OK {
		return &resp, errors.New(resp.Error)
	}
	return &resp, nil
}

// ErrNoControl：连不上控制 socket。
var ErrNoControl = errors.New("连不上 agent 的控制 socket")
