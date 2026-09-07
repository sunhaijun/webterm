package main

import (
	"fmt"
	"os"

	"github.com/sunhaijun/webterm/internal/shellinit"
)

// runShellInit 输出 shell 集成脚本，供特殊环境手动接入：
//
//	eval "$(webterm shell-init bash)"
//
// 这是降级路径 —— 正常情况下 agent 会用临时 rcfile 自动注入，用户不需要
// 改任何 dotfile。但 exec 换了 shell、su 切了用户、进了容器之后集成会失效，
// 那时手动 eval 一下就能接回来。
func runShellInit(args []string) error {
	shell := "bash"
	if len(args) > 0 {
		shell = args[0]
	}
	if shell != "bash" {
		return fmt.Errorf("v0.1 只支持 bash（zsh 在 v0.2，fish 再说）")
	}
	_, err := os.Stdout.WriteString(shellinit.Script())
	return err
}
