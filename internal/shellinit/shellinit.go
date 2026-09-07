// Package shellinit 生成注入 bash 的 shell 集成。
//
// 用临时 rcfile 而不是让用户改 dotfile（ADR-0010）：安装体验保持为
// "scp + 跑"，卸载即干净，脚本版本与 agent 版本天然同步。
package shellinit

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Script 返回集成脚本本体（不含 profile 链）。
//
// 它同时是两条路径的内容：rcfile 的后半段，以及
// `webterm shell-init bash` 的输出（供换了 shell / 进容器 / su 之后手动接入）。
func Script() string { return script }

// Options 控制 rcfile 的生成。
type Options struct {
	// Login 为 true 时模拟登录 shell 的初始化语义。
	//
	// 默认应当为 true：用户是从 ssh host 迁移过来的，而 ssh host 给的就是
	// 登录 shell。不这样的话，用户在 ~/.bash_profile 里设的 PATH 会突然消失。
	Login bool
	// Dir 是 rcfile 的落盘目录（agent 的运行时目录，0700）。
	Dir string
}

// Render 生成一个临时 rcfile，返回它的路径。调用方负责在会话结束时删除。
//
// 文件权限 0600，且【不放 /tmp】：/tmp 所有用户可读，且系统清理策略可能
// 在会话运行期间把它删掉。
func Render(sid uint16, opts Options) (string, error) {
	if opts.Dir == "" {
		return "", fmt.Errorf("shellinit: 必须指定运行时目录")
	}
	if err := os.MkdirAll(opts.Dir, 0o700); err != nil {
		return "", fmt.Errorf("shellinit: 创建运行时目录: %w", err)
	}
	var nonce [6]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", err
	}
	path := filepath.Join(opts.Dir, fmt.Sprintf("rc-%d-%s.bash", sid, hex.EncodeToString(nonce[:])))

	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return "", fmt.Errorf("shellinit: 创建 rcfile: %w", err)
	}
	defer f.Close()
	if _, err := f.WriteString(RCFile(opts.Login)); err != nil {
		os.Remove(path)
		return "", err
	}
	return path, nil
}

// RCFile 返回完整 rcfile 的内容：先按模式跑用户配置，再装我们的钩子。
//
// --rcfile 只影响【交互式非登录】shell —— 登录 shell 读 ~/.bash_profile 并
// 忽略 --rcfile。所以不能简单地加 -l，而要在 rcfile 里自己模拟登录语义。
func RCFile(login bool) string {
	var b strings.Builder
	b.WriteString("# webterm 自动生成的临时 rcfile —— 会话结束即删除。\n")
	b.WriteString("# 见 docs/20-architecture/adr/0010-bash-rcfile-injection.md\n\n")

	if login {
		b.WriteString(`# 登录模式：走 profile 链，取第一个存在的。
[ -r /etc/profile ] && . /etc/profile
for __webterm_f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
    [ -r "$__webterm_f" ] && { . "$__webterm_f"; break; }
done
unset __webterm_f

# 【刻意不额外 source ~/.bashrc】。绝大多数人的 .bash_profile 里都有
# . ~/.bashrc，所以它会被加载；如果某人故意不 source，那正是 bash 登录
# shell 的真实语义，我们应当遵守。这样就完全避免了 .bashrc 被重复加载
# （重复 source 常导致 PATH 重复、别名重复定义、prompt 被叠加）。
`)
	} else {
		b.WriteString(`# 非登录模式：只走 bashrc。
[ -r /etc/bash.bashrc ] && . /etc/bash.bashrc
[ -r "$HOME/.bashrc" ] && . "$HOME/.bashrc"
`)
	}

	b.WriteString("\n# 钩子必须装在用户配置【之后】—— 它要包装而不是被覆盖。\n")
	b.WriteString(Script())
	return b.String()
}
