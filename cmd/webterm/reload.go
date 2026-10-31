package main

import (
	"errors"
	"flag"
	"fmt"
	"path/filepath"
	"time"

	"github.com/sunhaijun/webterm/internal/agent"
)

// reload：让运行中的 agent 热升级 —— 原地 exec 磁盘上的新二进制，会话保留（ADR-0016）。
//
// 走本机控制 socket（<data-dir>/run/agent.sock），不走 HTTP：升级脚本跑在服务器
// 本机、以同一个用户身份，文件权限就是认证。
//
//	--probe      只探测运行中的 agent 支不支持热升级（支持则退出码 0），install.sh 用
//	--when-idle  等所有会话都停在提示符再动
//	--wait-idle  只等空闲，不触发（走老路 restart 之前用）
func runReload(args []string) error {
	fs := flag.NewFlagSet("reload", flag.ContinueOnError)
	var c commonFlags
	c.register(fs)
	probe := fs.Bool("probe", false, "只探测运行中的 agent 支不支持热升级")
	whenIdle := fs.Bool("when-idle", false, "等所有会话都停在提示符再动")
	waitIdle := fs.Bool("wait-idle", false, "只等空闲，不触发热升级")
	timeout := fs.Duration("timeout", 30*time.Minute, "--when-idle 最多等多久")
	if err := applyConfig(fs, args); err != nil {
		return err
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	sock := controlSocketPath(c.dataDir)

	st, err := controlStatus(sock)
	if err != nil {
		if *probe {
			return fmt.Errorf("运行中的 agent 不支持热升级或没在跑：%v", err)
		}
		return fmt.Errorf("运行中的 agent 不支持热升级或没在跑（%v）。\n"+
			"  升级前的老版本不认这条路，只能 %s（会关闭所有会话）", err, detectUnit().ctl("restart"))
	}
	if *probe {
		fmt.Printf("ok version=%s pid=%d generation=%d sessions=%d busy=%d\n", st.Version, st.PID, st.Generation, st.Sessions, st.Busy)
		return nil
	}

	if *whenIdle || *waitIdle {
		if err := waitUntilIdle(sock, *timeout); err != nil {
			return err
		}
	}
	if *waitIdle {
		return nil
	}

	fmt.Printf("webterm %s\n\n", version)
	fmt.Printf("  请求运行中的 agent 热升级：%s（pid %d，%d 个会话）\n", st.Version, st.PID, st.Sessions)
	if _, err := agent.ControlCall(sock, agent.ControlRequest{Op: "reexec"}, 5*time.Second); err != nil {
		return fmt.Errorf("agent 拒绝了热升级：%w", err)
	}
	return waitTakeover(sock, st, 30*time.Second)
}

func controlSocketPath(dataDir string) string { return filepath.Join(dataDir, "run", "agent.sock") }

func controlStatus(sock string) (*agent.ControlStatus, error) {
	resp, err := agent.ControlCall(sock, agent.ControlRequest{Op: "status"}, 3*time.Second)
	if err != nil {
		return nil, err
	}
	if resp.Status == nil || !resp.Status.Handoff {
		return nil, errors.New("agent 应答了但不支持交接")
	}
	return resp.Status, nil
}

// waitUntilIdle 等到没有会话在跑前台命令：每个运行中的会话，PTY 的前台进程组
// 都是 shell 自己。读不到前台进程组的会话按空闲算。
func waitUntilIdle(sock string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	announced := false
	for {
		st, err := controlStatus(sock)
		if err != nil {
			return err
		}
		if st.Busy == 0 {
			if announced {
				fmt.Println("  所有会话已停在提示符")
			}
			return nil
		}
		if !announced {
			fmt.Printf("  等待 %d 个会话结束前台命令（--when-idle，最多 %s）…\n", st.Busy, timeout)
			announced = true
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("等了 %s 仍有 %d 个会话在跑命令；去掉 --when-idle 直接升级，或稍后再试", timeout, st.Busy)
		}
		time.Sleep(2 * time.Second)
	}
}

// waitTakeover 等新进程接手：generation +1。旧进程若在预检时失败，它会把原因写进
// status.last_error，这里直接报出来，不用等到超时。
func waitTakeover(sock string, before *agent.ControlStatus, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		time.Sleep(200 * time.Millisecond)
		st, err := controlStatus(sock)
		if err != nil {
			continue // exec 前后 socket 会消失一瞬间
		}
		if st.Generation > before.Generation {
			fmt.Printf("\n  热升级完成：webterm %s（pid %d 不变，保留 %d 个会话，第 %d 代）\n", st.Version, st.PID, st.Sessions, st.Generation)
			if st.Version != version {
				fmt.Printf("  注意：运行的版本 %s 与本命令 %s 不同\n", st.Version, version)
			}
			return nil
		}
		if st.LastError != "" && st.Generation == before.Generation {
			return fmt.Errorf("agent 中止了热升级：%s\n  会话照常，服务未重启。修好后重试，或接受丢会话：%s", st.LastError, detectUnit().ctl("restart"))
		}
	}
	st, err := controlStatus(sock)
	u := detectUnit()
	if err == nil && st.Generation == before.Generation {
		return fmt.Errorf("agent 没有完成热升级（看 %s -n 50）。会话照常，服务未重启", u.journal())
	}
	return fmt.Errorf("热升级后 30 秒内没等到新进程应答。看 %s 与 %s -n 50", u.ctl("status"), u.journal())
}
