package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/sunhaijun/webterm/internal/agent"
	"github.com/sunhaijun/webterm/internal/session"
	"github.com/sunhaijun/webterm/internal/store"
)

func runServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	var c commonFlags
	c.register(fs)

	acmeStaging := fs.Bool("acme-staging", false, "用 Let's Encrypt staging 环境（调试部署用）")
	httpPort := fs.Int("http-port", 80, "ACME 挑战 + HTTPS 跳转")
	httpsPort := fs.Int("https-port", 443, "HTTPS 端口")
	bind := fs.String("bind", "0.0.0.0", "监听地址。设为 127.0.0.1 配合隧道/反代")
	noTLS := fs.Bool("no-tls", false, "关闭 TLS（仅允许 --bind 为回环或私有地址）")
	trustProxy := fs.Bool("trust-proxy", false, "信任 X-Forwarded-For（仅在反代后启用，否则限速可被绕过）")
	maxSessions := fs.Int("max-sessions", 20, "会话数上限")
	maxConns := fs.Int("max-conns", 16, "并发 WebSocket 连接上限")
	ringBytes := fs.Int("ring-bytes", 1<<20, "每会话输出缓冲（影响能容忍的断线时长）")
	maxHistory := fs.Int("max-history", 50000, "命令历史条数上限")
	noHistory := fs.Bool("no-history", false, "完全关闭命令历史记录")
	noShellIntegration := fs.Bool("no-shell-integration", false, "不注入 shell 集成（排障用）")
	noLoginShell := fs.Bool("no-login-shell", false, "用非登录交互 shell（只读 ~/.bashrc）")
	shell := fs.String("shell", "bash", "shell（v0.1 只支持 bash）")
	logLevel := fs.String("log-level", "info", "debug / info / warn / error")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *httpPort == 8080 && c.dev {
		// --dev 默认 8080
	} else if c.dev && !isFlagSet(fs, "http-port") {
		*httpPort = 8080
	}

	log := newLogger(*logLevel)
	slog.SetDefault(log)

	if !c.dev && !*noTLS && c.domain == "" {
		return fmt.Errorf("生产模式必须指定 --domain（ACME 与 Origin 校验都要用它），本地开发用 --dev")
	}

	st, err := store.Open(c.dataDir)
	if err != nil {
		return err
	}
	defer st.Close()

	// 清理上次崩溃残留的 rcfile
	runDir := filepath.Join(c.dataDir, "run")
	if err := os.MkdirAll(runDir, 0o700); err != nil {
		return fmt.Errorf("创建运行时目录失败: %w", err)
	}
	cleanupStaleRCFiles(runDir, log)
	_ = noShellIntegration
	_ = noLoginShell

	sessions := session.NewManager(session.Config{
		MaxSessions: *maxSessions,
		RingBytes:   *ringBytes,
		Shell:       *shell,
		History:     !*noHistory,
		// RCFileFor 由 m5 的 internal/shellinit 提供；现在为 nil = 没有 shell 集成
	}, st)
	defer sessions.Shutdown()

	a := agent.New(agent.Config{
		Domain:     c.domain,
		Dev:        c.dev,
		TrustProxy: *trustProxy,
		MaxConns:   *maxConns,
		MaxHistory: *maxHistory,
		Version:    version,
		Logger:     log,
	}, st, sessions)
	a.LoadSettings()

	stopPurge := make(chan struct{})
	go a.PurgeLoop(stopPurge)
	defer close(stopPurge)

	servers, errCh, err := a.Listen(agent.ServeConfig{
		Domain:      c.domain,
		Dev:         c.dev,
		NoTLS:       *noTLS,
		ACMEStaging: *acmeStaging,
		Bind:        *bind,
		HTTPPort:    *httpPort,
		HTTPSPort:   *httpsPort,
		CertDir:     agent.CertDirDefault(c.dataDir),
	}, a.Handler())
	if err != nil {
		return err
	}

	// 首次启动若无已授权设备，打配对码 + 二维码（AC-1.3）
	if has, err := st.HasAnyDevice(); err == nil && !has {
		code, err := a.Auth().NewPairingCode(time.Now())
		if err != nil {
			return err
		}
		fmt.Println()
		fmt.Println("尚无已授权设备。配对码 5 分钟内有效：")
		printPairing(c.baseURL(*httpPort), code)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	select {
	case err := <-errCh:
		return err
	case s := <-sig:
		log.Info("收到信号，正在关闭", "signal", s.String())
	}

	// 优雅关闭：先告诉用户【为什么】会话会没，再关（ADR-0003 的缓解措施）
	a.Hub().NoticeAll("warn", "agent 即将重启，所有会话将结束")
	time.Sleep(2 * time.Second) // 让消息送出去
	a.Hub().CloseAll()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	servers.Shutdown(ctx)
	sessions.Shutdown()
	return nil
}

func isFlagSet(fs *flag.FlagSet, name string) bool {
	found := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == name {
			found = true
		}
	})
	return found
}

func newLogger(level string) *slog.Logger {
	var lv slog.Level
	switch level {
	case "debug":
		lv = slog.LevelDebug
	case "warn":
		lv = slog.LevelWarn
	case "error":
		lv = slog.LevelError
	default:
		lv = slog.LevelInfo
	}
	// 日志【不得】包含配对码、Cookie token、命令原文、终端输出（AC-8.5）。
	// debug 也不是安全旁路 —— 脱敏在调用点做，这里只管级别。
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: lv}))
}

// cleanupStaleRCFiles 删掉上次崩溃残留的临时 rcfile。
func cleanupStaleRCFiles(runDir string, log *slog.Logger) {
	entries, err := os.ReadDir(runDir)
	if err != nil {
		return
	}
	n := 0
	for _, e := range entries {
		if !e.IsDir() && len(e.Name()) > 3 && e.Name()[:3] == "rc-" {
			if os.Remove(filepath.Join(runDir, e.Name())) == nil {
				n++
			}
		}
	}
	if n > 0 {
		log.Debug("清理了上次残留的 rcfile", "count", n)
	}
}
