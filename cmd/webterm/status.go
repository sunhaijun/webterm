package main

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/sunhaijun/webterm/internal/agent"
	"github.com/sunhaijun/webterm/internal/store"
)

// 裸跑 webterm 给一张状态总览。
//
// 日常真正要问的只有一句"现在正常吗"。以前得去 journalctl 里 grep 证书状态、
// 再跑 devices 看有没有授权设备 —— 三个地方拼一个答案。这里一次说完。
//
// 【刻意不做交互式菜单】：配对、吊销都是低频操作，有明确命令就够，
// 菜单只是多一层；而且 TUI 要引依赖，和单二进制的取向相冲。

// status 是总览要用到的全部事实。取数据与渲染分开，渲染就能当纯函数测。
type status struct {
	running    bool
	runningVia string   // "systemd" 或 "" —— 只是为了让"怎么知道的"透明
	unit       unitKind // 装的是哪种 systemd 单元：决定提示里的命令，以及要不要提示迁移
	url        string
	certOK     bool
	certExpiry time.Time
	devices    int
	configPath string
}

func runStatus() error {
	fmt.Print(renderStatus(collectStatus(), version, time.Now(), colorEnabled(os.Stdout)))
	return nil
}

// colorEnabled 决定要不要上色。
//
// 只在【真的接着终端】时上色 —— `webterm > status.log` 或者管道给别的程序
// 时，文件里不该躺着 \033[33m。另外认 NO_COLOR（no-color.org 的约定：
// 只要设了就不上色，值是什么无所谓）和 TERM=dumb。
func colorEnabled(f *os.File) bool {
	if _, ok := os.LookupEnv("NO_COLOR"); ok {
		return false
	}
	if os.Getenv("TERM") == "dumb" {
		return false
	}
	fi, err := f.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}

// collectStatus 尽力而为：任何一项取不到就留空，不让整张表失败。
func collectStatus() status {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var c commonFlags
	c.register(fs)
	httpsPort := fs.Int("https-port", 443, "")
	httpPort := fs.Int("http-port", 80, "")
	cfgPath := registerConfigFlag(fs, nil)
	_ = loadConfigInto(fs, cfgPath)
	_ = fs.Parse(nil)

	st := status{}
	if _, err := os.Stat(cfgPath); err == nil {
		st.configPath = cfgPath
	}
	if c.domain != "" {
		st.url = agent.ExternalURL(c.domain, *httpsPort)
	}

	st.unit = detectUnit()
	st.running, st.runningVia = probeRunning(st.unit, c.domain, *httpPort, *httpsPort)

	if c.domain != "" {
		if exp, ok := certExpiryFromCache(agent.CertDirDefault(c.dataDir), c.domain); ok {
			st.certOK, st.certExpiry = true, exp
		}
	}
	if db, err := store.Open(c.dataDir); err == nil {
		if list, err := db.ListDevices(); err == nil {
			st.devices = len(list)
		}
		db.Close()
	}
	return st
}

// probeRunning 判断服务在不在跑。
//
// 先问 systemd（装出来的部署都有单元：ADR-0034 起是系统服务，之前是用户服务），
// 那是最可靠的答案。
//
// 单元没在跑、或者根本没有单元时退化成探 /healthz（手工 webterm serve 也算在跑）。【不能只看端口有没有人听】——
// 443 上很可能是别的服务（这个坑真踩过：探到的是 Xray），
// 而 /healthz 返回 "ok" 是 webterm 特有的。
func probeRunning(unit unitKind, domain string, httpPort, httpsPort int) (bool, string) {
	if unit.active() {
		return true, "systemd"
	}
	// 生产：HTTPS 端口跑完整路由（:80 只有挑战和跳转）。
	//
	// 【必须带上 SNI】—— autocert 的 HostPolicy 只认 --domain 那个名字，
	// 拿 IP 直连不带 SNI 的话服务端【根本不给证书】，握手就断了。
	// 那是服务端的拒绝，客户端 InsecureSkipVerify 救不了，
	// 探针会把活得好好的服务判成"未运行"。
	//
	// 校验仍然跳过：staging 证书、自签、链不全都不该影响"在不在跑"这个判断。
	if domain != "" && healthzOK("https://127.0.0.1:"+strconv.Itoa(httpsPort)+"/healthz", domain) {
		return true, ""
	}
	// --dev / --no-tls：明文，在 http 端口上
	if healthzOK("http://127.0.0.1:"+strconv.Itoa(httpPort)+"/healthz", "") {
		return true, ""
	}
	return false, ""
}

// healthzOK 探一次 /healthz。sni 非空时按它发 SNI 并跳过证书校验。
func healthzOK(url, sni string) bool {
	c := &http.Client{
		Timeout: time.Second,
		// 【不跟随重定向】。:80 只有 ACME 挑战和跳转，跟下去就等于
		// 让【别的地方】替本机回答"我在不在跑" —— 那正是这个探针
		// 要防的误报（最早的版本探端口，把 443 上的 Xray 认成了 webterm）。
		// 而且跳转目标是公网域名，跟下去会绕出这台机器再回来：
		// --bind 127.0.0.1、NAT 不自反、DNS 不通时都会塌。
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	if sni != "" {
		c.Transport = &http.Transport{TLSClientConfig: &tls.Config{
			ServerName:         sni,
			InsecureSkipVerify: true, //nolint:gosec // 只探活，不传数据
		}}
	}
	resp, err := c.Get(url)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64))
	return err == nil && strings.TrimSpace(string(body)) == "ok"
}

// certExpiryFromCache 从 autocert 的缓存文件里读到期时间。
//
// 缓存是 PEM：先私钥、再证书链。只取第一张 CERTIFICATE（叶子）。
// 【不做校验】—— 这里只为了显示，真正的有效性判断在 autocert 里。
func certExpiryFromCache(certDir, domain string) (time.Time, bool) {
	raw, err := os.ReadFile(filepath.Join(certDir, domain))
	if err != nil {
		return time.Time{}, false
	}
	for rest := raw; len(rest) > 0; {
		var blk *pem.Block
		blk, rest = pem.Decode(rest)
		if blk == nil {
			break
		}
		if blk.Type != "CERTIFICATE" {
			continue
		}
		leaf, err := x509.ParseCertificate(blk.Bytes)
		if err != nil {
			return time.Time{}, false
		}
		return leaf.NotAfter, true
	}
	return time.Time{}, false
}

// daysLeft 按自然日算剩余天数。已过期返回负数。
func daysLeft(expiry, now time.Time) int {
	d := expiry.Sub(now)
	if d < 0 {
		return int(d/(24*time.Hour)) - 1
	}
	return int(d / (24 * time.Hour))
}

func renderStatus(st status, ver string, now time.Time, color bool) string {
	// 颜色只是强调 —— 关掉之后"已过期""只剩 N 天"这些字仍然把话说全了。
	paint := func(code, s string) string {
		if !color {
			return s
		}
		return "\033[" + code + "m" + s + "\033[0m"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "webterm %s\n\n", ver)

	row := func(k, v string) { fmt.Fprintf(&b, "  %-6s  %s\n", k, v) }

	switch {
	case st.running && st.runningVia != "" && st.unit == unitUser:
		row("服务", "运行中（systemd 用户服务 —— 内存吃紧时会比登录会话先被杀）")
	case st.running && st.runningVia != "":
		row("服务", "运行中（systemd）")
	case st.running:
		row("服务", "运行中")
	default:
		row("服务", "未运行")
	}

	if st.url != "" {
		row("地址", st.url)
	} else {
		row("地址", "还没配域名 —— 用 scripts/install.sh --domain <域名> 装，或 webterm serve --dev 本地试")
	}

	switch {
	case !st.certOK && st.url != "":
		row("证书", "还没有证书（服务启动时会自动申请）")
	case st.certOK:
		d := daysLeft(st.certExpiry, now)
		date := st.certExpiry.Local().Format("2006-01-02")
		switch {
		case d < 0:
			row("证书", fmt.Sprintf("%s（%s）—— 重启服务会重新申请", paint("31", "已过期"), date))
		case d <= 10:
			// 到期是唯一会静默变成事故的东西，剩得少就说明白
			row("证书", fmt.Sprintf("%s（%s）—— 自动续期需要 80 或 443 从公网可达",
				paint("33", fmt.Sprintf("只剩 %d 天", d)), date))
		default:
			row("证书", fmt.Sprintf("有效，到 %s（还有 %d 天，自动续期）", date, d))
		}
	}

	if st.devices == 0 {
		row("设备", "还没有授权设备")
	} else {
		row("设备", fmt.Sprintf("%d 台已授权", st.devices))
	}
	if st.configPath != "" {
		row("配置", st.configPath)
	}

	b.WriteString("\n")
	if !st.running {
		if st.unit == unitNone {
			b.WriteString("  webterm serve      启动服务\n")
		} else {
			fmt.Fprintf(&b, "  %-18s 启动服务\n", st.unit.ctl("start"))
		}
	}
	if st.unit == unitUser {
		// ADR-0034：迁移会关闭所有会话一次，所以只提示、不替用户做
		b.WriteString("  webterm update --force-restart   迁移成系统服务（会关闭所有会话一次，从 SSH 跑）\n")
	}
	if st.devices == 0 {
		b.WriteString("  webterm pair       拿配对码 + 二维码，手机扫一下完成授权  ← 下一步\n")
	} else {
		b.WriteString("  webterm pair       拿配对码 + 二维码\n")
	}
	b.WriteString("  webterm devices    看已授权的设备 / 吊销\n")
	b.WriteString("  webterm doctor     检查部署前置条件\n")
	b.WriteString("\n\"webterm <命令> --help\" 看具体选项。\n")
	return b.String()
}
