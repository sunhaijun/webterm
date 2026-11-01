package main

import (
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	qrcode "github.com/skip2/go-qrcode"
	"github.com/sunhaijun/webterm/internal/auth"
	"github.com/sunhaijun/webterm/internal/store"
)

func runPair(args []string) error {
	fs := flag.NewFlagSet("pair", flag.ExitOnError)
	var c commonFlags
	c.register(fs)
	httpPort := fs.Int("http-port", 8080, "--dev 下的端口（用于拼出配对 URL）")
	// pair 是独立进程，不知道 serve 用了哪个端口 —— 换了就得自己带上同一个值，
	// 否则拼出来的 URL 会漏掉端口，扫码打不开。
	httpsPort := fs.Int("https-port", 443, "HTTPS 端口（默认从配置文件读）")
	wait := fs.Bool("wait", false, "先等本机 HTTPS 用受信任的证书能打开再打印（最多 90 秒；安装脚本用）")
	if err := applyConfig(fs, args); err != nil {
		return err
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	if !c.dev && c.domain == "" {
		return fmt.Errorf("需要 --domain 来拼出配对 URL（本地开发用 --dev）")
	}

	// 先等证书，再生成配对码：码的 5 分钟从真正能用的那一刻开始算（ADR-0045 §6）
	if *wait && !c.dev {
		waitCertReady(os.Stdout, 90*time.Second, time.Second, func() error {
			return probeTrustedHTTPS(c.domain, *httpsPort)
		})
	}

	// webterm pair 是【独立进程】，和 serve 共享同一个 SQLite。
	// WAL 模式支持多进程访问，busy_timeout 已经设了 5 秒。
	st, err := store.Open(c.dataDir)
	if err != nil {
		return err
	}
	defer st.Close()

	codes, err := auth.New(st, c.dev, false).NewPairingCodes(time.Now())
	if err != nil {
		return err
	}
	fmt.Println("配对码已生成，5 分钟内有效：")
	printPairing(c.baseURL(*httpPort, *httpsPort), codes)
	return nil
}

// printPairing 打印配对 URL、终端二维码，以及可手输的 16 位数字码（ADR-0017）。
//
// 配对码走 URL **fragment**：它不会发送给服务器，所以不进访问日志、
// 不进 Referer、不被中间代理记录（AC-1.5 / 威胁模型 T2）。
func printPairing(baseURL string, codes auth.Codes) {
	url := baseURL + "/pair#" + codes.URL
	fmt.Println()
	fmt.Println("  " + url)
	fmt.Println()
	// 手机上手打 43 个字符的 base64 是不可接受的；扫码路径也避开了剪贴板
	// 和聊天工具（否则配对码会永久留在聊天记录里）。
	if art, err := qrART(url); err == nil {
		fmt.Println(art)
	}
	fmt.Println("用手机扫码即可完成授权。")
	// 扫不了码（终端在另一块屏幕上）的第二把钥匙：16 位数字，4-4-4-4 分组便于看和念。
	fmt.Println()
	fmt.Printf("扫不了码？在手机浏览器打开  %s/pair  输入配对码：\n\n      %s\n\n", baseURL, auth.FormatDigits(codes.Digits))
}

// qrART 把 URL 渲染成半块字符的二维码。
func qrART(url string) (string, error) {
	q, err := qrcode.New(url, qrcode.Medium)
	if err != nil {
		return "", err
	}
	q.DisableBorder = false
	return q.ToSmallString(false), nil
}

// waitCertReady 每隔 interval 探一次，直到成功或超时。
//
// 不等的话，首次安装刚启动服务、正式证书还在签，扫码打开看到的是证书错误 ——
// 用户会以为装坏了。超时也照样往下走：配对码 5 分钟有效，证书随后签下来还来得及。
func waitCertReady(w io.Writer, timeout, interval time.Duration, probe func() error) bool {
	deadline := time.Now().Add(timeout)
	announced := false
	for {
		err := probe()
		if err == nil {
			return true
		}
		if time.Now().After(deadline) {
			fmt.Fprintf(w, "\n  ⚠ %d 秒内本机 HTTPS 还没拿到受信任的证书（%v）。\n"+
				"    先把配对码打出来；扫码打不开的话看：journalctl -u webterm -n 30\n\n",
				int(timeout/time.Second), err)
			return false
		}
		if !announced {
			fmt.Fprintln(w, "等正式证书签下来……")
			announced = true
		}
		time.Sleep(interval)
	}
}

// probeTrustedHTTPS 连本机的 HTTPS 端口，按 --domain 校验证书（系统信任库），取 /healthz。
//
// 连 127.0.0.1 而不是公网地址：不少云的 NAT 不自反，从机器内部连自己的公网 IP 是不通的。
// ServerName 是 IP 时 Go 不发 SNI、按 IP SAN 校验 —— 和浏览器连 IP 一样。
func probeTrustedHTTPS(domain string, port int) error {
	c := &http.Client{
		Timeout: 3 * time.Second,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{
			ServerName: domain,
			MinVersion: tls.VersionTLS12,
		}},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := c.Get("https://127.0.0.1:" + strconv.Itoa(port) + "/healthz")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64))
	if resp.StatusCode != http.StatusOK || strings.TrimSpace(string(body)) != "ok" {
		return errors.New("/healthz 没有返回 ok")
	}
	return nil
}
