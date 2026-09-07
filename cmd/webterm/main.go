// Command webterm 是 agent 的入口。
//
// 一个二进制就是完整的服务：自带前端资源、自己终结 TLS、自己做认证、
// 自己管会话（ADR-0002）。
package main

import (
	"fmt"
	"os"
)

// version 由构建时注入：
//
//	go build -ldflags "-X main.version=v0.1.0"
//
// 默认值只在从源码直接 go build 时出现。
var version = "dev"

var usage = "webterm " + version + ` —— 浏览器终端 agent

用法:
  webterm serve [选项]           启动服务
  webterm pair                   生成新的配对码（打印 URL + 二维码）
  webterm devices [子命令]        设备管理：list | revoke <id> | revoke-all
  webterm doctor [--domain X]    检查部署前置条件
  webterm shell-init bash        输出 shell 集成脚本（手动接入的降级路径）
  webterm version                版本信息

"webterm serve --help" 查看 serve 的全部选项。
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "serve":
		err = runServe(os.Args[2:])
	case "pair":
		err = runPair(os.Args[2:])
	case "devices":
		err = runDevices(os.Args[2:])
	case "doctor":
		err = runDoctor(os.Args[2:])
	case "shell-init":
		err = runShellInit(os.Args[2:])
	case "version":
		fmt.Printf("webterm %s\n", version)
	case "-h", "--help", "help":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "未知子命令 %q\n\n%s", os.Args[1], usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "\n错误：%v\n", err)
		os.Exit(1)
	}
}
