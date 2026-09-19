package session

import "testing"

// 会话环境的优先级（AC-7.8）：
//
//	fixed > --session-env > 继承的环境 > 内置兼容清单
//
// 这四条的次序每一条都有具体的坏结果兜底，见各用例的说明。
func TestBuildEnvPrecedence(t *testing.T) {
	compat := []string{"COMPAT=1"}
	fixed := []string{"TERM=xterm-256color", "WEBTERM_SESSION=7"}

	cases := []struct {
		name       string
		base       []string
		sessionEnv []string
		key, want  string
	}{
		{
			"继承的环境里没有 → 清单生效",
			nil, nil, "COMPAT", "1",
		},
		{
			"用户自己的环境里已经有 → 清单不覆盖（这是他的机器）",
			[]string{"COMPAT=0"}, nil, "COMPAT", "0",
		},
		{
			"--session-env 压过清单",
			nil, []string{"COMPAT=0"}, "COMPAT", "0",
		},
		{
			"--session-env 压过继承的环境（显式的意图胜过碰巧继承来的）",
			[]string{"FOO=inherited"}, []string{"FOO=explicit"}, "FOO", "explicit",
		},
		{
			"同一个键给了两次 → 后面的胜出（配置文件先灌、命令行后 Parse）",
			nil, []string{"FOO=first", "FOO=second"}, "FOO", "second",
		},
		{
			"TERM 由 webterm 定死，--session-env 也改不了（flag 层已经拒了，这里是第二道）",
			[]string{"TERM=screen"}, []string{"TERM=dumb"}, "TERM", "xterm-256color",
		},
		{
			"继承的环境原样保留",
			[]string{"PATH=/usr/bin"}, nil, "PATH", "/usr/bin",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := buildEnv(tc.base, compat, tc.sessionEnv, fixed)
			v, ok := lookupEnv(got, tc.key)
			if !ok || v != tc.want {
				t.Fatalf("%s = %q (存在=%v), want %q\n环境: %v", tc.key, v, ok, tc.want, got)
			}
		})
	}
}

// 每个键只出现一次。exec 自己也会去重（保留最后一条），但那是隐式规则 ——
// 依赖它的话，任何换实现的人都会踩到"为什么设了两遍"。
func TestBuildEnvDedup(t *testing.T) {
	got := buildEnv(
		[]string{"A=1", "A=2", "B=1"},
		[]string{"A=3"},
		[]string{"B=2"},
		nil,
	)
	if n := countKey(got, "A"); n != 1 {
		t.Fatalf("A 出现 %d 次，应当只有一次：%v", n, got)
	}
	if v, _ := lookupEnv(got, "A"); v != "2" {
		t.Fatalf("A = %q, want 2（base 里后写的胜出，清单不覆盖已有键）", v)
	}
	if v, _ := lookupEnv(got, "B"); v != "2" {
		t.Fatalf("B = %q, want 2", v)
	}
}

// 没有 '=' 的条目没有键，直接丢掉 —— 塞进 exec.Cmd.Env 只会得到一个
// 谁也读不到的垃圾项。
func TestBuildEnvDropsMalformed(t *testing.T) {
	got := buildEnv([]string{"GOOD=1", "NOEQUALS", "=novalue"}, nil, nil, nil)
	if len(got) != 1 || got[0] != "GOOD=1" {
		t.Fatalf("环境 = %v, want [GOOD=1]", got)
	}
}

// --no-altscreen-compat 关掉整份清单；零值（没填过 Config）必须是"清单生效"。
func TestCompatEnvToggle(t *testing.T) {
	var on Config
	if len(on.compatEnv()) == 0 {
		t.Fatal("零值 Config 应当带上兼容清单 —— 默认开的开关写成反向字段就是为了这个")
	}
	off := Config{NoAltScreenCompat: true}
	if got := off.compatEnv(); got != nil {
		t.Fatalf("--no-altscreen-compat 之后还剩 %v", got)
	}
}

// 清单本身的纪律：只放"把 TUI 拉回主屏"这一类开关，且每条都是合法的 KEY=VAL。
func TestAltScreenCompatShape(t *testing.T) {
	if len(altScreenCompat) == 0 {
		t.Fatal("清单空了？那 --no-altscreen-compat 就没有意义了")
	}
	for _, kv := range altScreenCompat {
		if envKey(kv) == "" {
			t.Fatalf("清单里的 %q 不是 KEY=VAL", kv)
		}
	}
}

func lookupEnv(env []string, key string) (string, bool) {
	for _, kv := range env {
		if envKey(kv) == key {
			return kv[len(key)+1:], true
		}
	}
	return "", false
}

func countKey(env []string, key string) int {
	n := 0
	for _, kv := range env {
		if envKey(kv) == key {
			n++
		}
	}
	return n
}
