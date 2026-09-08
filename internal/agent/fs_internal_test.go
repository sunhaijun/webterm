package agent

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// UT-fs-1：路径补全的纯函数部分（ADR-0011 ③）。
func TestCompletePath(t *testing.T) {
	root := t.TempDir()
	mk := func(rel string, dir bool) {
		t.Helper()
		p := filepath.Join(root, rel)
		if dir {
			if err := os.MkdirAll(p, 0o755); err != nil {
				t.Fatal(err)
			}
			return
		}
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, d := range []string{"docs", "src/commands", ".git", "home/proj"} {
		mk(d, true)
	}
	for _, f := range []string{"src/a.go", "README.md", "dotfile", ".env", "zz.txt"} {
		mk(f, false)
	}
	if err := os.Symlink(filepath.Join(root, "docs"), filepath.Join(root, "link-to-docs")); err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(root, "home")

	// 目录带 / 后缀，一眼看出 Dir 标记对不对
	names := func(r fsResult) []string {
		out := []string{}
		for _, it := range r.Items {
			if it.Dir {
				out = append(out, it.Name+"/")
			} else {
				out = append(out, it.Name)
			}
		}
		return out
	}

	cases := []struct {
		name, partial string
		want          []string
	}{
		{"空：目录在前、隐藏项不出、符号链接按指向算目录", "", []string{"docs/", "home/", "link-to-docs/", "src/", "README.md", "dotfile", "zz.txt"}},
		{"前缀过滤", "do", []string{"docs/", "dotfile"}},
		{"敲了点才出隐藏项", ".", []string{".git/", ".env"}},
		{"以 / 结尾列里面", "src/", []string{"commands/", "a.go"}},
		{"目录里再过滤", "src/c", []string{"commands/"}},
		{"~ 展开", "~/", []string{"proj/"}},
		{"~/ 再过滤", "~/p", []string{"proj/"}},
		{"绝对路径", root + "/sr", []string{"src/"}},
		{"不存在的目录是空列表不是错", "nope/x", []string{}},
		{"文件当目录也是空", "README.md/", []string{}},
		{"没有匹配也是空", "qqq", []string{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := names(completePath(root, tc.partial, home))
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("completePath(%q) = %v, want %v", tc.partial, got, tc.want)
			}
		})
	}

	t.Run("结果永远是数组，不是 null", func(t *testing.T) {
		r := completePath(root, "nope/", home)
		if r.Items == nil {
			t.Fatal("Items 是 nil，序列化会变成 null，客户端一个 .length 就白屏")
		}
	})

	t.Run("上限 50 条", func(t *testing.T) {
		many := filepath.Join(root, "many")
		mk("many", true)
		for i := 0; i < fsMaxItems+10; i++ {
			mk(filepath.Join("many", fmt.Sprintf("f%02d", i)), false)
		}
		if n := len(completePath(root, "many/", home).Items); n != fsMaxItems {
			t.Errorf("len = %d, want %d", n, fsMaxItems)
		}
		_ = many
	})

	t.Run("home 未知时 ~ 原样（列不到东西，但不崩）", func(t *testing.T) {
		if n := len(completePath(root, "~/", "").Items); n != 0 {
			t.Errorf("len = %d, want 0", n)
		}
	})
}
