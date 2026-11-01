package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/sunhaijun/webterm/internal/agent"
)

// commonFlags 是所有子命令共享的定位类参数。
type commonFlags struct {
	dataDir string
	domain  string
	dev     bool
}

func (c *commonFlags) register(fs *flag.FlagSet) {
	fs.StringVar(&c.dataDir, "data-dir", defaultDataDir(), "数据目录")
	fs.StringVar(&c.domain, "domain", "", "域名（生产必填，ACME 与 Origin 校验都要用）")
	fs.BoolVar(&c.dev, "dev", false, "本地开发：127.0.0.1 明文，不申请证书")
}

// baseURL 返回给用户看的服务地址：配对 URL 和二维码都由它拼出来。
// 生产走 agent.ExternalURL（非 443 必须带端口，否则扫码打不开）。
func (c *commonFlags) baseURL(httpPort, httpsPort int) string {
	if c.dev {
		return "http://127.0.0.1:" + strconv.Itoa(httpPort)
	}
	return agent.ExternalURL(c.domain, httpsPort)
}

// envList 收集可重复的 --session-env KEY=VAL（AC-7.8）。
//
// 【就地校验，不静默吞】：写错的一条在解析时就报出来，而不是等到某个会话里
// 变量莫名其妙没生效再去猜 —— 环境变量的错误本来就很难在事后看出来。
type envList []string

func (e *envList) String() string { return strings.Join(*e, " ") }

// fixedSessionEnv 是 webterm 自己定的口径，不接受用户覆盖：
// TERM 决定 xterm.js 那侧的能力匹配，WEBTERM_SESSION 是会话标识。
var fixedSessionEnv = map[string]string{
	"TERM":            "固定为 xterm-256color —— 它与 xterm.js 的能力集最匹配",
	"WEBTERM_SESSION": "是会话标识，由 agent 分配",
}

func (e *envList) Set(v string) error {
	k, _, ok := strings.Cut(v, "=")
	if !ok || k == "" {
		return fmt.Errorf("要写成 KEY=VAL，收到 %q", v)
	}
	if strings.ContainsAny(k, " \t\n\r\x00=") {
		return fmt.Errorf("变量名 %q 不合法（不能含空白）", k)
	}
	if why, bad := fixedSessionEnv[k]; bad {
		return fmt.Errorf("%s 不能用 --session-env 改：它%s", k, why)
	}
	*e = append(*e, v)
	return nil
}

// defaultDataDir 遵循 XDG：$XDG_DATA_HOME/webterm，否则 ~/.local/share/webterm。
func defaultDataDir() string {
	if d := os.Getenv("XDG_DATA_HOME"); d != "" {
		return filepath.Join(d, "webterm")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ".webterm"
	}
	return filepath.Join(home, ".local", "share", "webterm")
}
