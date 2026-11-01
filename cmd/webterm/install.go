package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/sunhaijun/webterm/scripts"
)

// runInstall 用二进制里嵌着的 install.sh、以自己为 --binary 安装（ADR-0043 §1）。
//
// 【Go 这边只负责把脚本取出来跑】，不重写安装逻辑 —— 升级路径上的知识
// （setcap 会随替换丢失、单元跟着端口走、迁移不能在自己的会话里做……）
// 只放在 install.sh 一个地方，和 webterm update 当初选「薄壳」同一个理由。
func runInstall(args []string) error {
	self, err := os.Executable()
	if err != nil {
		return fmt.Errorf("找不到自己的路径: %w", err)
	}
	if p, err := filepath.EvalSymlinks(self); err == nil {
		self = p
	}

	f, err := os.CreateTemp("", "webterm-install-*.sh")
	if err != nil {
		return err
	}
	script := f.Name()
	defer os.Remove(script)
	if _, err := f.Write(scripts.InstallSH); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}

	// stdin 直通：脚本中途要 sudo 问密码
	cmd := exec.Command("bash", append([]string{script}, withSelfBinary(self, args)...)...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	err = cmd.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		// 脚本自己已经把错误说清楚了，这里只把退出码带出去，不再补一句「错误：exit status 1」
		return exitCode(ee.ExitCode())
	}
	return err
}

// withSelfBinary 在用户参数前补上 --binary <自己>；用户自己给了 --binary 就尊重它。
func withSelfBinary(self string, args []string) []string {
	for _, a := range args {
		if a == "--binary" || strings.HasPrefix(a, "--binary=") {
			return args
		}
	}
	return append([]string{"--binary", self}, args...)
}

// exitCode 是「子进程已经报过错了，只要带着这个退出码退出」。
type exitCode int

func (e exitCode) Error() string { return fmt.Sprintf("exit status %d", int(e)) }
