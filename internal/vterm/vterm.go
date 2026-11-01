// Package vterm 是每个会话在 agent 侧的终端模拟器（ADR-0026 §1）。
//
// 它包住 tuios.dev/vt（钉死 v0.3.2），会话代码只通过这里的几个方法访问它：
// 写入、改尺寸、生成快照、导出 / 导入状态。将来换实现只动这一个包。
//
// 【不加锁】：调用方必须保证同一时刻只有一个 goroutine 碰它。会话把它和环形
// 缓冲放在同一把锁下更新 —— 于是任何时刻"模拟器吃到了第几个字节"都等于
// head_seq，快照的 seq 就取那一刻的 head_seq（协议 §5.2）。
package vterm

import (
	"encoding/json"
	"errors"
	"fmt"

	"tuios.dev/vt"
	"tuios.dev/vt/snapshot"
)

// HistoryLines 是模拟器保留、快照携带的历史行数。两者一致：存多了也发不出去。
const HistoryLines = 2000

// Terminal 是一个终端模拟器。零值不可用，用 New / Import 构造。
type Terminal struct {
	t *vt.Emulator
	// titleWrites 是 OSC 0 / 2 设标题的次数（同样的标题再设一次也算）。会话靠它判断
	// 「前台程序设过标题」（ADR-0043 §2）。只在 Write 的调用栈里加，和模拟器同一把锁。
	titleWrites uint64
}

// New 建一个 cols × rows、带 HistoryLines 行历史的模拟器。
func New(cols, rows int) *Terminal {
	e := vt.NewEmulator(max(cols, 1), max(rows, 1))
	e.SetScrollbackMaxLines(HistoryLines)
	// kitty 图形上传的应答由浏览器负责（§5），这里一律不答 —— 关掉之后它也
	// 不会为 f / t 介质去 open 服务器上的文件。
	e.SetKittyUploadAnswers(false)
	t := &Terminal{t: e}
	e.SetCallbacks(vt.Callbacks{Title: func(string) { t.titleWrites++ }})
	return t
}

// Title 返回窗口标题（OSC 0 / 2 设的，未清洗）与它被设过几次。导入的模拟器带着
// 导出时的标题，次数从 0 起。
func (t *Terminal) Title() (title string, writes uint64) {
	return t.t.Titles().Title, t.titleWrites
}

// Write 喂 PTY 的原始输出。
//
// 模拟器自己生成的查询应答（DA、CPR、颜色查询 …）【丢掉】：查询的回答者是
// 浏览器里的 xterm.js，能力集与主题色都以它为准（ADR-0026 §5）。让这里代答，
// 程序探测到的就是 tuios 的能力，会改用浏览器不懂的编码。
func (t *Terminal) Write(p []byte) {
	if len(p) == 0 {
		return
	}
	_, _ = t.t.Write(p)
	_ = t.t.TakeResponses()
}

// Resize 改屏幕尺寸。小于 1 的按 1 算。重排以模拟器为准（ADR-0026 §4）。
func (t *Terminal) Resize(cols, rows int) {
	t.t.Resize(max(cols, 1), max(rows, 1))
	_ = t.t.TakeResponses()
}

// Size 返回当前屏幕尺寸。
func (t *Terminal) Size() (cols, rows int) { return t.t.Width(), t.t.Height() }

// MaxSnapshotBytes 是快照的上限（协议 §5.2）。普通内容满 2000 行也只有一两百 KiB；
// 宽终端配上每格换色的极端输出能到数 MiB，会撑爆连接写队列（4 MiB）而断开，
// 重连又要快照，形成死循环。
const MaxSnapshotBytes = 1 << 20

// Snapshot 生成一段任何 xterm 兼容终端都能吃的字节：从清空的终端开始画出
// 至多 HistoryLines 行历史、当前屏、模式、画笔、滚动区域、字符集、制表位、
// 光标，以及解析到一半的序列（放在最后，让之后的输出把它接完）。
//
// 超过 MaxSnapshotBytes 时按比例减少带的历史行数重新生成一次（留 10% 余量）；
// 当前屏与模式不减。重新生成一次就够：大小近似与行数成正比，剩下的超出只可能
// 来自当前屏本身，那部分不能减。
func (t *Terminal) Snapshot() []byte {
	b := snapshot.Replay(t.capture(HistoryLines))
	if len(b) <= MaxSnapshotBytes {
		return b
	}
	carried := min(HistoryLines, t.t.ScrollbackLen())
	lines := int(float64(carried) * float64(MaxSnapshotBytes) / float64(len(b)) * 0.9)
	return snapshot.Replay(t.capture(lines))
}

// capture 读出带至多 lines 行历史的状态。lines ≤ 0 表示不带历史 ——
// snapshot.Capture 的 0 是"默认行数"，不带要传负数。
func (t *Terminal) capture(lines int) *snapshot.State {
	if lines <= 0 {
		lines = -1
	}
	return snapshot.Capture(t.t, t.t.Width(), t.t.Height(), lines, 0)
}

// String 返回当前屏的文字（不带样式），测试与排障用。
func (t *Terminal) String() string { return t.t.String() }

// HistoryLen 返回历史行数。
func (t *Terminal) HistoryLen() int { return t.t.ScrollbackLen() }

// Export 导出完整状态（带满 HistoryLines 行历史），热升级交接用（ADR-0026 §8）。
// 格式不透明，只保证 Import 读得回来。
func (t *Terminal) Export() ([]byte, error) {
	st, finish := snapshot.CapturePacked(t.t, t.t.Width(), t.t.Height(), HistoryLines, 0)
	finish()
	b, err := json.Marshal(st)
	if err != nil {
		return nil, fmt.Errorf("vterm: 编码状态: %w", err)
	}
	return b, nil
}

// Import 用 Export 的结果重建模拟器。导入之后生成的快照与导出前逐字节相等。
func Import(data []byte) (*Terminal, error) {
	if len(data) == 0 {
		return nil, errors.New("vterm: 状态为空")
	}
	var st snapshot.State
	if err := json.Unmarshal(data, &st); err != nil {
		return nil, fmt.Errorf("vterm: 解码状态: %w", err)
	}
	if st.Width <= 0 || st.Height <= 0 {
		return nil, fmt.Errorf("vterm: 状态尺寸非法 %dx%d", st.Width, st.Height)
	}
	t := New(st.Width, st.Height)
	if err := snapshot.Apply(t.t, &st); err != nil {
		return nil, fmt.Errorf("vterm: 导入状态: %w", err)
	}
	_ = t.t.TakeResponses()
	t.titleWrites = 0 // 导入还原的标题不算「程序设的」
	return t, nil
}
