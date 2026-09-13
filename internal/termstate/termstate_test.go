package termstate_test

import (
	"bytes"
	"strings"
	"testing"

	"github.com/sunhaijun/webterm/internal/termstate"
)

// claudeStart 是实测到的 claude 2.1.270 启动序列的形状（ADR-0019 §背景）：
// 进备用屏 + 一串模式开关，之后【整个会话再也不发第二次】。
const claudeStart = "\x1b7\x1b[r\x1b8\x1b[?25h\x1b[?1049h\x1b[2J\x1b[H" +
	"\x1b[<u\x1b[>5u\x1b[>4;2m\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?25l\x1b[?2004h"

// 稳态差分帧：只重画一个字符，绝对定位。窗口里剩下的全是这种东西。
const frame = "\x1b[?25l\x1b[H\r\x1b[23B\x1b[38;5;174m*\x1b[39m\x1b[30;1H\x1b[27;3H\x1b[?25h"

func observe(t *testing.T, chunks ...string) *termstate.Tracker {
	t.Helper()
	tr := termstate.New()
	for _, c := range chunks {
		tr.Observe([]byte(c))
	}
	return tr
}

// UT-termstate-1：备用屏的判定 —— ADR-0019 分流的唯一依据。
func TestAltScreenDetection(t *testing.T) {
	tr := observe(t, claudeStart, frame, frame)
	if !tr.AltScreen() {
		t.Fatal("认不出备用屏 —— 分流会走错，回放的差分帧会被画进主屏")
	}
	tr.Observe([]byte("\x1b[?1049l"))
	if tr.AltScreen() {
		t.Fatal("程序退出备用屏之后仍判为备用屏")
	}
	// 老写法也要认
	for _, s := range []string{"\x1b[?47h", "\x1b[?1047h"} {
		tr := observe(t, s)
		if !tr.AltScreen() {
			t.Fatalf("%q 没被认成备用屏", s)
		}
	}
}

// UT-termstate-2：任意分片。PTY 的一次 Read 可能把序列切在任何一个字节上。
func TestArbitraryFragmentation(t *testing.T) {
	full := claudeStart + frame
	want := observe(t, full).Prelude()

	// 逐字节喂
	byteWise := termstate.New()
	for i := 0; i < len(full); i++ {
		byteWise.Observe([]byte(full[i : i+1]))
	}
	if got := byteWise.Prelude(); !bytes.Equal(got, want) {
		t.Fatalf("逐字节喂的结果不同：\n got %q\nwant %q", got, want)
	}

	// 每种切点都试一遍
	for cut := 1; cut < len(full); cut++ {
		tr := observe(t, full[:cut], full[cut:])
		if got := tr.Prelude(); !bytes.Equal(got, want) {
			t.Fatalf("切在第 %d 字节时结果不同：\n got %q\nwant %q", cut, got, want)
		}
	}
}

// UT-termstate-3：【只读】。观察前后的字节必须逐字节相等（AC-2.19）。
//
// 一旦它改写了字节，ADR-0006 的 out_seq 不变式就破了 —— 那是永久错位。
func TestObserveDoesNotTouchBytes(t *testing.T) {
	in := []byte(claudeStart + frame + "\x1b]0;title\x07plain text\n")
	cp := append([]byte(nil), in...)
	termstate.New().Observe(in)
	if !bytes.Equal(in, cp) {
		t.Fatal("Observe 改写了输入 —— out_seq 记账会永久错开")
	}
}

// UT-termstate-4：字符串类序列（OSC / DCS / APC）的负载必须【整段跳过】。
//
// tmux 的 DCS 透传会把别人的转义序列原样包在负载里。把它当真，会认下一个
// 根本没有生效的模式。
func TestStringPayloadIsSkipped(t *testing.T) {
	cases := []string{
		"\x1b]0;\x1b[?1049h\x07",       // OSC 标题里嵌了一个假开关，BEL 终止
		"\x1bP tmux;\x1b[?1049h\x1b\\", // DCS 透传，ST 终止
		"\x1b_\x1b[?1049h\x1b\\",       // APC
		"\x1b^\x1b[?1049h\x1b\\",       // PM
	}
	for _, c := range cases {
		if observe(t, c).AltScreen() {
			t.Fatalf("%q：把字符串负载里的开关当真了", c)
		}
	}
	// 负载结束之后的真开关要认得出来
	tr := observe(t, "\x1b]0;title\x07\x1b[?1049h")
	if !tr.AltScreen() {
		t.Fatal("OSC 结束之后的真开关没认出来")
	}
}

// UT-termstate-5：畸形与超长输入不崩、不误判。
func TestMalformedInput(t *testing.T) {
	long := "\x1b[?" + strings.Repeat("1;", 200) + "1049h" // 参数超限 → 整条作废
	cases := []string{
		"\x1b[",              // 半截
		"\x1b[?",             // 半截
		"\x1b[?1049",         // 没有终结符
		"\x1b[?abc h",        // 非法参数
		"\x1b[?1049\x03h",    // 中间插控制字符
		"\x1b\x1b\x1b[?1049", // 连续 ESC
		long,
	}
	for _, c := range cases {
		tr := observe(t, c)
		if tr.AltScreen() {
			t.Fatalf("%q 被误判成备用屏", c)
		}
		_ = tr.Prelude() // 不能 panic
	}
	// 半截序列之后接上完整的，仍要认得出
	tr := observe(t, "\x1b[?1049", "h")
	if !tr.AltScreen() {
		t.Fatal("跨分片的完整序列没认出来")
	}
}

// UT-termstate-6：2026（同步输出）【绝不恢复】。
//
// 它是单帧的包裹（开 → 画 → 关），不是粘性状态。恢复成"开"会让客户端的
// 渲染器一直等那个永远不会来的"关"。
func TestSyncOutputNeverRestored(t *testing.T) {
	tr := observe(t, "\x1b[?1049h\x1b[?2026h") // 开了同步输出就断在这儿
	if bytes.Contains(tr.Prelude(), []byte("2026")) {
		t.Fatal("前缀里恢复了 2026 —— 客户端会卡在等一个不会来的帧结束")
	}
}

// UT-termstate-7：前缀内容。确定、可读、只含自己拼的开关。
func TestPrelude(t *testing.T) {
	tr := observe(t, claudeStart)
	got := string(tr.Prelude())

	for _, want := range []string{
		"\x1b[0m", "\x1b(B", // 干净底图
		"\x1b[?1049h",                // 备用屏必须在
		"\x1b[?1000h", "\x1b[?1006h", // 鼠标
		"\x1b[?2004h", // 括号粘贴
		"\x1b[?25l",   // 光标被藏起来了
		"\x1b[>5u",    // Kitty 栈顶
		"\x1b[>4;2m",  // modifyOtherKeys
	} {
		if !strings.Contains(got, want) {
			t.Errorf("前缀里缺 %q：\n%q", want, got)
		}
	}
	// 备用屏开关必须排在其它模式前面
	if i, j := strings.Index(got, "?1049h"), strings.Index(got, "?1000h"); i > j {
		t.Error("?1049h 排在了其它模式后面")
	}
	// 两次取值必须一样（确定性）
	if got2 := string(tr.Prelude()); got != got2 {
		t.Error("Prelude 不确定")
	}
	// 初始状态的前缀只有干净底图
	if s := string(termstate.New().Prelude()); s != "\x1b[0m\x1b(B" {
		t.Errorf("初始前缀 = %q", s)
	}
}

// UT-termstate-8：Kitty 键盘协议的压栈 / 出栈。claude 靠它区分 Shift+Enter 之类。
func TestKittyStack(t *testing.T) {
	tr := observe(t, "\x1b[>1u\x1b[>5u")
	if !strings.Contains(string(tr.Prelude()), "\x1b[>5u") {
		t.Fatal("恢复的不是栈顶")
	}
	tr.Observe([]byte("\x1b[<u")) // 弹一层
	if !strings.Contains(string(tr.Prelude()), "\x1b[>1u") {
		t.Fatal("出栈之后恢复的不是新栈顶")
	}
	tr.Observe([]byte("\x1b[<u")) // 弹空
	if strings.Contains(string(tr.Prelude()), ">1u") || strings.Contains(string(tr.Prelude()), ">5u") {
		t.Fatal("栈空了还在恢复")
	}
	tr.Observe([]byte("\x1b[<9u")) // 空栈上多弹几次，不能越界
	_ = tr.Prelude()
}

// UT-termstate-9：滚动区（DECSTBM）—— less / vim 会设，不恢复的话重画会串行。
func TestScrollRegion(t *testing.T) {
	tr := observe(t, "\x1b[2;40r")
	if !strings.Contains(string(tr.Prelude()), "\x1b[2;40r") {
		t.Fatal("滚动区没恢复")
	}
	tr.Observe([]byte("\x1b[r")) // 复位成整屏
	if strings.Contains(string(tr.Prelude()), ";40r") {
		t.Fatal("滚动区复位之后还在恢复旧值")
	}
}

// UT-termstate-10：交接往返（AC-2.19）。
//
// 【含解析器断点】：CSI 可能被 PTY 的一次 Read 切成两半，交接必须带上，
// 否则新进程会把后半截当成普通文本，模式就丢了。
func TestExportRestore(t *testing.T) {
	full := claudeStart + frame
	for cut := 1; cut < len(full); cut++ {
		src := observe(t, full[:cut])
		dst := termstate.Restore(src.Export())
		// 剩下的字节喂给恢复出来的那个
		src.Observe([]byte(full[cut:]))
		dst.Observe([]byte(full[cut:]))
		if !bytes.Equal(src.Prelude(), dst.Prelude()) {
			t.Fatalf("在第 %d 字节交接之后两边不一致：\n src %q\n dst %q",
				cut, src.Prelude(), dst.Prelude())
		}
		if src.AltScreen() != dst.AltScreen() {
			t.Fatalf("在第 %d 字节交接之后备用屏判定不一致", cut)
		}
	}
}

// 快照必须是深拷贝：导出之后再观察，不能改到已经拍好的那份。
func TestExportIsSnapshot(t *testing.T) {
	tr := observe(t, "\x1b[?1000h\x1b[>5u")
	snap := tr.Export()
	tr.Observe([]byte("\x1b[?1002h\x1b[>7u"))
	if len(snap.Mouse) != 1 || len(snap.KittyStack) != 1 {
		t.Fatalf("快照被后续观察改动了：%+v", snap)
	}
}
