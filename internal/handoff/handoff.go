// Package handoff 是热升级的交接层（ADR-0016）：把会话状态从旧进程搬到
// 原地 exec 出来的新进程。
//
// 它只管【搬】：类型、编码、memfd、预检、exec。什么状态该进快照由
// internal/session 决定（Session 结构体里"不能丢"的那部分就是这里的 Session），
// 怎么用 fd 重建会话也在那边。这样包依赖是单向的：session → handoff。
//
// 快照走 memfd：只在内存里，不落盘（不变式 3）；fd 随 exec 继承给新进程，
// 新进程读完就关。
package handoff

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/sunhaijun/webterm/internal/oscparse"
)

// Schema 是快照格式的版本。规则：只加字段不删字段，新进程对缺失字段取零值；
// 不兼容的改动升这个号，旧进程的预检就会在 exec 之前失败。
const Schema = 1

// FlagName 是新进程接收快照 fd 的 flag 名（serve --handoff-fd=N）。
const FlagName = "handoff-fd"

// Listener 是一个随 exec 继承的监听 socket。
type Listener struct {
	Name string `json:"name"` // "http" / "https"
	FD   int    `json:"fd"`
}

// PendingInput 是已入队但还没写进 PTY 的一段输入。
type PendingInput struct {
	ClientID string `json:"client_id"`
	Data     []byte `json:"data"`
}

// Session 是一个会话"不能丢"的全部状态。字段清单见
// docs/50-backend/session-manager.md §热升级交接。
type Session struct {
	SID       uint16    `json:"sid"`
	PtmxFD    int       `json:"ptmx_fd"`   // -1 = 没有（会话已退出）
	ShellPID  int       `json:"shell_pid"` // 0 = 没有
	RCPath    string    `json:"rc_path,omitempty"`
	CreatedAt time.Time `json:"created_at"`

	Name        string    `json:"name,omitempty"`
	NameManual  bool      `json:"name_manual,omitempty"`
	CWD         string    `json:"cwd"`
	Status      string    `json:"status"`
	ExitCode    *int      `json:"exit_code,omitempty"`
	Cols        uint16    `json:"cols"`
	Rows        uint16    `json:"rows"`
	Integration string    `json:"integration"`
	PromptState string    `json:"prompt_state,omitempty"`
	HelloSeen   bool      `json:"hello_seen,omitempty"`
	LastMark    time.Time `json:"last_mark"`
	LastInput   time.Time `json:"last_input"`

	RingBase uint64 `json:"ring_base"`
	RingData []byte `json:"ring_data"`

	InQueued map[string]uint64 `json:"in_queued,omitempty"`
	InAck    map[string]uint64 `json:"in_ack,omitempty"`

	OSC      oscparse.State `json:"osc"`
	PendCmd  string         `json:"pend_cmd,omitempty"`
	CurCmdID *int64         `json:"cur_cmd_id,omitempty"`
	CurCmdAt time.Time      `json:"cur_cmd_at"`

	UnmarkedRuns  int  `json:"unmarked_runs,omitempty"`
	UnmarkedInput bool `json:"unmarked_input,omitempty"`

	Pending []PendingInput `json:"pending,omitempty"`
}

// Snapshot 是一次交接的全部内容。
type Snapshot struct {
	Schema      int        `json:"schema"`
	Generation  int        `json:"generation"` // 新进程的代数：每交接一次 +1
	FromVersion string     `json:"from_version"`
	InstanceID  string     `json:"instance_id"`
	NextSID     uint16     `json:"next_sid"`
	Listeners   []Listener `json:"listeners"`
	Sessions    []Session  `json:"sessions"`
}

// Meta 返回不含缓冲与待写输入的副本 —— 预检只需要验 schema 与字段形状，
// 不必把几十 MiB 的环形缓冲喂给子进程。
func (s *Snapshot) Meta() *Snapshot {
	out := *s
	out.Sessions = make([]Session, len(s.Sessions))
	for i, se := range s.Sessions {
		se.RingData = nil
		se.Pending = nil
		out.Sessions[i] = se
	}
	return &out
}

// CloseFDs 关掉快照里为交接 dup 出来的会话 fd（交接中止时用）。监听 fd 由
// agent 侧的 ExportListeners 返回的 *os.File 负责。
func (s *Snapshot) CloseFDs() {
	for i := range s.Sessions {
		if s.Sessions[i].PtmxFD >= 0 {
			unix.Close(s.Sessions[i].PtmxFD)
			s.Sessions[i].PtmxFD = -1
		}
	}
}

// Validate 是新进程（handoff-check 与真正的恢复）对快照的检查。
func Validate(s *Snapshot) error {
	if s == nil {
		return errors.New("handoff: 快照为空")
	}
	if s.Schema <= 0 || s.Schema > Schema {
		return fmt.Errorf("handoff: 快照 schema %d，本版本只认 1..%d —— 新二进制比快照旧？", s.Schema, Schema)
	}
	if s.InstanceID == "" {
		return errors.New("handoff: 快照缺 instance_id")
	}
	seen := make(map[uint16]bool, len(s.Sessions))
	for _, se := range s.Sessions {
		if se.SID == 0 || seen[se.SID] {
			return fmt.Errorf("handoff: 会话 sid %d 非法或重复", se.SID)
		}
		seen[se.SID] = true
		if se.Status == "running" && (se.PtmxFD < 0 || se.ShellPID <= 0) {
			return fmt.Errorf("handoff: 运行中的会话 %d 缺 ptmx fd 或 pid", se.SID)
		}
	}
	return nil
}

// Encode / Decode 是快照的线格式（JSON）。
func Encode(s *Snapshot) ([]byte, error) { return json.Marshal(s) }

func Decode(r io.Reader) (*Snapshot, error) {
	var s Snapshot
	dec := json.NewDecoder(r)
	if err := dec.Decode(&s); err != nil {
		return nil, fmt.Errorf("handoff: 解码快照: %w", err)
	}
	if err := Validate(&s); err != nil {
		return nil, err
	}
	return &s, nil
}

// Write 把快照写进一个只在内存里的文件，返回它（已 seek 到 0，已清 CLOEXEC，
// 可以直接随 exec 继承）。
func Write(s *Snapshot) (*os.File, error) {
	raw, err := Encode(s)
	if err != nil {
		return nil, err
	}
	f, err := memFile()
	if err != nil {
		return nil, err
	}
	if _, err := f.Write(raw); err != nil {
		f.Close()
		return nil, fmt.Errorf("handoff: 写快照: %w", err)
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		f.Close()
		return nil, err
	}
	if err := Inherit(int(f.Fd())); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

// memFile 造一个匿名的内存文件：优先 memfd，没有（老内核 / 某些容器）就退到
// tmpfs 上的 /dev/shm 并立刻 unlink —— 两者都不落磁盘。
func memFile() (*os.File, error) {
	fd, err := unix.MemfdCreate("webterm-handoff", 0)
	if err == nil {
		return os.NewFile(uintptr(fd), "memfd:webterm-handoff"), nil
	}
	f, err2 := os.CreateTemp("/dev/shm", "webterm-handoff-*")
	if err2 != nil {
		return nil, fmt.Errorf("handoff: memfd_create: %v；/dev/shm 也不可用: %w", err, err2)
	}
	_ = os.Remove(f.Name())
	return f, nil
}

// Read 在新进程里读回快照并关掉 fd。
func Read(fd int) (*Snapshot, error) {
	f := os.NewFile(uintptr(fd), "handoff")
	if f == nil {
		return nil, fmt.Errorf("handoff: fd %d 无效", fd)
	}
	defer f.Close()
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	return Decode(f)
}

// Inherit 清掉 fd 的 CLOEXEC，让它活过 exec。Go 默认给所有 fd 置 CLOEXEC。
func Inherit(fd int) error {
	if _, err := unix.FcntlInt(uintptr(fd), unix.F_SETFD, 0); err != nil {
		return fmt.Errorf("handoff: 清 fd %d 的 CLOEXEC: %w", fd, err)
	}
	return nil
}

// Check 是预检：以子进程跑【新二进制】的 handoff-check，把元数据快照喂给它。
// 读不了就在这里失败 —— exec 之后没有回头路。
func Check(exe string, meta *Snapshot, timeout time.Duration) error {
	raw, err := Encode(meta)
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, "handoff-check")
	cmd.Stdin = bytes.NewReader(raw)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	done := make(chan error, 1)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("handoff: 起不来新二进制 %s: %w", exe, err)
	}
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			return fmt.Errorf("handoff: 新二进制拒绝了快照: %s", bytes.TrimSpace(out.Bytes()))
		}
		if !bytes.HasPrefix(bytes.TrimSpace(out.Bytes()), []byte("ok schema=")) {
			return fmt.Errorf("handoff: 新二进制的预检输出不对: %q", out.String())
		}
		return nil
	case <-time.After(timeout):
		_ = cmd.Process.Kill()
		return errors.New("handoff: 新二进制预检超时")
	}
}

// CheckOutput 是 handoff-check 成功时打的那一行。
func CheckOutput() string { return "ok schema=" + strconv.Itoa(Schema) }

// Exec 原地换成新二进制。只在出错时返回。
//
// argv 应当是 serve 的完整参数（不含 --handoff-fd），这里补上快照 fd。
func Exec(exe string, argv []string, fd int) error {
	args := append([]string{exe}, argv...)
	args = append(args, "--"+FlagName+"="+strconv.Itoa(fd))
	return syscall.Exec(exe, args, os.Environ())
}

// StripFlag 去掉参数里的 --handoff-fd=N（新进程再交接时要用原参数）。
func StripFlag(args []string) []string {
	out := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--"+FlagName || a == "-"+FlagName {
			i++ // 值在下一个
			continue
		}
		if len(a) > len(FlagName)+3 && (a[:len(FlagName)+3] == "--"+FlagName+"=" || a[:len(FlagName)+2] == "-"+FlagName+"=") {
			continue
		}
		out = append(out, a)
	}
	return out
}
