package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// update 子命令：一条命令升级到最新版。
//
// 【刻意做成薄壳】—— 它取最新的 install.sh，用【上次装成功时那套参数】
// 重跑一遍，而不是在 Go 里再实现一遍下载/校验/setcap/重启。
//
// 理由是升级路径上的知识几乎全在 install.sh 里，而且都是踩出来的：
// 私有仓库要走凭据回退、产物要对 SHA256、替换二进制会【丢掉 file
// capability】所以必须重做 setcap 并验证、systemd 单元要跟着端口走。
// 在这边照抄一份，两份必然漂移 —— 而漂移正是这些 bug 的来源。
//
// 语义也因此好解释：把当初那次成功的安装，用新产物再做一遍。

// installStateName 是 install.sh 记下安装参数的文件。
//
// 一行一个参数，和命令行写法逐字对应。【不做 key=value】：那样 update
// 就得知道怎么把键翻回 flag，又是一处会漂的映射。原样replay 不需要理解。
const installStateName = "install-state"

func installStatePath() string {
	dir := defaultConfigPath()
	if dir == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(dir), installStateName)
}

func runUpdate(args []string) error {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	dryRun := fs.Bool("dry-run", false, "只打印将要执行的命令，不真的升级")
	statePath := fs.String("state", installStatePath(), "安装参数文件")
	// --script 用本地的 install.sh，不去下载。离线部署、自建源、
	// 以及从源码树里验证改动时用得上。
	local := fs.String("script", "", "用本地的 install.sh（默认从仓库取最新的）")
	// 两个一次性开关（ADR-0016）：都不记进 install-state
	whenIdle := fs.Bool("when-idle", false, "等所有会话都停在提示符再动")
	forceRestart := fs.Bool("force-restart", false, "不热升级，走 systemctl restart（会关闭所有会话）；还是用户服务的机器顺带迁移成系统服务（ADR-0034）")
	if err := fs.Parse(args); err != nil {
		return err
	}

	installArgs, err := readInstallState(*statePath)
	if err != nil {
		return err
	}

	fmt.Printf("webterm %s\n\n", version)
	fmt.Println("  按上次的安装参数升级：")
	fmt.Printf("    %s\n\n", strings.Join(installArgs, " "))

	scriptPath := *local
	if scriptPath == "" {
		script, src, err := fetchInstallScript()
		if err != nil {
			return err
		}
		fmt.Printf("  安装脚本来源：%s\n\n", src)

		tmp, err := os.CreateTemp("", "webterm-install-*.sh")
		if err != nil {
			return err
		}
		defer os.Remove(tmp.Name())
		if _, err := tmp.Write(script); err != nil {
			tmp.Close()
			return err
		}
		tmp.Close()
		scriptPath = tmp.Name()
	} else {
		fmt.Printf("  安装脚本来源：%s（--script）\n\n", scriptPath)
	}

	// --if-newer 让 install.sh 在版本没变时【什么都不动】。
	// 不能无条件重装：那会重启服务，把正在用的会话踢掉。
	full := append([]string{scriptPath}, append(installArgs, "--if-newer")...)
	if *whenIdle {
		full = append(full, "--when-idle")
	}
	if *forceRestart {
		full = append(full, "--force-restart")
	}
	if *dryRun {
		fmt.Printf("  $ bash %s\n", strings.Join(full, " "))
		return nil
	}

	cmd := exec.Command("bash", full...)
	// 直连终端：install.sh 里的 sudo 要能弹密码提示。
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	return cmd.Run()
}

// readInstallState 读回上次的安装参数。
func readInstallState(path string) ([]string, error) {
	if path == "" {
		return nil, errors.New("定位不到配置目录，用 --state 指定安装参数文件")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("没有 %s —— 这台机器还没用 install.sh 装过，\n"+
				"或者装它的版本还不会记安装参数。先正常装一次，之后 update 就能用了。\n"+
				"安装说明见 docs/80-ops/install.md", path)
		}
		return nil, err
	}
	var args []string
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		args = append(args, line)
	}
	if len(args) == 0 {
		return nil, fmt.Errorf("%s 里没有可用的参数", path)
	}
	return args, nil
}

// fetchInstallScript 取最新的 install.sh。
//
// 三级回退和 install.sh 自己取二进制时【同一套顺序】：先匿名，
// 私有仓库下匿名必然 404，再试 gh，最后试 token。
func fetchInstallScript() ([]byte, string, error) {
	repo := os.Getenv("WEBTERM_REPO")
	if repo == "" {
		repo = "sunhaijun/webterm"
	}

	raw := fmt.Sprintf("https://raw.githubusercontent.com/%s/main/scripts/install.sh", repo)
	if b, err := httpGet(raw, ""); err == nil {
		return b, raw, nil
	}

	if _, err := exec.LookPath("gh"); err == nil {
		out, err := exec.Command("gh", "api",
			fmt.Sprintf("repos/%s/contents/scripts/install.sh", repo),
			"-H", "Accept: application/vnd.github.raw").Output()
		if err == nil && len(out) > 0 {
			return out, "gh api（私有仓库凭据）", nil
		}
	}

	api := fmt.Sprintf("https://api.github.com/repos/%s/contents/scripts/install.sh", repo)
	for _, env := range []string{"GH_TOKEN", "GITHUB_TOKEN"} {
		if tok := os.Getenv(env); tok != "" {
			if b, err := httpGet(api, tok); err == nil {
				return b, api + "（" + env + "）", nil
			}
		}
	}

	return nil, "", fmt.Errorf("拿不到 install.sh。仓库是私有的话需要凭据：\n"+
		"  gh auth login          （推荐）\n"+
		"  export GH_TOKEN=<有 repo 读权限的 token>\n"+
		"试过的来源：%s", raw)
}

func httpGet(url, token string) ([]byte, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Accept", "application/vnd.github.raw")
	}
	c := &http.Client{Timeout: 30 * time.Second}
	resp, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s: HTTP %d", url, resp.StatusCode)
	}
	// 脚本不该有几 MB —— 限一下，别把意外的大响应读进内存
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(string(b), "#!") {
		return nil, fmt.Errorf("%s 返回的不像脚本", url)
	}
	return b, nil
}
