package session

import (
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"
)

// 起 shell 时的 OOM 优先级（ADR-0034 §3）。
//
// 系统服务把 agent 设成 -900（内存吃紧时最后才轮到它），会话要和 SSH 登录、tmux 的
// pane 一样是 0。shell 必须在执行任何用户代码之前就是 0 —— 登录 shell 读 ~/.profile
// 时起的常驻进程（ssh-agent 之类）一旦继承 -900 就永久受保护 —— 所以不能等 shell
// 起来再去改 /proc/<pid>/oom_score_adj，而是 fork 的那一下让 agent 自己临时是 0。
//
// 调高不需要特权；调回自己原来的值也不会低于下限（下限是 PID 1 以 root 写进来的那个值），
// 所以这一来一回在普通用户下就能做。

const oomAdjPath = "/proc/self/oom_score_adj"

var (
	// childOOMAdj 是会话 shell 的目标值。只有 agent 自己比它低时才切换。
	// 测试用 SetChildOOMAdjForTest 改它。
	childOOMAdj = 0

	readOOMAdj = func() (int, error) {
		raw, err := os.ReadFile(oomAdjPath)
		if err != nil {
			return 0, err
		}
		return strconv.Atoi(strings.TrimSpace(string(raw)))
	}
	writeOOMAdj = func(v int) error {
		return os.WriteFile(oomAdjPath, []byte(strconv.Itoa(v)), 0)
	}

	// spawnMu 把「调高 → fork → 调回」串起来：oom_score_adj 是进程级的，两个会话
	// 同时起的话，先完成的那个会把值调回去，另一个的子进程就继承到 -900。
	spawnMu sync.Mutex
)

// withChildOOMAdj 在 agent 的 oom_score_adj 临时等于 childOOMAdj 的情况下执行 start。
// agent 本来就不低于它（手动 webterm serve 是 0、用户服务是 200）时什么都不做。
//
// start 必须在子进程 exec 之后才返回（cmd.Start 就是这样）：Go 用 CLONE_VM|CLONE_VFORK
// 起子进程，内核会把 oom_score_adj 的改动同步给共享同一个 mm 的进程，exec 之前调回
// 会把子进程也一起拽回去。
//
// 切换失败从不挡住起 shell：调高失败，子进程继承 agent 的值（退化而已）；调回失败，
// agent 留在目标值，待遇和 tmux 一样。两种都只记日志。
func withChildOOMAdj(start func() error) error {
	spawnMu.Lock()
	defer spawnMu.Unlock()

	self, err := readOOMAdj()
	if err != nil || self >= childOOMAdj {
		return start()
	}
	if err := writeOOMAdj(childOOMAdj); err != nil {
		slog.Warn("起 shell 前调不高 oom_score_adj，会话会继承 agent 的值", "self", self, "want", childOOMAdj, "err", err)
		return start()
	}
	defer func() {
		if err := writeOOMAdj(self); err != nil {
			slog.Warn("起 shell 后调不回 oom_score_adj，agent 留在会话的优先级", "self", self, "now", childOOMAdj, "err", err)
		}
	}()
	return start()
}
