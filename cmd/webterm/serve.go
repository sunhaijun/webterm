package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/sunhaijun/webterm/internal/agent"
	"github.com/sunhaijun/webterm/internal/handoff"
	"github.com/sunhaijun/webterm/internal/session"
	"github.com/sunhaijun/webterm/internal/store"
)

// serveOpts 是 serve 独有的参数。
//
// 抽成结构体 + 一处注册，是为了让 serveFlagSet() 能被配置文件的白名单测试
// 复用（TestConfigKeysAllExistOnServe / TestServeFlagsAreConfigurable），
// 而不需要维护第二份 flag 清单 —— 两份必然漂移。
type serveOpts struct {
	acmeStaging       bool
	httpPort          int
	httpsPort         int
	bind              string
	noTLS             bool
	trustProxy        bool
	maxSessions       int
	maxConns          int
	ringBytes         int
	noLoginShell      bool
	sessionEnv        envList
	noAltScreenCompat bool
	shell             string
	logLevel          string
	handoffFD         int
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
	fs.IntVar(&o.ringBytes, "ring-bytes", session.DefaultRingBytes, "每会话输出缓冲：断线或切走期间的输出在它之内就增量续传，超出就改发快照")
	fs.BoolVar(&o.noLoginShell, "no-login-shell", false, "以 -i 启动非登录交互 shell（bash 只读 ~/.bashrc）。默认 -l -i")
	fs.Var(&o.sessionEnv, "session-env", "注入会话 PTY 的环境变量，KEY=VAL，可重复")
	fs.BoolVar(&o.noAltScreenCompat, "no-altscreen-compat", false, "关掉「把全屏 AI CLI 拉回主屏」的内置清单（ADR-0024）")
	fs.StringVar(&o.shell, "shell", "bash", "会话里跑的 shell，任何支持 -l / -i 的 shell 都行")
	fs.StringVar(&o.logLevel, "log-level", "info", "debug / info / warn / error")
	fs.IntVar(&o.handoffFD, handoff.FlagName, -1, "内部：热升级交接的快照 fd（由旧进程在 exec 时传入，ADR-0016）")
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

	// 热升级（ADR-0016）：带 --handoff-fd 起来的是接手的新进程，先把快照读回来
	var snap *handoff.Snapshot
	if o.handoffFD >= 0 {
		read, err := handoff.Read(o.handoffFD)
		if err != nil {
			return fmt.Errorf("热升级交接失败，无法恢复会话: %w", err)
		}
		snap = read
	}

	st, err := store.Open(c.dataDir)
	if err != nil {
		return err
	}
	defer st.Close()

	runDir := filepath.Join(c.dataDir, "run")
	if err := os.MkdirAll(runDir, 0o700); err != nil {
		return fmt.Errorf("创建运行时目录失败: %w", err)
	}
	// 老版本注入 shell 集成时留在这里的临时 rcfile（ADR-0026 §6 删除了 shell 集成）。
	// 交接过来也照清：bash 只在启动时读 rcfile，正在运行的会话早就不需要它了
	cleanupLegacyRCFiles(runDir, log)

	sessions := session.NewManager(session.Config{
		MaxSessions:       o.maxSessions,
		RingBytes:         o.ringBytes,
		Shell:             o.shell,
		NoLoginShell:      o.noLoginShell,
		SessionEnv:        o.sessionEnv,
		NoAltScreenCompat: o.noAltScreenCompat,
	})
	defer sessions.Shutdown()
	if snap != nil {
		if err := sessions.Restore(snap); err != nil {
			return fmt.Errorf("热升级交接失败，无法恢复会话: %w", err)
		}
		log.Info("热升级完成，会话已接手", "generation", sessions.Generation(),
			"sessions", len(snap.Sessions), "from", snap.FromVersion, "to", version)
	}

	a := agent.New(agent.Config{
		Domain:     c.domain,
		HTTPSPort:  o.httpsPort,
		Dev:        c.dev,
		TrustProxy: o.trustProxy,
		MaxConns:   o.maxConns,
		Version:    version,
		Logger:     log,
	}, st, sessions)

	servers, errCh, err := a.Listen(agent.ServeConfig{
		Domain:      c.domain,
		Dev:         c.dev,
		NoTLS:       o.noTLS,
		ACMEStaging: o.acmeStaging,
		Bind:        o.bind,
		HTTPPort:    o.httpPort,
		HTTPSPort:   o.httpsPort,
		CertDir:     agent.CertDirFor(c.dataDir, o.acmeStaging), // staging 证书不进 certs/（ADR-0042 §3）
		Inherited:   inheritedListeners(snap),
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

	// 热升级控制面（ADR-0016）：探测 / 忙碌 / 触发 reexec。SIGUSR2 等价。
	reexecReq := make(chan struct{}, 1)
	var lastErr sync.Mutex
	lastHandoffErr := ""
	ctl, err := agent.ServeControl(filepath.Join(runDir, "agent.sock"), agent.ControlDeps{
		Status: func() agent.ControlStatus {
			lastErr.Lock()
			le := lastHandoffErr
			lastErr.Unlock()
			return agent.ControlStatus{
				Version: version, PID: os.Getpid(), Generation: sessions.Generation(),
				InstanceID: sessions.InstanceID(), Sessions: len(sessions.List()), Busy: sessions.Busy(),
				Handoff: true, LastError: le,
			}
		},
		Reexec: func() error {
			select {
			case reexecReq <- struct{}{}:
				return nil
			default:
				return errors.New("已有一次热升级在进行")
			}
		},
	}, log)
	if err != nil {
		return err
	}
	defer ctl.Close()

	// 首次启动若无已授权设备，打配对码 + 二维码（AC-1.3）
	if has, err := st.HasAnyDevice(); err == nil && !has {
		codes, err := a.Auth().NewPairingCodes(time.Now())
		if err != nil {
			return err
		}
		fmt.Println()
		fmt.Println("尚无已授权设备。配对码 5 分钟内有效：")
		printPairing(c.baseURL(o.httpPort, o.httpsPort), codes)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	usr2 := make(chan os.Signal, 1)
	signal.Notify(usr2, syscall.SIGUSR2)
	exe := currentExe()
	// exec 时的 argv：serve + 本次的全部参数（去掉上一轮的 --handoff-fd）。
	// 【serve 子命令要自己带上】：args 是 serve 之后的部分
	serveArgs := append([]string{"serve"}, handoff.StripFlag(args)...)
loop:
	for {
		select {
		case err := <-errCh:
			return err
		case s := <-sig:
			log.Info("收到信号，正在关闭", "signal", s.String())
			break loop
		case <-usr2:
		case <-reexecReq:
		}
		// 热升级：成功就不会回来（exec 了）；失败解冻、照常服务、把原因记下来
		if err := hotReexec(exe, serveArgs, a, sessions, servers, log); err != nil {
			lastErr.Lock()
			lastHandoffErr = err.Error()
			lastErr.Unlock()
			log.Error("热升级中止，服务照常", "err", err)
			a.Hub().NoticeAll("warn", "热升级中止："+err.Error()+"。会话照常，服务未重启")
		}
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

// cleanupLegacyRCFiles 删掉老版本（shell 集成还在时）留在运行时目录里的临时 rcfile。
func cleanupLegacyRCFiles(runDir string, log *slog.Logger) {
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
		log.Debug("清理了老版本残留的 rcfile", "count", n)
	}
}

// currentExe 是本进程的可执行文件路径。【启动时就取】：升级把磁盘上的文件换掉之后，
// /proc/self/exe 会变成 "…/webterm (deleted)"，那时再读就晚了 —— 而我们要 exec 的
// 正是同一路径下的新文件。
func currentExe() string {
	p, err := os.Executable()
	if err != nil {
		return ""
	}
	return strings.TrimSuffix(p, " (deleted)")
}

// inheritedListeners 把快照里的监听 fd 变成 Listen 需要的 name → fd。
func inheritedListeners(snap *handoff.Snapshot) map[string]int {
	if snap == nil || len(snap.Listeners) == 0 {
		return nil
	}
	out := make(map[string]int, len(snap.Listeners))
	for _, l := range snap.Listeners {
		out[l.Name] = l.FD
	}
	return out
}

// hotReexec 是热升级本身（ADR-0016）：预检 → 冻结 → 快照 → 关连接 → exec。
// 只在失败时返回；成功则本进程映像已被替换。
func hotReexec(exe string, serveArgs []string, a *agent.Agent, sessions *session.Manager, servers *agent.Servers, log *slog.Logger) error {
	if exe == "" {
		return errors.New("找不到自己的可执行文件路径")
	}
	if fi, err := os.Stat(exe); err != nil || fi.IsDir() || fi.Mode()&0o111 == 0 {
		return fmt.Errorf("%s 不是可执行文件（升级是不是还没把新二进制装到这个位置？）", exe)
	}
	// ① 预检：新二进制读得懂这一版 schema 吗。exec 之后没有回头路，所以先问
	probe := &handoff.Snapshot{Schema: handoff.Schema, InstanceID: sessions.InstanceID(), FromVersion: version}
	if err := handoff.Check(exe, probe, 15*time.Second); err != nil {
		return err
	}
	// ② 冻结：两个循环停在安全点
	if err := sessions.Freeze(3 * time.Second); err != nil {
		return err
	}
	// ③ 快照
	snap, err := sessions.Export(version)
	if err != nil {
		sessions.Thaw()
		return err
	}
	lns, lnFiles, err := servers.ExportListeners()
	if err != nil {
		snap.CloseFDs()
		sessions.Thaw()
		return err
	}
	snap.Listeners = lns
	memf, err := handoff.Write(snap)
	if err != nil {
		for _, f := range lnFiles {
			f.Close()
		}
		snap.CloseFDs()
		sessions.Thaw()
		return err
	}
	// ④ 告诉用户发生了什么，再关连接 —— 客户端按 out_seq 重连续传，前端无感
	a.Hub().NoticeAll("info", "正在热升级，会话保留，稍后自动重连")
	time.Sleep(300 * time.Millisecond)
	a.Hub().CloseAll()
	log.Info("热升级：exec 新二进制", "exe", exe, "sessions", len(snap.Sessions), "generation", snap.Generation)
	// ⑤ exec。控制 socket 与 SQLite 的 fd 带 CLOEXEC，随旧映像消失；新进程自己重开
	err = handoff.Exec(exe, serveArgs, int(memf.Fd()))
	// 只有失败才走到这里：全部撤回
	memf.Close()
	for _, f := range lnFiles {
		f.Close()
	}
	snap.CloseFDs()
	sessions.Thaw()
	return fmt.Errorf("exec %s: %w", exe, err)
}
