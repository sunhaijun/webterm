// Command webterm 是 agent 的入口。
//
// m1 只落地协议与会话核心（internal/*），serve / pair / doctor 等子命令
// 在 m2（feat/50-agent-serve）。这里先保证 CGO_ENABLED=0 的静态构建这条
// 不变式从第一天起就有 CI 守着（AC-8.1）。
package main

import (
	"fmt"
	"os"
)

var version = "0.1.0-dev"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "version" {
		fmt.Printf("webterm %s\n", version)
		return
	}
	fmt.Fprintf(os.Stderr, "webterm %s —— serve / pair / doctor 尚未实现（m2）\n", version)
	os.Exit(1)
}
