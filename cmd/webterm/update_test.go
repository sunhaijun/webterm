package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// install-state 一行一个参数、原样 replay —— 这正是它不做 key=value 的理由，
// 所以要钉住"读回来的和写下去的逐字一致"，注释和空行要跳过。
func TestReadInstallState(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "install-state")
	content := `# 由 scripts/install.sh 生成。
# 一行一个参数。

--domain
t.awtto.com
--https-port
8443
--channel
dev
`
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := readInstallState(path)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"--domain", "t.awtto.com", "--https-port", "8443", "--channel", "dev"}
	if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
		t.Errorf("读回 %q，想要 %q", got, want)
	}
}

// 带空格的值必须原样保留 —— 一行一个参数就是为了这个。
func TestReadInstallStateKeepsSpaces(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "install-state")
	if err := os.WriteFile(path, []byte("--prefix\n/opt/my apps/bin\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := readInstallState(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[1] != "/opt/my apps/bin" {
		t.Errorf("带空格的值被拆了: %q", got)
	}
}

// 没装过时要给能照着做的话，而不是一句 no such file。
func TestReadInstallStateMissing(t *testing.T) {
	_, err := readInstallState(filepath.Join(t.TempDir(), "nope"))
	if err == nil {
		t.Fatal("文件不存在却没报错")
	}
	for _, want := range []string{"还没用 install.sh 装过", "install.md"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("报错里缺 %q：%v", want, err)
		}
	}
}

// 只有注释的文件等于没有参数 —— 不能拿空参数去重跑安装。
func TestReadInstallStateEmpty(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "install-state")
	if err := os.WriteFile(path, []byte("# 只有注释\n\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readInstallState(path); err == nil {
		t.Error("空参数却没报错")
	}
}

// install-state 和 config 应该在同一个目录里 —— 都归 XDG 配置目录管。
func TestInstallStatePathSitsBesideConfig(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "/x/cfg")
	if got, want := installStatePath(), "/x/cfg/webterm/install-state"; got != want {
		t.Errorf("installStatePath()=%q，想要 %q", got, want)
	}
	if filepath.Dir(installStatePath()) != filepath.Dir(defaultConfigPath()) {
		t.Errorf("install-state 和 config 不在同一个目录：%q vs %q",
			installStatePath(), defaultConfigPath())
	}
}
