package main

import (
	"flag"
	"fmt"
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
	if err := applyConfig(fs, args); err != nil {
		return err
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	if !c.dev && c.domain == "" {
		return fmt.Errorf("需要 --domain 来拼出配对 URL（本地开发用 --dev）")
	}

	// webterm pair 是【独立进程】，和 serve 共享同一个 SQLite。
	// WAL 模式支持多进程访问，busy_timeout 已经设了 5 秒。
	st, err := store.Open(c.dataDir)
	if err != nil {
		return err
	}
	defer st.Close()

	code, err := auth.New(st, c.dev).NewPairingCode(time.Now())
	if err != nil {
		return err
	}
	fmt.Println("配对码已生成，5 分钟内有效：")
	printPairing(c.baseURL(*httpPort, *httpsPort), code)
	return nil
}

// printPairing 打印配对 URL 和终端二维码。
//
// 配对码走 URL **fragment**：它不会发送给服务器，所以不进访问日志、
// 不进 Referer、不被中间代理记录（AC-1.5 / 威胁模型 T2）。
func printPairing(baseURL, code string) {
	url := baseURL + "/pair#" + code
	fmt.Println()
	fmt.Println("  " + url)
	fmt.Println()
	// 手机上手打 43 个字符的 base64 是不可接受的；扫码路径也避开了剪贴板
	// 和聊天工具（否则配对码会永久留在聊天记录里）。
	if art, err := qrART(url); err == nil {
		fmt.Println(art)
	}
	fmt.Println("用手机扫码即可完成授权。")
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
