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

	"github.com/sunhaijun/webterm/internal/agent"
)

// 以下几个是测试的注入点：不联网、不真的找 CA。
var (
	doctorOut      io.Writer = os.Stdout
	lookupPublicIP           = publicIP
	issueCheck               = agent.IssueCheck
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
	acmeCheck := fs.Bool("acme", false, "再把证书签好存进 certs/，服务启动直接用（要临时占用两个端口，服务在跑时先停掉）")
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
			fmt.Fprintf(doctorOut, "  ⚠ %s\n      %s\n", name, indent(w.msg))
		case err != nil:
			failed++
			fmt.Fprintf(doctorOut, "  ✗ %s\n      %s\n", name, indent(err.Error()))
		case detail != "":
			fmt.Fprintf(doctorOut, "  ✓ %s（%s）\n", name, detail)
		default:
			fmt.Fprintf(doctorOut, "  ✓ %s\n", name)
		}
	}

	fmt.Fprintln(doctorOut, "webterm doctor")
	fmt.Fprintln(doctorOut)

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
		fmt.Fprintln(doctorOut, "\n（--dev 模式：跳过地址与端口检查）")
		return summarize(failed, warned, false)
	}
	if c.domain == "" {
		fmt.Fprintln(doctorOut, "  ✗ 地址\n      没有指定 --domain（域名或公网 IPv4）。ACME 需要它，Origin 校验也需要它。")
		failed++
		return summarize(failed, warned, false)
	}
	if err := agent.CheckAddress(c.domain); err != nil {
		fmt.Fprintf(doctorOut, "  ✗ 地址\n      %s\n", indent(err.Error()))
		failed++
		return summarize(failed, warned, false)
	}

	if agent.IsIPAddress(c.domain) {
		// IP 模式（ADR-0044）：没有 DNS 可查，查的是「这个 IP 真是本机的公网 IP」
		check("公网 IP", func() (string, error) { return checkPublicIP(c.domain, lookupPublicIP) })
	} else {
		checkDNS(check, c.domain)
	}

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

	if *acmeCheck {
		if failed > 0 {
			fmt.Fprintln(doctorOut, "  - 证书实签：跳过，先修好上面标 ✗ 的项"+
				"（端口被 webterm 自己占着的话，先 sudo systemctl stop webterm）")
		} else {
			fmt.Fprintln(doctorOut, "  … 证书：向 Let's Encrypt 申请（最多等 2 分钟）")
			check("证书", func() (string, error) {
				return runIssueCheck(c.domain, agent.CertDirDefault(c.dataDir), *httpPort, *httpsPort)
			})
		}
	}

	return summarize(failed, warned, *acmeCheck)
}

// runIssueCheck 把证书签好存进服务用的 certs/（ADR-0045 §4）。签下来的就是正式证书，
// 服务启动直接用，不签第二次；已有有效证书时直接用它并如实说「没有找 CA」。
func runIssueCheck(domain, certDir string, httpPort, httpsPort int) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	leaf, issued, err := issueCheck(ctx, agent.ServeConfig{
		Domain: domain, Bind: "0.0.0.0",
		HTTPPort: httpPort, HTTPSPort: httpsPort, CertDir: certDir,
	})
	if err != nil {
		return "", err
	}
	exp := leaf.NotAfter.Local().Format("2006-01-02 15:04")
	if !issued {
		return "已有证书，到期 " + exp + "；没有找 CA，所以这一项没验证安全组", nil
	}
	return "签下来了（CA 从公网连进来了），到期 " + exp + "，服务启动直接用它", nil
}

// checkPublicIP：IP 模式下 --domain 必须就是本机的公网 IP。
func checkPublicIP(ip string, lookup func() (string, error)) (string, error) {
	public, err := lookup()
	if err != nil {
		return "", fmt.Errorf("查不到本机公网 IP（%v），请手工核对：\n  curl -s ifconfig.me   应当等于 %s", err, ip)
	}
	if public != ip {
		return "", fmt.Errorf("本机公网 IP 是 %s，不等于 --domain %s。\n"+
			"HTTP-01 挑战会打到 %s 上，不是这台机器的话证书签不下来。\n"+
			"  IP 变了：用新 IP 重装（./webterm install --domain %s），设备要重新配对\n"+
			"  在 NAT 后面：见 docs/80-ops/install.md 的「家宽 / NAT 后面」", public, ip, ip, public)
	}
	return "本机公网 IP " + public, nil
}

// checkDNS 是域名模式的两项：解析得出来、并且指向本机。
func checkDNS(check func(string, func() (string, error)), domain string) {
	var resolved []string
	check("DNS 解析", func() (string, error) {
		ips, err := net.LookupHost(domain)
		if err != nil {
			return "", fmt.Errorf("解析 %s 失败：%v\n"+
				"确认已经加了 A/AAAA 记录，并等 TTL 过期", domain, err)
		}
		resolved = ips
		return strings.Join(ips, ", "), nil
	})

	check("DNS 指向本机", func() (string, error) {
		if len(resolved) == 0 {
			return "", fmt.Errorf("上一步没解析出结果，跳过")
		}
		public, err := lookupPublicIP()
		if err != nil {
			return "", fmt.Errorf("查不到本机公网 IP（%v），请手工核对：\n"+
				"  dig +short %s\n  curl -s ifconfig.me", err, domain)
		}
		for _, ip := range resolved {
			if ip == public {
				return "本机公网 IP " + public, nil
			}
		}
		return "", fmt.Errorf("%s 解析到 %s，但本机公网 IP 是 %s。\n"+
			"HTTP-01 挑战会打到解析出的那台机器上，不改的话证书签不下来。\n"+
			"确认改的是 A/AAAA 记录，而不是 CNAME 到别处",
			domain, strings.Join(resolved, ", "), public)
	})
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

func summarize(failed, warned int, acmeChecked bool) error {
	fmt.Fprintln(doctorOut)
	if failed > 0 {
		return fmt.Errorf("%d 项检查未通过，见上面的说明", failed)
	}
	if warned > 0 {
		fmt.Fprintf(doctorOut, "没有阻塞项（%d 项提醒，见上面标 ⚠ 的）。\n", warned)
	} else {
		fmt.Fprintln(doctorOut, "全部通过。")
	}
	if !acmeChecked {
		// 云安全组有没有放行，在机器内部只有真的让 CA 连一次才知道
		fmt.Fprintln(doctorOut, "云安全组有没有放行 80/443 在机器内部查不出来：加 --acme 真的签一次证书")
		fmt.Fprintln(doctorOut, "（要临时占用两个端口，webterm 在跑的话先停掉；签下来的证书留给服务用）。")
	}
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
