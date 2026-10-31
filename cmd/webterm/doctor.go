package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// warning 是"值得说，但不该拦住部署"的检查结果。
//
// 【区分它和失败很要紧】：install.sh 装之前跑的自检用的是刚下载、
// 还【没 setcap】的临时二进制，它绑不上 80 是必然的 —— 那不是部署
// 条件不满足，而是检查问错了问题（真正上岗的那个会被 setcap）。
// 当成失败的话，任何一次用 80 端口的全新安装都会被自己的自检拦住。
type warning struct{ msg string }

func (w warning) Error() string { return w.msg }

// runDoctor 逐项检查部署前置条件，给出【可读的】诊断而不是 Go 的 error 堆栈
// （US-7.2 / AC-1.13）。部署前先跑它。
func runDoctor(args []string) error {
	fs := flag.NewFlagSet("doctor", flag.ExitOnError)
	var c commonFlags
	c.register(fs)
	httpPort := fs.Int("http-port", 80, "ACME 挑战端口")
	httpsPort := fs.Int("https-port", 443, "HTTPS 端口")
	if err := applyConfig(fs, args); err != nil {
		return err
	}
	if err := fs.Parse(args); err != nil {
		return err
	}

	var failed, warned int
	check := func(name string, fn func() (string, error)) {
		detail, err := fn()
		var w warning
		switch {
		case errors.As(err, &w):
			warned++
			fmt.Printf("  ⚠ %s\n      %s\n", name, indent(w.msg))
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
			return "", fmt.Errorf("找不到 bash（会话默认的 shell）。\n" +
				"装上 bash，或者用 --shell 指定别的 shell（任何支持 -l / -i 的都行）")
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
		return summarize(failed, warned)
	}
	if c.domain == "" {
		fmt.Println("  ✗ 域名\n      没有指定 --domain。ACME 需要它，Origin 校验也需要它。")
		failed++
		return summarize(failed, warned)
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
			if err == nil {
				ln.Close()
				return "", nil
			}
			return classifyPortErr(p, err, portBusy)
		})
	}

	return summarize(failed, warned)
}

// classifyPortErr 把绑定失败翻成结论。
//
// 【没有绑定权限 ≠ 端口被占】。这两件事以前混在一起，结果是：全新安装时
// 自检跑的是还没 setcap 的临时二进制，80 上必然 EACCES，自检报"端口不可用"
// 把安装拦下 —— 而端口其实空着，装完 setcap 就能绑。
//
// 所以 EACCES 时改问一个这个进程答得了的问题：端口上有没有人在听。
//
// 单独抽出来还因为【CI 里造不出真实的 EACCES】—— 那需要特权端口，
// 而 runner 上的权限模型和这里不一样。传入 busy 就能把两条路都测到。
func classifyPortErr(p int, err error, busy func(int) bool) (string, error) {
	occupied := fmt.Errorf("被占用了。查是谁：\n  ss -lntp | grep :%d", p)
	if !errors.Is(err, syscall.EACCES) {
		return "", occupied
	}
	if busy(p) {
		return "", occupied
	}
	return "", warning{fmt.Sprintf("%d 空着，但【当前这个二进制】没有绑定权限（1024 以下需要特权）。\n"+
		"install.sh 装完会自动 setcap，所以这不拦着部署；手动装的话：\n"+
		"  sudo setcap 'cap_net_bind_service=+ep' $(command -v webterm)\n"+
		"不要用 root 跑 webterm —— 那等于把 root shell 挂到公网", p)}
}

// portBusy 报告本机 p 端口上有没有人在听。
//
// 用连接而不是监听来问 —— 监听在特权端口上会因为没权限而失败，
// 那时候拿到的答案是"我绑不上"，不是"有人占着"。
//
// 【局限】：只探回环。有人只绑在某个对外地址上的话这里看不见，
// 那种情况留给启动时真正的 bind —— 它会报 address already in use，
// 那条信息本身就够清楚。
func portBusy(p int) bool {
	c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(p)), time.Second)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

func summarize(failed, warned int) error {
	fmt.Println()
	if failed > 0 {
		return fmt.Errorf("%d 项检查未通过，见上面的说明", failed)
	}
	if warned > 0 {
		fmt.Printf("没有阻塞项（%d 项提醒，见上面标 ⚠ 的）。\n", warned)
	} else {
		fmt.Println("全部通过。")
	}
	fmt.Println("第一次部署建议先用 --acme-staging 调通，")
	fmt.Println("正式环境的 Let's Encrypt 限流窗口是一周，撞上了只能等。")
	return nil
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
