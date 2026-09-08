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
	"github.com/sunhaijun/webterm/internal/shellinit"
	"github.com/sunhaijun/webterm/internal/store"
)

// serveOpts 是 serve 独有的参数。
//
// 抽成结构体 + 一处注册，是为了让 serveFlagSet() 能被配置文件的白名单测试
// 复用（TestConfigKeysAllExistOnServe / TestServeFlagsAreConfigurable），
// 而不需要维护第二份 flag 清单 —— 两份必然漂移。
type serveOpts struct {
	acmeStaging        bool
	httpPort           int
	httpsPort          int
	bind               string
	noTLS              bool
	trustProxy         bool
	maxSessions        int
	maxConns           int
	ringBytes          int
	maxHistory         int
	noHistory          bool
	noShellIntegration bool
	noLoginShell       bool
	shell              string
	logLevel           string
}

func (o *serveOpts) register(fs *flag.FlagSet) {
	fs.BoolVar(&o.acmeStaging, "acme-staging", false, "用 Let's Encrypt staging 环境（调试部署用）")
	fs.IntVar(&o.httpPort, "http-port", 80, "ACME 挑战 + HTTPS 跳转")
	fs.IntVar(&o.httpsPort, "https-port", 443, "HTTPS 端口")
	fs.StringVar(&o.bind, "bind", "0.0.0.0", "监听地址。设为 127.0.0.1 配合隧道/反代")
	fs.BoolVar(&o.noTLS, "no-tls", false, "关闭 TLS（仅允许 --bind 为回环或私有地址）")
	fs.BoolVar(&o.trustProxy, "trust-proxy", false, "信任 X-Forwarded-For（仅在反代后启用，否则限速可被绕过）")
	fs.IntVar(&o.maxSessions, "max-sessions", 20, "会话数上限")
	fs.IntVar(&o.maxConns, "max-conns", 16, "并发 WebSocket 连接上限")
	fs.IntVar(&o.ringBytes, "ring-bytes", 1<<20, "每会话输出缓冲（影响能容忍的断线时长）")
	fs.IntVar(&o.maxHistory, "max-history", 50000, "命令历史条数上限")
	fs.BoolVar(&o.noHistory, "no-history", false, "完全关闭命令历史记录")
	fs.BoolVar(&o.noShellIntegration, "no-shell-integration", false, "不注入 shell 集成（排障用）")
	fs.BoolVar(&o.noLoginShell, "no-login-shell", false, "用非登录交互 shell（只读 ~/.bashrc）")
	fs.StringVar(&o.shell, "shell", "bash", "shell（v0.1 只支持 bash）")
	fs.StringVar(&o.logLevel, "log-level", "info", "debug / info / warn / error")
}

// serveFlagSet 是 serve 的完整 flag 集合。serve 的 flag 是所有子命令的超集，
// 所以配置文件的白名单只需对着它校验。
func serveFlagSet() *flag.FlagSet {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	var c commonFlags
	var o serveOpts
	c.register(fs)
	o.register(fs)
	return fs
}

func runServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	var c commonFlags
	var o serveOpts
	c.register(fs)
	o.register(fs)
	if err := applyConfig(fs, args); err != nil {
		return err
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	// --dev 默认监听 8080（AC-1.2），除非用户显式指定了端口
	if c.dev && !isFlagSet(fs, "http-port") {
		o.httpPort = 8080
	}

	log := newLogger(o.logLevel)
	slog.SetDefault(log)

	if !c.dev && !o.noTLS && c.domain == "" {
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

	sessCfg := session.Config{
		MaxSessions: o.maxSessions,
		RingBytes:   o.ringBytes,
		Shell:       o.shell,
		History:     !o.noHistory,
	}
	if !o.noShellIntegration {
		// 用临时 rcfile 注入，用户不需要改任何 dotfile（ADR-0010）
		sessCfg.RCFileFor = func(sid uint16) (string, error) {
			return shellinit.Render(sid, shellinit.Options{
				Login: !o.noLoginShell,
				Dir:   runDir,
			})
		}
	}
	sessions := session.NewManager(sessCfg, st)
	defer sessions.Shutdown()

	a := agent.New(agent.Config{
		Domain:     c.domain,
		Dev:        c.dev,
		TrustProxy: o.trustProxy,
		MaxConns:   o.maxConns,
		MaxHistory: o.maxHistory,
		Version:    version,
		Logger:     log,
	}, st, sessions)
	a.LoadSettings()

	servers, errCh, err := a.Listen(agent.ServeConfig{
		Domain:      c.domain,
		Dev:         c.dev,
		NoTLS:       o.noTLS,
		ACMEStaging: o.acmeStaging,
		Bind:        o.bind,
		HTTPPort:    o.httpPort,
		HTTPSPort:   o.httpsPort,
		CertDir:     agent.CertDirDefault(c.dataDir),
	}, a.Handler())
	if err != nil {
		return err
	}

	// 【必须在 Listen 成功之后】才起清理协程。它启动时会立刻查一次库，
	// 而 Listen 失败时函数马上返回、defer 里的 st.Close() 就执行了 ——
	// 那次查询会撞上"database is closed"，两行 WARN 把真正的错误信息盖住。
	// 反正要退出了，也没必要清理。
	stopPurge := make(chan struct{})
	go a.PurgeLoop(stopPurge)
	defer close(stopPurge)

	// 首次启动若无已授权设备，打配对码 + 二维码（AC-1.3）
	if has, err := st.HasAnyDevice(); err == nil && !has {
		code, err := a.Auth().NewPairingCode(time.Now())
		if err != nil {
			return err
		}
		fmt.Println()
		fmt.Println("尚无已授权设备。配对码 5 分钟内有效：")
		printPairing(c.baseURL(o.httpPort, o.httpsPort), code)
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
