// Command webterm 是 agent 的入口。
//
// 一个二进制就是完整的服务：自带前端资源、自己终结 TLS、自己做认证、
// 自己管会话（ADR-0002）。
package main

import (
	"errors"
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
  webterm install [选项]         用这个二进制本身装成系统服务（不给 --domain 就用公网 IP）
  webterm serve [选项]           启动服务
  webterm pair                   生成新的配对码（打印 URL + 二维码）
  webterm devices [子命令]        设备管理：list | revoke <id> | revoke-all
  webterm doctor [--acme]        检查部署前置条件；--acme 再用 staging 实签一次
  webterm update                 升级到最新版（按上次的安装参数重装；默认热升级，会话保留）
  webterm reload [--when-idle]   让运行中的 agent 原地换成磁盘上的新二进制，会话保留
  webterm version                版本信息

不带子命令直接跑 webterm，会打印一张状态总览（服务、证书、设备、地址）。

"webterm serve --help" 查看 serve 的全部选项。
`

func main() {
	// 裸跑给一张状态总览而不是用法 —— 日常要问的是"现在正常吗"。
	// 用法用 --help 拿。
	if len(os.Args) < 2 {
		if err := runStatus(); err != nil {
			fmt.Fprintf(os.Stderr, "\n错误：%v\n", err)
			os.Exit(1)
		}
		return
	}
	var err error
	switch os.Args[1] {
	case "install":
		err = runInstall(os.Args[2:])
	case "serve":
		err = runServe(os.Args[2:])
	case "pair":
		err = runPair(os.Args[2:])
	case "devices":
		err = runDevices(os.Args[2:])
	case "doctor":
		err = runDoctor(os.Args[2:])
	case "update":
		err = runUpdate(os.Args[2:])
	case "reload":
		err = runReload(os.Args[2:])
	case "handoff-check":
		err = runHandoffCheck()
	case "version":
		fmt.Printf("webterm %s\n", version)
	case "-h", "--help", "help":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "未知子命令 %q\n\n%s", os.Args[1], usage)
		os.Exit(2)
	}
	var code exitCode
	if errors.As(err, &code) {
		os.Exit(int(code))
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "\n错误：%v\n", err)
		os.Exit(1)
	}
}
