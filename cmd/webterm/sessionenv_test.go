package main

import (
	"flag"
	"os"
	"strings"
	"testing"
)

// --session-env 的就地校验（AC-7.8）。
//
// 写错的一条必须在【解析时】就报出来：环境变量没生效是最难在事后看出来的
// 一类问题，等到某个会话里 $FOO 是空的再回头猜，成本高得离谱。
func TestSessionEnvValidation(t *testing.T) {
	cases := []struct {
		name, in, wantErr string
	}{
		{"正常", "FOO=bar", ""},
		{"值里可以有等号", "FOO=a=b", ""},
		{"空值合法（有些开关就是靠「设了没」判断）", "FOO=", ""},
		{"缺等号", "FOO", "KEY=VAL"},
		{"空键", "=bar", "KEY=VAL"},
		{"键里有空格", "A B=c", "不合法"},
		{"TERM 不给改", "TERM=dumb", "TERM"},
		{"WEBTERM_SESSION 不给改", "WEBTERM_SESSION=9", "WEBTERM_SESSION"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var l envList
			err := l.Set(tc.in)
			switch {
			case tc.wantErr == "" && err != nil:
				t.Fatalf("Set(%q) 报错了: %v", tc.in, err)
			case tc.wantErr == "" && len(l) != 1:
				t.Fatalf("Set(%q) 之后 = %v，应当收下这一条", tc.in, l)
			case tc.wantErr != "" && err == nil:
				t.Fatalf("Set(%q) 应当报错", tc.in)
			case tc.wantErr != "" && !strings.Contains(err.Error(), tc.wantErr):
				t.Fatalf("Set(%q) 的错误 = %q，里面应当有 %q —— 用户得看得出哪儿写错了",
					tc.in, err.Error(), tc.wantErr)
			}
		})
	}
}

// 可重复，且配置文件与命令行【合并】而不是互相替换。
//
// 合并之后命令行那条排在后面，buildEnv 里"后写的胜出"就让
// 「命令行压过配置文件」这条通用规则在切片型 flag 上也成立。
func TestSessionEnvRepeatableAndConfigMerge(t *testing.T) {
	path := write(t, "session-env = A=from-file\nsession-env = B=from-file\n")

	fs := flag.NewFlagSet("t", flag.ContinueOnError)
	fs.SetOutput(os.NewFile(0, os.DevNull))
	var list envList
	fs.Var(&list, "session-env", "")

	if err := loadConfigInto(fs, path); err != nil {
		t.Fatal(err)
	}
	if err := fs.Parse([]string{"--session-env", "A=from-cli"}); err != nil {
		t.Fatal(err)
	}

	want := []string{"A=from-file", "B=from-file", "A=from-cli"}
	if len(list) != len(want) {
		t.Fatalf("session-env = %v, want %v", list, want)
	}
	for i := range want {
		if list[i] != want[i] {
			t.Fatalf("session-env[%d] = %q, want %q（顺序决定谁胜出）", i, list[i], want[i])
		}
	}
}

// 配置文件里写错的 --session-env 也要在启动时就报出来，而不是被安静地收下。
func TestSessionEnvBadValueInConfigFile(t *testing.T) {
	path := write(t, "session-env = TERM=dumb\n")
	fs := flag.NewFlagSet("t", flag.ContinueOnError)
	fs.SetOutput(os.NewFile(0, os.DevNull))
	var list envList
	fs.Var(&list, "session-env", "")

	err := loadConfigInto(fs, path)
	if err == nil {
		t.Fatal("配置文件里的 TERM=dumb 应当被拒")
	}
	if !strings.Contains(err.Error(), "TERM") {
		t.Fatalf("错误 = %q，里面应当点名 TERM", err.Error())
	}
}
