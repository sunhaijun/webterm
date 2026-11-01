package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/sunhaijun/webterm/scripts"
)

// install.sh 的行为测试（ADR-0045）。全都不联网、不需要 sudo、不碰 systemd：
// --print-unit 只打印；真跑的几条都带 --no-service --no-setcap，装到临时目录。

const installScript = "../../scripts/install.sh"

// sandbox 是一个干净的 HOME：install-state / 配置文件都落在这里，不读开发机上的。
type sandbox struct {
	home, config, prefix string
}

func newSandbox(t *testing.T) sandbox {
	t.Helper()
	if os.Geteuid() == 0 {
		t.Skip("install.sh 拒绝以 root 运行")
	}
	home := t.TempDir()
	return sandbox{home: home, config: filepath.Join(home, ".config", "webterm"), prefix: filepath.Join(home, "bin")}
}

func (sb sandbox) run(t *testing.T, env []string, args ...string) (string, error) {
	t.Helper()
	cmd := exec.Command("bash", append([]string{installScript}, args...)...)
	cmd.Env = append(os.Environ(), "HOME="+sb.home, "XDG_CONFIG_HOME="+filepath.Join(sb.home, ".config"))
	cmd.Env = append(cmd.Env, env...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func (sb sandbox) writeState(t *testing.T, lines ...string) {
	t.Helper()
	if err := os.MkdirAll(sb.config, 0o755); err != nil {
		t.Fatal(err)
	}
	body := "# 测试写的\n" + strings.Join(lines, "\n") + "\n"
	if err := os.WriteFile(filepath.Join(sb.config, "install-state"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// execStart 从 --print-unit 的输出里取出 ExecStart 那一行。
func execStart(t *testing.T, unit string) string {
	t.Helper()
	for _, l := range strings.Split(unit, "\n") {
		if strings.HasPrefix(l, "ExecStart=") {
			return l
		}
	}
	t.Fatalf("单元里没有 ExecStart：\n%s", unit)
	return ""
}

// fakeBinary 写一个假的 webterm：version 报版本；install 把收到的参数记进 $FAKE_LOG。
// withInstall=false 模拟 v0.1.0 那种不认 install 的旧版本。
func fakeBinary(t *testing.T, path string, withInstall bool) {
	t.Helper()
	install := `shift; printf '%s\n' "$@" > "$FAKE_LOG"; exit 0`
	if !withInstall {
		install = `echo "未知子命令 \"install\"" >&2; exit 2`
	}
	script := "#!/bin/bash\ncase \"$1\" in\n" +
		"  version) echo 'webterm fake-1' ;;\n" +
		"  install) " + install + " ;;\n" +
		"  *) exit 0 ;;\n" +
		"esac\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
}

// UT-install-embed：嵌进二进制的就是 scripts/install.sh，一个字节都不差。
func TestInstallScriptIsEmbedded(t *testing.T) {
	disk, err := os.ReadFile(installScript)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(disk, scripts.InstallSH) {
		t.Fatal("嵌入的 install.sh 与磁盘上的不一致")
	}
	if got := withSelfBinary("/x/webterm", []string{"--domain", "a"}); strings.Join(got, " ") != "--binary /x/webterm --domain a" {
		t.Errorf("webterm install 没把自己作为 --binary 传给脚本: %v", got)
	}
	if got := withSelfBinary("/x/webterm", []string{"--binary", "/y"}); strings.Join(got, " ") != "--binary /y" {
		t.Errorf("用户给了 --binary 时不该再补一个: %v", got)
	}
}

// UT-install-default-addr：不给 --domain 时，没装过就用公网 IP，装过就沿用 install-state。
func TestInstallScriptDefaultAddress(t *testing.T) {
	t.Run("没装过 → 公网 IP", func(t *testing.T) {
		sb := newSandbox(t)
		out, err := sb.run(t, []string{"WEBTERM_PUBLIC_IP=203.0.113.9"}, "--print-unit")
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		if got := execStart(t, out); got != "ExecStart=/usr/local/bin/webterm serve --domain 203.0.113.9" {
			t.Errorf("ExecStart = %q", got)
		}
	})

	t.Run("装过 → 沿用上次的参数，命令行覆盖同名项", func(t *testing.T) {
		sb := newSandbox(t)
		sb.writeState(t, "--domain", "term.example.com", "--https-port", "8443")
		out, err := sb.run(t, []string{"WEBTERM_PUBLIC_IP=203.0.113.9"}, "--print-unit")
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		if got := execStart(t, out); got != "ExecStart=/usr/local/bin/webterm serve --domain term.example.com --https-port 8443" {
			t.Errorf("没沿用 install-state: %q", got)
		}

		out, err = sb.run(t, nil, "--print-unit", "--https-port", "9443")
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		if got := execStart(t, out); got != "ExecStart=/usr/local/bin/webterm serve --domain term.example.com --https-port 9443" {
			t.Errorf("命令行没覆盖 install-state: %q", got)
		}
	})

	t.Run("给了 --domain 就不看 install-state", func(t *testing.T) {
		sb := newSandbox(t)
		sb.writeState(t, "--domain", "old.example.com", "--https-port", "8443")
		out, err := sb.run(t, nil, "--print-unit", "--domain", "203.0.113.5")
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		if got := execStart(t, out); got != "ExecStart=/usr/local/bin/webterm serve --domain 203.0.113.5" {
			t.Errorf("ExecStart = %q", got)
		}
	})

	t.Run("IPv6 拒绝", func(t *testing.T) {
		sb := newSandbox(t)
		out, err := sb.run(t, nil, "--print-unit", "--domain", "2001:db8::1")
		if err == nil || !strings.Contains(out, "IPv4") {
			t.Fatalf("IPv6 应当被拒并说明，err=%v\n%s", err, out)
		}
	})
}

// UT-install-config-sync：重装时地址和端口同步进配置文件，其它键原样保留。
func TestInstallScriptSyncsConfig(t *testing.T) {
	sb := newSandbox(t)
	bin := filepath.Join(sb.home, "webterm-new")
	fakeBinary(t, bin, true)
	if err := os.MkdirAll(sb.config, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := filepath.Join(sb.config, "config")
	old := "# 我的配置\ndomain = 203.0.113.9\nhttps-port = 8443\nsession-env = FOO=1\n"
	if err := os.WriteFile(cfg, []byte(old), 0o644); err != nil {
		t.Fatal(err)
	}

	out, err := sb.run(t, nil, "--binary", bin, "--no-service", "--no-setcap",
		"--prefix", sb.prefix, "--domain", "term.example.com", "--http-port", "8080")
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	got, err := os.ReadFile(cfg)
	if err != nil {
		t.Fatal(err)
	}
	s := string(got)
	for _, want := range []string{"# 我的配置", "domain = term.example.com", "http-port = 8080", "session-env = FOO=1"} {
		if !strings.Contains(s, want) {
			t.Errorf("配置里缺 %q：\n%s", want, s)
		}
	}
	for _, bad := range []string{"203.0.113.9", "https-port"} {
		if strings.Contains(s, bad) {
			t.Errorf("配置里不该还有 %q（地址换了、端口回到默认）：\n%s", bad, s)
		}
	}
	if _, err := os.Stat(filepath.Join(sb.prefix, "webterm")); err != nil {
		t.Errorf("--binary 的二进制没装到 --prefix: %v", err)
	}
	if strings.Contains(out, "2/6 下载") || strings.Contains(out, "来源:") {
		t.Errorf("--binary 不该下载：\n%s", out)
	}
}

// UT-install-handover：网上取的脚本下载、校验之后，交给下载来的二进制的 install，
// 参数原样传过去；不认 install 的旧版本被拒绝。
func TestInstallScriptHandsOverToDownloadedBinary(t *testing.T) {
	arch := map[string]string{"amd64": "amd64", "arm64": "arm64"}[runtime.GOARCH]
	if arch == "" {
		t.Skip("install.sh 只认 amd64 / arm64")
	}
	setup := func(t *testing.T, withInstall bool) (sandbox, string, string) {
		sb := newSandbox(t)
		dl := filepath.Join(sb.home, "dl")
		if err := os.MkdirAll(dl, 0o755); err != nil {
			t.Fatal(err)
		}
		name := "webterm-linux-" + arch
		fakeBinary(t, filepath.Join(dl, name), withInstall)
		raw, err := os.ReadFile(filepath.Join(dl, name))
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(raw)
		if err := os.WriteFile(filepath.Join(dl, "SHA256SUMS"),
			[]byte(hex.EncodeToString(sum[:])+"  "+name+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		return sb, dl, filepath.Join(sb.home, "fake.log")
	}

	t.Run("交给下载来的二进制", func(t *testing.T) {
		sb, dl, log := setup(t, true)
		args := []string{"--base-url", "file://" + dl, "--no-service", "--no-setcap",
			"--prefix", sb.prefix, "--domain", "term.example.com"}
		out, err := sb.run(t, []string{"FAKE_LOG=" + log}, args...)
		if err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		if !strings.Contains(out, "校验通过") || !strings.Contains(out, "交给 webterm fake-1 自带的安装脚本继续") {
			t.Errorf("没有校验或没有交接：\n%s", out)
		}
		got, err := os.ReadFile(log)
		if err != nil {
			t.Fatalf("下载来的二进制没被调用 install: %v\n%s", err, out)
		}
		if strings.TrimSpace(string(got)) != strings.Join(args, "\n") {
			t.Errorf("交接的参数 = %q，想要原样的 %q", got, args)
		}
		if _, err := os.Stat(filepath.Join(sb.prefix, "webterm")); err == nil {
			t.Error("外层脚本自己装了二进制 —— 交接之后它不该再做任何事")
		}
	})

	t.Run("旧版本不认 install → 拒绝", func(t *testing.T) {
		sb, dl, log := setup(t, false)
		out, err := sb.run(t, []string{"FAKE_LOG=" + log}, "--base-url", "file://"+dl, "--no-service", "--no-setcap",
			"--prefix", sb.prefix, "--domain", "term.example.com")
		if err == nil {
			t.Fatalf("旧版本应当被拒：\n%s", out)
		}
		if !strings.Contains(out, "早于这份安装脚本") || !strings.Contains(out, "--channel dev") {
			t.Errorf("拒绝的说明不清楚：\n%s", out)
		}
		if _, err := os.Stat(filepath.Join(sb.prefix, "webterm")); err == nil {
			t.Error("被拒之后不该装上任何东西")
		}
	})

	t.Run("校验和不对 → 中止、不交接", func(t *testing.T) {
		sb, dl, log := setup(t, true)
		if err := os.WriteFile(filepath.Join(dl, "SHA256SUMS"),
			[]byte(strings.Repeat("0", 64)+"  webterm-linux-"+arch+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		out, err := sb.run(t, []string{"FAKE_LOG=" + log}, "--base-url", "file://"+dl, "--no-service", "--no-setcap",
			"--prefix", sb.prefix, "--domain", "term.example.com")
		if err == nil || !strings.Contains(out, "校验和不匹配") {
			t.Fatalf("校验和不对应当中止，err=%v\n%s", err, out)
		}
		if _, err := os.Stat(log); err == nil {
			t.Error("校验没过却交接了")
		}
	})
}
