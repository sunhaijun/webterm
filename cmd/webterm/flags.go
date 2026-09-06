package main

import (
	"flag"
	"os"
	"path/filepath"
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

// baseURL 返回给用户看的服务地址。
func (c *commonFlags) baseURL(httpPort int) string {
	if c.dev {
		return "http://127.0.0.1:" + itoa(httpPort)
	}
	return "https://" + c.domain
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

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	if neg {
		return "-" + string(b)
	}
	return string(b)
}
