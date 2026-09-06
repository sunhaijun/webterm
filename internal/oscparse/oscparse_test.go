package oscparse_test

import (
	"encoding/base64"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/sunhaijun/webterm/internal/oscparse"
)

// feedAll 把 in 按 splits 切成若干片依次喂给解析器，返回拼接后的输出和全部事件。
func feedAll(in string, splits []int) (string, []oscparse.Event) {
	p := oscparse.New()
	var out strings.Builder
	var events []oscparse.Event
	prev := 0
	for _, s := range append(splits, len(in)) {
		if s <= prev {
			continue
		}
		o, ev := p.Feed([]byte(in[prev:s]))
		out.Write(o)
		events = append(events, ev...)
		prev = s
	}
	return out.String(), events
}

func feed(in string) (string, []oscparse.Event) { return feedAll(in, nil) }

func ptr[T any](v T) *T { return &v }

// UT-osc-1：webterm 相关的 OSC 全部被剥离，输出流里一个都不剩（AC-7.4）。
func TestOSC1_AllWebtermSequencesStripped(t *testing.T) {
	in := "a\x1b]133;A\x07b\x1b]133;B\x07c" +
		"\x1b]1701;cmd;" + base64.StdEncoding.EncodeToString([]byte("ls -la")) + "\x07" +
		"\x1b]133;C\x07d\x1b]7;file:///srv/x\x07e\x1b]133;D;0\x07f" +
		"\x1b]1701;hello;1\x07g"
	out, _ := feed(in)
	if out != "abcdefg" {
		t.Fatalf("out = %q, want %q", out, "abcdefg")
	}
	if strings.ContainsAny(out, "\x1b\x07") {
		t.Fatal("输出流里仍残留转义序列")
	}
}

// UT-osc-2：完整序列一次读入。
func TestOSC2_WholeSequenceInOneRead(t *testing.T) {
	out, ev := feed("before\x1b]133;D;0\x07after")
	if out != "beforeafter" {
		t.Fatalf("out = %q", out)
	}
	want := []oscparse.Event{
		oscparse.PromptEvent{State: "done"},
		oscparse.CommandEndEvent{ExitCode: ptr(0)},
	}
	if !reflect.DeepEqual(ev, want) {
		t.Fatalf("events = %#v, want %#v", ev, want)
	}
}

// UT-osc-3：序列被切成 N 份 —— 对每个字节位置都切一次，逐一验证。
// 流式解析器的 bug 就藏在分片边界。
func TestOSC3_SplitAtEveryByte(t *testing.T) {
	inputs := []struct {
		name   string
		in     string
		out    string
		events []oscparse.Event
	}{
		{
			"133_D", "before\x1b]133;D;0\x07after", "beforeafter",
			[]oscparse.Event{oscparse.PromptEvent{State: "done"}, oscparse.CommandEndEvent{ExitCode: ptr(0)}},
		},
		{
			"133_B_st", "x\x1b]133;B\x1b\\y", "xy",
			[]oscparse.Event{oscparse.PromptEvent{State: "input"}},
		},
		{
			"osc7", "a\x1b]7;file://host/srv/api\x07b", "ab",
			[]oscparse.Event{oscparse.CWDEvent{Path: "/srv/api"}},
		},
		{
			"osc1701_cmd", "\x1b]1701;cmd;" + base64.StdEncoding.EncodeToString([]byte("go test ./...")) + "\x07ok", "ok",
			[]oscparse.Event{oscparse.CommandTextEvent{Text: "go test ./..."}},
		},
		{
			"passthrough_title", "a\x1b]0;my title\x07b", "a\x1b]0;my title\x07b", nil,
		},
	}
	for _, tc := range inputs {
		t.Run(tc.name, func(t *testing.T) {
			// 单点切分：覆盖每一个字节边界
			for split := 1; split < len(tc.in); split++ {
				out, ev := feedAll(tc.in, []int{split})
				if out != tc.out {
					t.Fatalf("split=%d: out = %q, want %q", split, out, tc.out)
				}
				if !eventsEqual(ev, tc.events) {
					t.Fatalf("split=%d: events = %#v, want %#v", split, ev, tc.events)
				}
			}
			// 逐字节喂：最极端的分片
			var splits []int
			for i := 1; i < len(tc.in); i++ {
				splits = append(splits, i)
			}
			out, ev := feedAll(tc.in, splits)
			if out != tc.out {
				t.Fatalf("逐字节: out = %q, want %q", out, tc.out)
			}
			if !eventsEqual(ev, tc.events) {
				t.Fatalf("逐字节: events = %#v, want %#v", ev, tc.events)
			}
		})
	}
}

// UT-osc-4：ST 终止符 vs BEL 终止符 —— 脚本统一发 BEL，解析器必须都认。
func TestOSC4_BothTerminators(t *testing.T) {
	for _, term := range []struct{ name, s string }{{"BEL", "\x07"}, {"ST", "\x1b\\"}} {
		t.Run(term.name, func(t *testing.T) {
			out, ev := feed("a\x1b]133;C" + term.s + "b")
			if out != "ab" {
				t.Fatalf("out = %q", out)
			}
			if len(ev) != 1 || ev[0] != (oscparse.PromptEvent{State: "running"}) {
				t.Fatalf("events = %#v", ev)
			}
		})
	}
}

// UT-osc-5：超长负载 → 原样吐出，不能吞掉数据。
func TestOSC5_OversizedPayloadPassedThrough(t *testing.T) {
	huge := strings.Repeat("A", 9<<10) // 9 KiB > 8 KiB 上限
	in := "head\x1b]1701;cmd;" + huge + "\x07tail"
	out, ev := feed(in)
	if len(ev) != 0 {
		t.Fatalf("超限序列不该产生事件，得到 %#v", ev)
	}
	if !strings.HasPrefix(out, "head") || !strings.HasSuffix(out, "tail") {
		t.Fatalf("前后的正常字节丢了: %.20q ... %.20q", out, out[len(out)-20:])
	}
	if !strings.Contains(out, huge) {
		t.Fatal("超限的负载被吞掉了 —— 必须原样输出")
	}
}

// UT-osc-6：畸形 base64 → 剥离但无事件，不崩溃。
func TestOSC6_MalformedPayload(t *testing.T) {
	cases := []string{
		"\x1b]1701;cmd;!!!not-base64!!!\x07",
		"\x1b]1701;garbage\x07",
		"\x1b]1701\x07",
		"\x1b]7;not-a-url\x07",
		"\x1b]7;\x07",
		"\x1b]133\x07",
		"\x1b]133;\x07",
		"\x1b]133;D;notanumber\x07",
		"\x1b]133;Z\x07",
	}
	for _, c := range cases {
		t.Run(fmt.Sprintf("%q", c), func(t *testing.T) {
			out, ev := feed("x" + c + "y")
			if strings.Contains(out, "\x1b]133;D") || strings.Contains(out, "1701;cmd") {
				t.Fatalf("out = %q", out)
			}
			for _, e := range ev {
				if _, bad := e.(oscparse.CommandTextEvent); bad {
					t.Fatal("畸形负载产生了命令原文事件")
				}
				if _, bad := e.(oscparse.CWDEvent); bad {
					t.Fatal("畸形负载产生了 CWD 事件")
				}
			}
		})
	}
	// D 后面跟非数字：仍然发 prompt done，但退出码是 nil
	_, ev := feed("\x1b]133;D;xyz\x07")
	if len(ev) != 2 {
		t.Fatalf("events = %#v, want prompt+commandEnd", ev)
	}
	if ce, ok := ev[1].(oscparse.CommandEndEvent); !ok || ce.ExitCode != nil {
		t.Fatalf("退出码 = %#v, want nil", ev[1])
	}
}

// UT-osc-7：OSC 0/8/52 等必须原样透传，否则会破坏终端功能。
func TestOSC7_UnrelatedOSCPassedThrough(t *testing.T) {
	cases := []string{
		"\x1b]0;window title\x07",
		"\x1b]2;another title\x1b\\",
		"\x1b]8;;https://example.com\x07link\x1b]8;;\x07",
		"\x1b]52;c;SGVsbG8=\x07",
		"\x1b]10;rgb:ffff/ffff/ffff\x07",
		"\x1b]4;1;rgb:00/00/00\x07",
	}
	for _, c := range cases {
		in := "a" + c + "b"
		out, ev := feed(in)
		if out != in {
			t.Errorf("透传失败:\n got %q\nwant %q", out, in)
		}
		if len(ev) != 0 {
			t.Errorf("%q 不该产生事件", c)
		}
	}
}

// UT-osc-8：ESC ] 后跟无关内容 → 已缓冲的字节必须完整吐出。
func TestOSC8_NeverSwallow(t *testing.T) {
	cases := []string{
		"\x1b]abc\x07",     // 编号不是数字
		"\x1b]99999;x\x07", // 编号超长
		"\x1b]13;x\x07",    // 前缀像 133 但不是
		"\x1b]17011;x\x07", // 前缀像 1701 但不是
		"\x1b[31m",         // CSI，不是 OSC
		"\x1b\x1b]0;t\x07", // 连续 ESC
		"\x1bX",            // ESC 后跟普通字符
	}
	for _, c := range cases {
		in := "before" + c + "after"
		out, _ := feed(in)
		if out != in {
			t.Errorf("吞掉了字节:\n  in %q\n out %q", in, out)
		}
		// 分片下同样不能吞
		for split := 1; split < len(in); split++ {
			if o, _ := feedAll(in, []int{split}); o != in {
				t.Errorf("split=%d 吞掉了字节: %q", split, o)
			}
		}
	}
}

// UT-osc-9：剥离后输出的字节数与"原始字节数 - 被剥离的序列字节数"严格一致。
// out_seq 就是按这个数递增的（AC-2.5）。
func TestOSC9_StrippedByteCountExact(t *testing.T) {
	payload := "\x1b]133;A\x07$ \x1b]133;B\x07"
	stripped := len("\x1b]133;A\x07") + len("\x1b]133;B\x07")
	in := "x" + payload + "y"
	out, _ := feed(in)
	if len(out) != len(in)-stripped {
		t.Fatalf("len(out) = %d, want %d", len(out), len(in)-stripped)
	}
	if out != "x$ y" {
		t.Fatalf("out = %q", out)
	}
}

// 无 OSC 的常见路径不应产生额外分配（零拷贝倾向）。
func TestFeedFastPathZeroAlloc(t *testing.T) {
	p := oscparse.New()
	data := []byte(strings.Repeat("plain terminal output\n", 200))
	p.Feed(data)
	if got := testing.AllocsPerRun(200, func() { p.Feed(data) }); got != 0 {
		t.Fatalf("快路径每次分配 %v 次，want 0", got)
	}
}

// 命令输出里恰好含 133 序列时无法区分 —— 这是 OSC 带内信令的固有问题
// （见 shell-integration.md §6）。这里固定住"会被当成真标记"的现状行为，
// 免得将来有人以为修好了。
func TestKnownLimitation_InBandForgery(t *testing.T) {
	_, ev := feed("cat somefile\x1b]133;D;0\x07")
	if len(ev) == 0 {
		t.Fatal("已知限制的行为变了：输出里的 133 序列现在不再被当成标记 —— " +
			"如果这是有意的，请同步更新 shell-integration.md §6")
	}
}

func eventsEqual(a, b []oscparse.Event) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if !reflect.DeepEqual(a[i], b[i]) {
			return false
		}
	}
	return true
}
