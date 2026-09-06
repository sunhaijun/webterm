package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"
)

// runDoctor 逐项检查部署前置条件，给出【可读的】诊断而不是 Go 的 error 堆栈
// （US-7.2 / AC-1.13）。部署前先跑它。
func runDoctor(args []string) error {
	fs := flag.NewFlagSet("doctor", flag.ExitOnError)
	var c commonFlags
	c.register(fs)
	httpPort := fs.Int("http-port", 80, "ACME 挑战端口")
	httpsPort := fs.Int("https-port", 443, "HTTPS 端口")
	if err := fs.Parse(args); err != nil {
		return err
	}

	var failed int
	check := func(name string, fn func() (string, error)) {
		detail, err := fn()
		switch {
		case err != nil:
			failed++
			fmt.Printf("  ✗ %s\n      %s\n", name, indent(err.Error()))
		case detail != "":
			fmt.Printf("  ✓ %s（%s）\n", name, detail)
		default:
			fmt.Printf("  ✓ %s\n", name)
		}
	}

	fmt.Println("webterm doctor")
	fmt.Println()

	check("bash 可用", func() (string, error) {
		out, err := exec.Command("bash", "--version").Output()
		if err != nil {
			return "", fmt.Errorf("找不到 bash。v0.1 的 shell 集成只支持 bash；\n" +
				"终端本身仍然可用，但没有命令历史、CWD 显示和输入模式自动切换")
		}
		v := strings.SplitN(string(out), "\n", 2)[0]
		return strings.TrimPrefix(v, "GNU bash, "), nil
	})

	check("数据目录可写", func() (string, error) {
		if err := os.MkdirAll(c.dataDir, 0o700); err != nil {
			return "", fmt.Errorf("无法创建 %s：%v", c.dataDir, err)
		}
		f, err := os.CreateTemp(c.dataDir, ".doctor-*")
		if err != nil {
			return "", fmt.Errorf("%s 不可写：%v", c.dataDir, err)
		}
		f.Close()
		os.Remove(f.Name())
		return c.dataDir, nil
	})

	if c.dev {
		fmt.Println("\n（--dev 模式：跳过域名、DNS 与端口检查）")
		return summarize(failed)
	}
	if c.domain == "" {
		fmt.Println("  ✗ 域名\n      没有指定 --domain。ACME 需要它，Origin 校验也需要它。")
		failed++
		return summarize(failed)
	}

	var resolved []string
	check("DNS 解析", func() (string, error) {
		ips, err := net.LookupHost(c.domain)
		if err != nil {
			return "", fmt.Errorf("解析 %s 失败：%v\n"+
				"确认已经加了 A/AAAA 记录，并等 TTL 过期", c.domain, err)
		}
		resolved = ips
		return strings.Join(ips, ", "), nil
	})

	check("DNS 指向本机", func() (string, error) {
		if len(resolved) == 0 {
			return "", fmt.Errorf("上一步没解析出结果，跳过")
		}
		public, err := publicIP()
		if err != nil {
			return "", fmt.Errorf("查不到本机公网 IP（%v），请手工核对：\n"+
				"  dig +short %s\n  curl -s ifconfig.me", err, c.domain)
		}
		for _, ip := range resolved {
			if ip == public {
				return "本机公网 IP " + public, nil
			}
		}
		return "", fmt.Errorf("%s 解析到 %s，但本机公网 IP 是 %s。\n"+
			"HTTP-01 挑战会打到解析出的那台机器上，不改的话证书签不下来。\n"+
			"确认改的是 A/AAAA 记录，而不是 CNAME 到别处",
			c.domain, strings.Join(resolved, ", "), public)
	})

	for _, p := range []int{*httpPort, *httpsPort} {
		check(fmt.Sprintf("%d 端口可用", p), func() (string, error) {
			ln, err := net.Listen("tcp", fmt.Sprintf(":%d", p))
			if err != nil {
				if strings.Contains(err.Error(), "permission denied") {
					return "", fmt.Errorf("没有绑定权限（1024 以下需要特权）。推荐：\n" +
						"  sudo setcap 'cap_net_bind_service=+ep' $(command -v webterm)\n" +
						"不要用 root 跑 webterm —— 那等于把 root shell 挂到公网")
				}
				return "", fmt.Errorf("被占用了。查是谁：\n  ss -lntp | grep :%d", p)
			}
			ln.Close()
			return "", nil
		})
	}

	return summarize(failed)
}

func summarize(failed int) error {
	fmt.Println()
	if failed == 0 {
		fmt.Println("全部通过。第一次部署建议先用 --acme-staging 调通，")
		fmt.Println("正式环境的 Let's Encrypt 限流窗口是一周，撞上了只能等。")
		return nil
	}
	return fmt.Errorf("%d 项检查未通过，见上面的说明", failed)
}

func publicIP() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.ipify.org", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 64))
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

func indent(s string) string { return strings.ReplaceAll(s, "\n", "\n      ") }
