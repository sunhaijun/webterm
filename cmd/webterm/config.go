package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// 配置文件让 pair / doctor / devices 不必每次重复 --domain --https-port。
//
// 【键名就是 flag 名】，去掉前面的 --。刻意不用 TOML/YAML：那要引依赖，
// 而配置只有十来个平铺的键。共用一套名字的好处是二者不可能漂移 ——
// `webterm serve --help` 就是配置文件的文档，且有测试钉住
// （TestConfigKeysAllExistOnServe / TestServeFlagsAreConfigurable）。

// configKeys 是允许出现在配置文件里的键。
//
// 用白名单而不是"凡是 flag 都行"，因为配置文件是【所有子命令共用一份】：
// 属于别的子命令的键必须能安静跳过（比如 devices 没有 --https-port），
// 而写错的键必须报错。两者只能靠一份显式清单区分。
//
// 【dev 与 config 刻意不在里面】：--dev 是"临时本地跑一下"的开关，写进
// 文件等于把生产配置永久降级；--config 会自我循环。
var configKeys = map[string]bool{
	"domain":               true,
	"data-dir":             true,
	"bind":                 true,
	"http-port":            true,
	"https-port":           true,
	"no-tls":               true,
	"trust-proxy":          true,
	"acme-staging":         true,
	"shell":                true,
	"max-sessions":         true,
	"max-conns":            true,
	"max-history":          true,
	"no-history":           true,
	"ring-bytes":           true,
	"session-env":          true,
	"no-altscreen-compat":  true,
	"no-shell-integration": true,
	"no-login-shell":       true,
	"log-level":            true,
}

// defaultConfigPath 遵循 XDG：$XDG_CONFIG_HOME/webterm/config，否则
// ~/.config/webterm/config。
func defaultConfigPath() string {
	if d := os.Getenv("XDG_CONFIG_HOME"); d != "" {
		return filepath.Join(d, "webterm", "config")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "webterm", "config")
}

// configPathFrom 在正式 Parse 之前先把 --config 抠出来。
//
// 有鸡生蛋问题：--config 指向的文件要用来填 flag，可它本身也是个 flag。
// 手工扫一遍 argv 最简单，也不会影响后续的正常解析。
func configPathFrom(args []string) string {
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--config" || a == "-config":
			if i+1 < len(args) {
				return args[i+1]
			}
		case strings.HasPrefix(a, "--config="):
			return strings.TrimPrefix(a, "--config=")
		case strings.HasPrefix(a, "-config="):
			return strings.TrimPrefix(a, "-config=")
		}
	}
	return defaultConfigPath()
}

// loadConfigInto 把配置文件的值灌进 fs。
//
// 【必须在 fs.Parse(args) 之前调用】—— 它只是改 flag 的当前值，随后的
// Parse 会用命令行覆盖，这就实现了"命令行压过配置文件"。
//
// 文件不存在不是错误：大多数人不需要配置文件。
func loadConfigInto(fs *flag.FlagSet, path string) error {
	if path == "" {
		return nil
	}
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("读配置文件 %s: %w", path, err)
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for line := 1; sc.Scan(); line++ {
		text := strings.TrimSpace(sc.Text())
		if text == "" || strings.HasPrefix(text, "#") {
			continue
		}
		key, val := text, "true" // 只写键名的布尔项算 true
		if i := strings.IndexByte(text, '='); i >= 0 {
			key = strings.TrimSpace(text[:i])
			val = strings.TrimSpace(text[i+1:])
		}
		key = strings.TrimLeft(key, "-") // 容忍写成 --domain

		if !configKeys[key] {
			if key == "dev" || key == "config" {
				return fmt.Errorf("%s:%d: --%s 不能写进配置文件。\n"+
					"  --dev 是「临时本地跑一下」的开关，写进文件等于把生产配置永久降级；\n"+
					"  --config 会自我循环。两个都只能在命令行上给", path, line, key)
			}
			return fmt.Errorf("%s:%d: 没有 --%s 这个选项。\n"+
				"  可用的键见 webterm serve --help（去掉前面的 --）", path, line, key)
		}
		if fs.Lookup(key) == nil {
			continue // 合法，但属于别的子命令
		}
		if err := fs.Set(key, val); err != nil {
			return fmt.Errorf("%s:%d: --%s 的值 %q 不合法: %w", path, line, key, val, err)
		}
	}
	if err := sc.Err(); err != nil {
		return fmt.Errorf("读配置文件 %s: %w", path, err)
	}
	return nil
}

// registerConfigFlag 给子命令加上 --config，并返回该用哪个路径。
func registerConfigFlag(fs *flag.FlagSet, args []string) string {
	path := configPathFrom(args)
	fs.String("config", path, "配置文件路径")
	return path
}

// applyConfig 是子命令的标准前置：注册 --config、灌配置、然后交给调用方 Parse。
func applyConfig(fs *flag.FlagSet, args []string) error {
	return loadConfigInto(fs, registerConfigFlag(fs, args))
}
