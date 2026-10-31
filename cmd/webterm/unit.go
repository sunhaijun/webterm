package main

import (
	"os/exec"
	"strings"
)

// unitKind 是这台机器上装出来的 systemd 单元。ADR-0034 起 install.sh 装的是
// 系统服务（以安装者本人运行）；之前装的机器还是用户服务，迁移前两种都会遇到。
type unitKind int

const (
	unitNone unitKind = iota
	unitSystem
	unitUser
)

// detectUnit 问 systemd 有没有 webterm 单元。LoadState 普通用户就能查，不需要 sudo。
// 系统单元优先：迁移到一半两边都在时，系统单元才是要的那个。
func detectUnit() unitKind {
	if unitLoaded("systemctl", "show", "webterm", "-p", "LoadState", "--value") {
		return unitSystem
	}
	if unitLoaded("systemctl", "--user", "show", "webterm", "-p", "LoadState", "--value") {
		return unitUser
	}
	return unitNone
}

func unitLoaded(name string, args ...string) bool {
	out, err := exec.Command(name, args...).Output()
	return err == nil && strings.TrimSpace(string(out)) == "loaded"
}

// active 报告单元是不是 active。
func (k unitKind) active() bool {
	var args []string
	switch k {
	case unitSystem:
		args = []string{"is-active", "--quiet", "webterm"}
	case unitUser:
		args = []string{"--user", "is-active", "--quiet", "webterm"}
	default:
		return false
	}
	return exec.Command("systemctl", args...).Run() == nil
}

// ctl 给出提示文案里用的 systemctl 命令。系统服务的启停要 sudo，只读的不用。
func (k unitKind) ctl(verb string) string {
	switch k {
	case unitUser:
		return "systemctl --user " + verb + " webterm"
	default:
		switch verb {
		case "status", "show", "is-active", "cat":
			return "systemctl " + verb + " webterm"
		}
		return "sudo systemctl " + verb + " webterm"
	}
}

// journal 给出看日志的命令。系统服务下 agent 自己的日志不用 sudo 就能读，
// 但 systemd 关于这个 unit 的记录（启停、OOM、崩溃）在系统日志里，排障时要 sudo。
func (k unitKind) journal() string {
	if k == unitUser {
		return "journalctl --user -u webterm"
	}
	return "sudo journalctl -u webterm"
}
