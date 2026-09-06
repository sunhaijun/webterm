package main

import "fmt"

// runShellInit 输出 shell 集成脚本，供特殊环境手动 eval 接入
// （用户 exec 换了 shell、进容器、su 切用户等）。
//
// 脚本本体在 m5（internal/shellinit）。
func runShellInit(args []string) error {
	shell := "bash"
	if len(args) > 0 {
		shell = args[0]
	}
	if shell != "bash" {
		return fmt.Errorf("v0.1 只支持 bash（zsh 在 v0.2）")
	}
	return fmt.Errorf("shell 集成脚本在 m5 落地（feat/30-shell-integration）")
}
