package main

import (
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newFS 造一个带常见 flag 的 FlagSet，模拟 serve。
func newFS() (*flag.FlagSet, *string, *int, *bool) {
	fs := flag.NewFlagSet("t", flag.ContinueOnError)
	fs.SetOutput(os.NewFile(0, os.DevNull))
	domain := fs.String("domain", "", "")
	port := fs.Int("https-port", 443, "")
	noLogin := fs.Bool("no-login-shell", false, "")
	return fs, domain, port, noLogin
}

func write(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "config")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestConfigFileFillsFlags(t *testing.T) {
	path := write(t, `
# 注释

domain     = term.example.com
https-port = 8443
no-login-shell = true
`)
	fs, domain, port, noLogin := newFS()
	if err := loadConfigInto(fs, path); err != nil {
		t.Fatal(err)
	}
	if err := fs.Parse(nil); err != nil {
		t.Fatal(err)
	}
	if *domain != "term.example.com" {
		t.Errorf("domain = %q", *domain)
	}
	if *port != 8443 {
		t.Errorf("https-port = %d", *port)
	}
	if !*noLogin {
		t.Error("no-login-shell 应当为 true")
	}
}

// 命令行必须压过配置文件 —— 否则临时改一次就得动文件。
func TestCommandLineOverridesConfigFile(t *testing.T) {
	path := write(t, "domain = from-file.example.com\nhttps-port = 8443\n")
	fs, domain, port, _ := newFS()
	if err := loadConfigInto(fs, path); err != nil {
		t.Fatal(err)
	}
	if err := fs.Parse([]string{"--domain", "from-argv.example.com"}); err != nil {
		t.Fatal(err)
	}
	if *domain != "from-argv.example.com" {
		t.Errorf("命令行没能覆盖配置文件：domain = %q", *domain)
	}
	if *port != 8443 {
		t.Errorf("没被命令行提到的键应当保留配置文件的值：https-port = %d", *port)
	}
}

// 键名写错必须当场报错并指出行号。安静忽略是最难查的那种 bug。
func TestUnknownKeyIsAnErrorWithLineNumber(t *testing.T) {
	path := write(t, "domain = a.example.com\n\nhttpsport = 8443\n")
	fs, _, _, _ := newFS()
	err := loadConfigInto(fs, path)
	if err == nil {
		t.Fatal("键名写错却没报错")
	}
	for _, want := range []string{"httpsport", ":3", "没有"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("错误信息里缺 %q: %v", want, err)
		}
	}
}

// 属于别的子命令的键要跳过，不能当成写错 ——
// 配置文件是所有子命令共用的一份。
func TestKeyOfAnotherSubcommandIsSkipped(t *testing.T) {
	path := write(t, "domain = a.example.com\nmax-sessions = 5\n")
	fs, domain, _, _ := newFS() // 这个 FlagSet 没有 max-sessions
	if err := loadConfigInto(fs, path); err != nil {
		t.Fatalf("合法但不属于本子命令的键不该报错: %v", err)
	}
	if err := fs.Parse(nil); err != nil {
		t.Fatal(err)
	}
	if *domain != "a.example.com" {
		t.Errorf("domain = %q", *domain)
	}
}

// --dev 和 --config 不许进配置文件，理由见 configKeys 的注释。
func TestDevAndConfigAreRejected(t *testing.T) {
	for _, key := range []string{"dev", "config"} {
		path := write(t, key+" = true\n")
		fs, _, _, _ := newFS()
		if err := loadConfigInto(fs, path); err == nil {
			t.Errorf("%q 不该被允许写进配置文件", key)
		}
	}
}

// 文件不存在不是错误 —— 大多数人不需要配置文件。
func TestMissingConfigFileIsFine(t *testing.T) {
	fs, _, _, _ := newFS()
	if err := loadConfigInto(fs, filepath.Join(t.TempDir(), "nope")); err != nil {
		t.Errorf("配置文件不存在时不该报错: %v", err)
	}
}

// 只写键名的布尔项算 true。
func TestBareBooleanKey(t *testing.T) {
	path := write(t, "no-login-shell\n")
	fs, _, _, noLogin := newFS()
	if err := loadConfigInto(fs, path); err != nil {
		t.Fatal(err)
	}
	if err := fs.Parse(nil); err != nil {
		t.Fatal(err)
	}
	if !*noLogin {
		t.Error("只写键名的布尔项应当算 true")
	}
}

// 值非法时要说清是配置文件的问题，别让人以为是命令行敲错了。
func TestBadValueMentionsTheFile(t *testing.T) {
	path := write(t, "https-port = 不是数字\n")
	fs, _, _, _ := newFS()
	err := loadConfigInto(fs, path)
	if err == nil {
		t.Fatal("非法值没报错")
	}
	if !strings.Contains(err.Error(), "https-port") || !strings.Contains(err.Error(), ":1") {
		t.Errorf("错误信息应当指出键名与行号: %v", err)
	}
}

// ★ 防漂移：白名单里的每个键都必须是 serve 真有的 flag。
// 少了这条，改 flag 名之后配置文件会安静地失效。
func TestConfigKeysAllExistOnServe(t *testing.T) {
	fs := serveFlagSet()
	for key := range configKeys {
		if fs.Lookup(key) == nil {
			t.Errorf("configKeys 里的 %q 不是 serve 的 flag —— 改名后配置会安静失效", key)
		}
	}
}

// ★ 反向：serve 上那些"该能配"的 flag 都在白名单里。
func TestServeFlagsAreConfigurable(t *testing.T) {
	// 这几个刻意不进配置文件。handoff-fd 是热升级时旧进程在 exec 那一刻传的
	// 内部参数（ADR-0016），写进配置文件只会让 serve 去读一个不存在的 fd
	excluded := map[string]bool{"dev": true, "config": true, "handoff-fd": true}
	fs := serveFlagSet()
	fs.VisitAll(func(f *flag.Flag) {
		if excluded[f.Name] || configKeys[f.Name] {
			return
		}
		t.Errorf("serve 有 --%s 但没进 configKeys —— 要么加进去，要么在 excluded 里说明为什么", f.Name)
	})
}
