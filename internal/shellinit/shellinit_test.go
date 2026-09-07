package shellinit_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sunhaijun/webterm/internal/shellinit"
)

// 脚本本身必须是合法 bash —— 语法错误会让每个会话的 shell 都启动失败。
func TestScriptSyntaxValid(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "s.bash")
	if err := os.WriteFile(path, []byte(shellinit.Script()), 0o644); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("bash", "-n", path).CombinedOutput(); err != nil {
		t.Fatalf("bash -n 报错: %v\n%s", err, out)
	}
}

func TestRCFileSyntaxValid(t *testing.T) {
	for _, login := range []bool{true, false} {
		name := "非登录"
		if login {
			name = "登录"
		}
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "rc.bash")
			if err := os.WriteFile(path, []byte(shellinit.RCFile(login)), 0o644); err != nil {
				t.Fatal(err)
			}
			if out, err := exec.Command("bash", "-n", path).CombinedOutput(); err != nil {
				t.Fatalf("bash -n 报错: %v\n%s", err, out)
			}
		})
	}
}

// 登录模式【不能】额外 source ~/.bashrc —— 重复加载会让 PATH 重复、
// 别名重复定义、prompt 被叠加。
func TestLoginModeDoesNotSourceBashrc(t *testing.T) {
	rc := shellinit.RCFile(true)
	if strings.Contains(rc, `. "$HOME/.bashrc"`) {
		t.Fatal("登录模式里出现了对 ~/.bashrc 的直接 source")
	}
	if !strings.Contains(rc, ".bash_profile") {
		t.Fatal("登录模式没有走 profile 链")
	}
}

func TestNonLoginModeSourcesBashrcOnly(t *testing.T) {
	rc := shellinit.RCFile(false)
	if !strings.Contains(rc, `.bashrc`) {
		t.Fatal("非登录模式没有加载 .bashrc")
	}
	if strings.Contains(rc, ".bash_profile") {
		t.Fatal("非登录模式不该碰 .bash_profile")
	}
}

// 钩子必须装在用户配置【之后】—— 它要包装而不是被覆盖。
func TestHooksInstalledAfterUserConfig(t *testing.T) {
	for _, login := range []bool{true, false} {
		rc := shellinit.RCFile(login)
		userCfg := strings.LastIndex(rc, ".bashrc")
		hooks := strings.Index(rc, "__webterm_install")
		if hooks < 0 {
			hooks = strings.Index(rc, "__webterm_preexec")
		}
		if hooks < 0 {
			t.Fatal("rcfile 里找不到钩子")
		}
		if hooks < userCfg {
			t.Fatalf("login=%v：钩子装在了用户配置之前", login)
		}
	}
}

// rcfile 权限必须是 0600 —— 同机的其它用户不在信任边界内。
func TestRenderPermissions(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "run")
	path, err := shellinit.Render(7, shellinit.Options{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Fatalf("rcfile 权限 = %04o, want 0600", perm)
	}
	di, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if perm := di.Mode().Perm(); perm != 0o700 {
		t.Fatalf("运行时目录权限 = %04o, want 0700", perm)
	}
	// 文件名要带 sid 与随机后缀，便于排障且不会撞名
	if !strings.Contains(filepath.Base(path), "rc-7-") {
		t.Fatalf("rcfile 名字 = %q，应当带上 sid", filepath.Base(path))
	}
}

// 【不放 /tmp】：那是所有用户可读的目录，且系统清理策略可能在会话运行期间
// 把文件删掉。
func TestRenderRequiresExplicitDir(t *testing.T) {
	if _, err := shellinit.Render(1, shellinit.Options{}); err == nil {
		t.Fatal("没指定目录却成功了 —— 不能默默落到 /tmp")
	}
}

// 脚本里的变量与函数必须统一 __webterm_ 前缀，避免污染用户命名空间。
func TestNoNamespacePollution(t *testing.T) {
	for _, line := range strings.Split(shellinit.Script(), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "#") || trimmed == "" {
			continue
		}
		// 函数定义
		if name, ok := strings.CutSuffix(trimmed, "() {"); ok {
			if !strings.HasPrefix(name, "__webterm_") {
				t.Errorf("函数 %q 没有 __webterm_ 前缀", name)
			}
		}
	}
}
