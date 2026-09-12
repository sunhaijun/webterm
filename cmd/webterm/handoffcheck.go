package main

import (
	"fmt"
	"os"

	"github.com/sunhaijun/webterm/internal/handoff"
)

// handoff-check：热升级预检（ADR-0016）。旧进程在 exec 之前以子进程跑【新二进制】的
// 这个子命令，把元数据快照从 stdin 喂进来 —— 读得懂就打 "ok schema=N" 退 0。
// 读不懂在这里失败，旧进程就中止升级、照常服务；exec 之后没有回头路。
func runHandoffCheck() error {
	if _, err := handoff.Decode(os.Stdin); err != nil {
		return err
	}
	fmt.Println(handoff.CheckOutput())
	return nil
}
