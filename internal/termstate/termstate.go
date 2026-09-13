// Package termstate 跟踪一条终端输出流里的【粘性模式】—— 那些"设一次、长期
// 有效"的开关：备用屏、应用光标键、鼠标跟踪、括号粘贴、Kitty 键盘协议、滚动区。
//
// 它【只读】。喂进来的字节原样进环形缓冲，一个字节都不改 —— 一旦改写，
// ADR-0006 的 out_seq 不变式就破了。
//
// 为什么需要它：这些开关在一次会话里通常【只出现一次】（实测 claude 2.x 全程
// 只发一个 ESC[?1049h，在启动的头 20 个字节里）。环形缓冲是字节窗口，窗口一滑
// 过去，"当时设了什么模式"就再也拿不回来，而窗口里剩下的差分帧全都依赖它。
// 契约与跟踪表见 docs/20-architecture/adr/0019-altscreen-redraw-not-replay.md。
package termstate

import "strconv"

const esc = 0x1b

// maxParams 是 CSI 参数缓冲的上限。超了就放弃这个序列（继续扫到终结符为止），
// 防止畸形输入把内存撑大。正常序列远短于这个数。
const maxParams = 64

// 解析状态。只认三件事：CSI（我们关心的全在这儿）、字符串类序列（OSC/DCS/…，
// 【必须整段跳过】）、其余一律回到 ground。
type parseState int

const (
	stGround parseState = iota
	stEsc
	stCSI
	stStr    // OSC / DCS / APC / PM / SOS 的负载，扫到 ST 或 BEL
	stStrEsc // 负载里见到 ESC，可能是 ST
)

// State 是可序列化的快照，用于热升级交接（ADR-0016）。
//
// 【必须交接】：它推导不出来 —— 模式开关早被环形缓冲裁掉了，这正是 ADR-0019
// 的起因。丢了它，升级之后备用屏判定就没了。
type State struct {
	Alt          bool  `json:"alt,omitempty"`           // ?1049 备用屏
	AppCursor    bool  `json:"app_cursor,omitempty"`    // ?1 DECCKM
	NoAutoWrap   bool  `json:"no_autowrap,omitempty"`   // ?7 被关掉了（默认开）
	CursorHidden bool  `json:"cursor_hidden,omitempty"` // ?25 被关掉了（默认显示）
	Mouse        []int `json:"mouse,omitempty"`         // ?1000/1002/1003/1006/1015/1016 里开着的
	BracketPaste bool  `json:"bracket_paste,omitempty"` // ?2004
	FocusEvents  bool  `json:"focus_events,omitempty"`  // ?1004
	KittyStack   []int `json:"kitty_stack,omitempty"`   // CSI > flags u 压进去的
	ModifyOther  int   `json:"modify_other,omitempty"`  // CSI > 4 ; n m
	HasModify    bool  `json:"has_modify,omitempty"`    // 区分"设成 0"与"没设过"
	ScrollTop    int   `json:"scroll_top,omitempty"`    // DECSTBM
	ScrollBottom int   `json:"scroll_bottom,omitempty"` // 0 = 没设（整屏）

	// 解析器自身的断点。CSI 可能被 PTY 的一次 Read 切成两半，交接必须带上，
	// 否则新进程会把后半截当成普通文本。
	Parse  int    `json:"parse,omitempty"`
	Params string `json:"params,omitempty"`
}

// mouseModes 是我们认的鼠标相关 DECSET 编号。其余私有模式一律不跟踪。
var mouseModes = [...]int{1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016}

// Tracker 是流式观察器。零值不可用，用 New。
type Tracker struct {
	st      State
	state   parseState
	params  []byte
	tooLong bool // 参数超限，这个序列作废
}

// New 建一个初始状态的观察器（对应一个刚开的终端：主屏、自动折行、光标可见）。
func New() *Tracker { return &Tracker{params: make([]byte, 0, 16)} }

// Restore 从交接快照重建。
func Restore(s State) *Tracker {
	t := New()
	t.st = s
	t.state = parseState(s.Parse)
	t.params = append(t.params[:0], s.Params...)
	t.st.Parse, t.st.Params = 0, "" // 快照字段不参与运行时判断
	return t
}

// Export 拍一份快照。
func (t *Tracker) Export() State {
	s := t.st
	s.Mouse = append([]int(nil), t.st.Mouse...)
	s.KittyStack = append([]int(nil), t.st.KittyStack...)
	s.Parse = int(t.state)
	s.Params = string(t.params)
	return s
}

// AltScreen 报告会话当前是否在备用屏。
//
// 这是 ADR-0019 分流的唯一判据：在备用屏就别回放字节窗口了，那些差分帧离开
// ESC[?1049h 没有意义。
func (t *Tracker) AltScreen() bool { return t.st.Alt }

// Observe 喂一段输出。可以是任意分片 —— 序列被切在任何一个字节上都要能接住。
//
// 【不改动 p，也不持有它】。
func (t *Tracker) Observe(p []byte) {
	for _, b := range p {
		switch t.state {
		case stGround:
			if b == esc {
				t.state = stEsc
			}

		case stEsc:
			switch {
			case b == '[':
				t.state = stCSI
				t.params = t.params[:0]
				t.tooLong = false
			case b == ']' || b == 'P' || b == '^' || b == '_' || b == 'X':
				// OSC / DCS / PM / APC / SOS：负载里可能【原样嵌着别的转义序列】
				// （tmux 的 DCS 透传就是这样）。必须整段跳过，否则会把人家的
				// 负载当成真的模式开关认下来。
				t.state = stStr
			case b == esc:
				// 连续 ESC：保持在 stEsc，等下一个字节
			default:
				t.state = stGround
			}

		case stCSI:
			switch {
			case b >= 0x20 && b <= 0x3f: // 参数与中间字节
				if len(t.params) >= maxParams {
					t.tooLong = true
				} else {
					t.params = append(t.params, b)
				}
			case b >= 0x40 && b <= 0x7e: // 终结符
				if !t.tooLong {
					t.apply(b)
				}
				t.state = stGround
			default:
				// 控制字符打断了序列（终端的做法是执行它然后继续，我们直接放弃）
				t.state = stGround
			}

		case stStr:
			switch b {
			case 0x07: // BEL 终止 OSC
				t.state = stGround
			case esc:
				t.state = stStrEsc
			}

		case stStrEsc:
			// ESC \ = ST，正常终止；其余当作负载里的 ESC，继续扫
			if b == '\\' {
				t.state = stGround
			} else {
				t.state = stStr
			}
		}
	}
}

// apply 处理一个完整的 CSI 序列。final 是终结符，t.params 是它前面的全部字节
// （含私有前缀）。
func (t *Tracker) apply(final byte) {
	if len(t.params) == 0 {
		if final == 'r' {
			t.st.ScrollTop, t.st.ScrollBottom = 0, 0 // DECSTBM 复位成整屏
		}
		return
	}
	prefix := t.params[0]
	switch {
	case prefix == '?' && (final == 'h' || final == 'l'):
		on := final == 'h'
		for _, n := range parseInts(t.params[1:]) {
			t.setMode(n, on)
		}

	case prefix == '>' && final == 'u': // Kitty 键盘协议入栈
		flags := 0
		if v := parseInts(t.params[1:]); len(v) > 0 {
			flags = v[0]
		}
		t.st.KittyStack = append(t.st.KittyStack, flags)

	case prefix == '<' && final == 'u': // 出栈
		n := 1
		if v := parseInts(t.params[1:]); len(v) > 0 && v[0] > 0 {
			n = v[0]
		}
		if n > len(t.st.KittyStack) {
			n = len(t.st.KittyStack)
		}
		t.st.KittyStack = t.st.KittyStack[:len(t.st.KittyStack)-n]

	case prefix == '=' && final == 'u': // 直接设置栈顶
		flags := 0
		if v := parseInts(t.params[1:]); len(v) > 0 {
			flags = v[0]
		}
		if len(t.st.KittyStack) == 0 {
			t.st.KittyStack = append(t.st.KittyStack, flags)
		} else {
			t.st.KittyStack[len(t.st.KittyStack)-1] = flags
		}

	case prefix == '>' && final == 'm': // modifyOtherKeys
		v := parseInts(t.params[1:])
		if len(v) >= 2 && v[0] == 4 {
			t.st.ModifyOther, t.st.HasModify = v[1], true
		} else if len(v) == 0 {
			t.st.ModifyOther, t.st.HasModify = 0, false // CSI > m 复位
		}

	case prefix >= '0' && prefix <= '9' && final == 'r': // DECSTBM
		v := parseInts(t.params)
		if len(v) >= 2 {
			t.st.ScrollTop, t.st.ScrollBottom = v[0], v[1]
		}
	}
}

func (t *Tracker) setMode(n int, on bool) {
	switch n {
	case 1049, 1047, 47: // 备用屏的三种写法都认
		t.st.Alt = on
	case 1:
		t.st.AppCursor = on
	case 7:
		t.st.NoAutoWrap = !on
	case 25:
		t.st.CursorHidden = !on
	case 2004:
		t.st.BracketPaste = on
	case 1004:
		t.st.FocusEvents = on
	// 【2026（同步输出）故意不跟踪】。它是单帧的包裹（开→画→关），不是粘性
	// 状态；恢复成"开"会让客户端的渲染器一直等那个永远不来的"关"。
	default:
		for _, m := range mouseModes {
			if m == n {
				t.setMouse(n, on)
				return
			}
		}
	}
}

func (t *Tracker) setMouse(n int, on bool) {
	for i, v := range t.st.Mouse {
		if v == n {
			if !on {
				t.st.Mouse = append(t.st.Mouse[:i], t.st.Mouse[i+1:]...)
			}
			return
		}
	}
	if on {
		t.st.Mouse = append(t.st.Mouse, n)
	}
}

// Prelude 返回把一张白纸恢复成当前模式所需的字节。
//
// 它【不含任何程序输出的原文】，全是这里自己拼出来的开关，几十字节。客户端
// 清屏之后写它，然后等程序自己把内容画上去。这些字节【不计入 out_seq】（协议 §3）。
func (t *Tracker) Prelude() []byte {
	// 干净底图：属性复位 + G0 回 ASCII。内容由程序重画，不需要恢复 SGR/字符集
	out := []byte("\x1b[0m\x1b(B")

	if t.st.Alt {
		out = append(out, "\x1b[?1049h"...)
	}
	if t.st.NoAutoWrap {
		out = append(out, "\x1b[?7l"...)
	}
	if t.st.CursorHidden {
		out = append(out, "\x1b[?25l"...)
	}
	if t.st.AppCursor {
		out = append(out, "\x1b[?1h"...)
	}
	for _, m := range t.st.Mouse {
		out = appendDECSET(out, m, true)
	}
	if t.st.BracketPaste {
		out = append(out, "\x1b[?2004h"...)
	}
	if t.st.FocusEvents {
		out = append(out, "\x1b[?1004h"...)
	}
	if n := len(t.st.KittyStack); n > 0 {
		out = append(out, "\x1b[>"...)
		out = strconv.AppendInt(out, int64(t.st.KittyStack[n-1]), 10)
		out = append(out, 'u')
	}
	if t.st.HasModify {
		out = append(out, "\x1b[>4;"...)
		out = strconv.AppendInt(out, int64(t.st.ModifyOther), 10)
		out = append(out, 'm')
	}
	if t.st.ScrollBottom > 0 {
		out = append(out, "\x1b["...)
		out = strconv.AppendInt(out, int64(t.st.ScrollTop), 10)
		out = append(out, ';')
		out = strconv.AppendInt(out, int64(t.st.ScrollBottom), 10)
		out = append(out, 'r')
	}
	return out
}

func appendDECSET(out []byte, n int, on bool) []byte {
	out = append(out, "\x1b[?"...)
	out = strconv.AppendInt(out, int64(n), 10)
	if on {
		return append(out, 'h')
	}
	return append(out, 'l')
}

// parseInts 把 "1000;1006" 这样的参数串拆成整数。空段按 0 算（终端惯例），
// 子参数分隔符 ':' 一律截断取前半（我们关心的模式号都没有子参数）。
func parseInts(p []byte) []int {
	if len(p) == 0 {
		return nil
	}
	out := make([]int, 0, 4)
	n, has := 0, false
	skip := false
	for _, b := range p {
		switch {
		case b >= '0' && b <= '9':
			if !skip {
				n = n*10 + int(b-'0')
				has = true
			}
		case b == ';':
			out = append(out, n)
			n, has, skip = 0, false, false
		case b == ':':
			skip = true // 子参数，忽略到下一个 ';'
		default:
			// 中间字节等，忽略
		}
	}
	_ = has
	return append(out, n)
}
