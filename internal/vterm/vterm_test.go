package vterm

import (
	"bytes"
	"encoding/json"
	"flag"
	"math/rand"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"

	"tuios.dev/vt/snapshot"
)

// update 重新生成快照金样：go test ./internal/vterm -update（或 UPDATE_GOLDEN=1）。
//
// 金样是给前端的裁判用的（AC-2.21）：Vitest 用 @xterm/headless 比较「xterm 直接吃
// 原始字节」与「xterm 先吃这里的快照、再吃截断点之后的字节」，逐格必须一致。
// Go 这边负责两件事：快照是【确定性】的（同一输入逐字节相同），以及模拟器自洽。
var update = flag.Bool("update", false, "重新生成 testdata/snap 下的快照金样")

func updating() bool { return *update || os.Getenv("UPDATE_GOLDEN") == "1" }

const (
	recDir  = "testdata/rec"
	snapDir = "testdata/snap"
)

// recording 是一段真实程序的原始输出（已脱敏，不要改）。
type recording struct {
	name       string
	data       []byte
	cols, rows int
}

func loadRecordings(t *testing.T) []recording {
	t.Helper()
	bins, err := filepath.Glob(filepath.Join(recDir, "*.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if len(bins) == 0 {
		t.Fatal("testdata/rec 下没有录制夹具")
	}
	sort.Strings(bins)
	out := make([]recording, 0, len(bins))
	for _, bin := range bins {
		name := strings.TrimSuffix(filepath.Base(bin), ".bin")
		data, err := os.ReadFile(bin)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := os.ReadFile(strings.TrimSuffix(bin, ".bin") + ".json")
		if err != nil {
			t.Fatal(err)
		}
		var meta struct {
			Cols  int `json:"cols"`
			Rows  int `json:"rows"`
			Bytes int `json:"bytes"`
		}
		if err := json.Unmarshal(raw, &meta); err != nil {
			t.Fatalf("%s.json: %v", name, err)
		}
		if meta.Cols <= 0 || meta.Rows <= 0 {
			t.Fatalf("%s.json 缺 cols/rows", name)
		}
		if meta.Bytes != 0 && meta.Bytes != len(data) {
			t.Fatalf("%s.bin 有 %d 字节，json 说是 %d —— 夹具被改过？", name, len(data), meta.Bytes)
		}
		out = append(out, recording{name: name, data: data, cols: meta.Cols, rows: meta.Rows})
	}
	return out
}

// cutPoints 是一段录制的截断点：12 个等分点 + 10 个确定性随机点 + 末尾，去重升序。
//
// 随机点故意不对齐任何边界 —— 一部分会切在转义序列、多字节字符的中间，那正是
// 快照要带上"解析到一半的序列"的理由。种子由名字长度与总长决定，任何人重跑都
// 得到同一组点。
func cutPoints(name string, n int) []int {
	pts := make([]int, 0, 23)
	for i := 1; i <= 12; i++ {
		pts = append(pts, n*i/13)
	}
	r := rand.New(rand.NewSource(int64(len(name)*7919 + n)))
	for range 10 {
		pts = append(pts, 1+r.Intn(n-1)) // [1, n-1]
	}
	pts = append(pts, n)
	sort.Ints(pts)
	return slices.Compact(pts)
}

// cutEntry 是 cuts.json 的一项：k 是截断点（录制里的字节偏移），snap_bytes 是
// 快照文件长度。前端拿 <name>.<k>.snap 当快照、rec/<name>.bin[k:] 当之后的流。
type cutEntry struct {
	K         int `json:"k"`
	SnapBytes int `json:"snap_bytes"`
}

func snapPath(name string, k int) string {
	return filepath.Join(snapDir, name+"."+strconv.Itoa(k)+".snap")
}

// generate 跑一遍全部录制，返回 文件名 → 内容（含 cuts.json）。
func generate(t *testing.T, recs []recording) map[string][]byte {
	t.Helper()
	files := map[string][]byte{}
	cuts := map[string][]cutEntry{}
	for _, rec := range recs {
		for _, k := range cutPoints(rec.name, len(rec.data)) {
			term := New(rec.cols, rec.rows)
			term.Write(rec.data[:k])
			snap := term.Snapshot()
			files[snapPath(rec.name, k)] = snap
			cuts[rec.name] = append(cuts[rec.name], cutEntry{K: k, SnapBytes: len(snap)})
		}
	}
	idx, err := json.MarshalIndent(cuts, "", "  ") // map 键有序：输出确定
	if err != nil {
		t.Fatal(err)
	}
	files[filepath.Join(snapDir, "cuts.json")] = append(idx, '\n')
	return files
}

// TestSnapshotGolden：快照金样。不带 -update 时校验重新生成的结果与仓库里的
// 文件逐字节相同 —— 也就是快照是确定性的，且没人悄悄改了模拟器版本。
func TestSnapshotGolden(t *testing.T) {
	recs := loadRecordings(t)
	files := generate(t, recs)

	if updating() {
		if err := os.RemoveAll(snapDir); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(snapDir, 0o755); err != nil {
			t.Fatal(err)
		}
		for p, b := range files {
			if err := os.WriteFile(p, b, 0o644); err != nil {
				t.Fatal(err)
			}
		}
		t.Logf("重新生成了 %d 个金样文件", len(files))
		return
	}

	for p, want := range files {
		got, err := os.ReadFile(p)
		if err != nil {
			t.Errorf("缺金样 %s（go test ./internal/vterm -update 生成）: %v", p, err)
			continue
		}
		if !bytes.Equal(got, want) {
			t.Errorf("%s 与重新生成的结果不同（%d vs %d 字节）—— 快照不确定，或模拟器行为变了", p, len(got), len(want))
		}
	}
	// 多出来的文件也是错：前端会拿它们当裁判
	on, err := filepath.Glob(filepath.Join(snapDir, "*"))
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range on {
		if _, ok := files[p]; !ok {
			t.Errorf("多余的金样 %s（-update 会清掉）", p)
		}
	}
}

// TestSnapshotIsDeterministic：同一输入生成两次，逐字节相同。金样校验的前提。
func TestSnapshotIsDeterministic(t *testing.T) {
	for _, rec := range loadRecordings(t) {
		a, b := New(rec.cols, rec.rows), New(rec.cols, rec.rows)
		a.Write(rec.data)
		b.Write(rec.data)
		if !bytes.Equal(a.Snapshot(), b.Snapshot()) {
			t.Errorf("%s：同一输入两次快照不同", rec.name)
		}
	}
}

// TestSnapshotSelfConsistent：模拟器 A 吃全部字节；模拟器 B 先吃 k 处的快照、
// 再吃 k 之后的字节。两者的屏幕与快照必须一致 —— 这是快照路径"能接上"的 Go 侧证明。
// 屏幕级的最终裁判是浏览器的 xterm（前端 Vitest 跑同一批金样）。
func TestSnapshotSelfConsistent(t *testing.T) {
	for _, rec := range loadRecordings(t) {
		t.Run(rec.name, func(t *testing.T) {
			full := New(rec.cols, rec.rows)
			full.Write(rec.data)
			wantScreen, wantSnap := full.String(), full.Snapshot()

			for _, k := range cutPoints(rec.name, len(rec.data)) {
				src := New(rec.cols, rec.rows)
				src.Write(rec.data[:k])

				b := New(rec.cols, rec.rows)
				b.Write(src.Snapshot())
				b.Write(rec.data[k:])
				if got := b.String(); got != wantScreen {
					t.Errorf("k=%d：快照 + 剩余字节的屏幕与直接吃全部字节不同\n直接:\n%s\n快照:\n%s", k, wantScreen, got)
					continue
				}
				if !bytes.Equal(b.Snapshot(), wantSnap) {
					t.Errorf("k=%d：屏幕相同但状态不同（模式 / 画笔 / 历史）", k)
				}
			}
		})
	}
}

// TestExportImportRoundTrip：热升级交接的那一半（ADR-0026 §8）。导入后的快照与
// 导出前逐字节相等，且之后的输出照常接得上。
func TestExportImportRoundTrip(t *testing.T) {
	for _, rec := range loadRecordings(t) {
		t.Run(rec.name, func(t *testing.T) {
			for _, k := range cutPoints(rec.name, len(rec.data)) {
				a := New(rec.cols, rec.rows)
				a.Write(rec.data[:k])
				state, err := a.Export()
				if err != nil {
					t.Fatal(err)
				}
				b, err := Import(state)
				if err != nil {
					t.Fatalf("k=%d: %v", k, err)
				}
				if !bytes.Equal(a.Snapshot(), b.Snapshot()) {
					t.Fatalf("k=%d：导入后的快照与导出前不同", k)
				}
				a.Write(rec.data[k:])
				b.Write(rec.data[k:])
				if !bytes.Equal(a.Snapshot(), b.Snapshot()) {
					t.Fatalf("k=%d：导入之后再吃同样的字节，结果分歧", k)
				}
			}
		})
	}
}

func TestImportRejectsGarbage(t *testing.T) {
	for _, in := range [][]byte{nil, []byte("{"), []byte(`{"width":0,"height":0}`)} {
		if _, err := Import(in); err == nil {
			t.Errorf("Import(%q) 应当失败", in)
		}
	}
}

// 历史上限是 HistoryLines：存多了也发不出去。
func TestHistoryBounded(t *testing.T) {
	term := New(20, 5)
	var b bytes.Buffer
	for i := range HistoryLines + 500 {
		b.WriteString("line ")
		b.WriteString(strconv.Itoa(i))
		b.WriteString("\r\n")
	}
	term.Write(b.Bytes())
	if got := term.HistoryLen(); got != HistoryLines {
		t.Fatalf("历史 %d 行，want %d", got, HistoryLines)
	}
}

// 模拟器自己的查询应答必须丢掉：查询由浏览器回答（ADR-0026 §5）。
// 这里只验证 Write 之后不会有应答积压在里面（DA / CPR / 颜色查询）。
func TestResponsesDiscarded(t *testing.T) {
	term := New(80, 24)
	term.Write([]byte("\x1b[c\x1b[6n\x1b]11;?\x07\x1b[>c"))
	if r := term.t.TakeResponses(); len(r) != 0 {
		t.Fatalf("应答没被丢掉: %q", r)
	}
}

// 改尺寸之后快照按新尺寸画（改列数以 agent 为准，ADR-0026 §4）。
func TestResize(t *testing.T) {
	term := New(80, 24)
	term.Write([]byte("hello"))
	term.Resize(100, 30)
	if c, r := term.Size(); c != 100 || r != 30 {
		t.Fatalf("size = %dx%d", c, r)
	}
	b := New(100, 30)
	b.Write(term.Snapshot())
	if b.String() != term.String() {
		t.Fatal("改尺寸之后的快照画不出同一屏")
	}
	term.Resize(0, 0)
	if c, r := term.Size(); c != 1 || r != 1 {
		t.Fatalf("小于 1 的尺寸应当按 1 算，得到 %dx%d", c, r)
	}
}

// denseWide 是快照的极端输入：宽终端、满历史、每 10 格换一次颜色。
// 400 列不加上限时快照约 1.6 MiB（ADR-0026 §3 的实测）。
func denseWide(cols, lines int) []byte {
	var b bytes.Buffer
	for i := range lines {
		for j := range cols / 10 {
			b.WriteString("\x1b[3" + strconv.Itoa(j%8) + ";4" + strconv.Itoa(7-j%8) + "m")
			s := strconv.Itoa(i)
			b.WriteString(strings.Repeat("0", 9-len(s)) + s + " ")
		}
		b.WriteString("\x1b[0m\r\n")
	}
	return b.Bytes()
}

// 快照上限 1 MiB（协议 §5.2）：超过就按比例少带历史，当前屏与模式不减。
// 画面（当前屏）仍与直接吃全部字节一致，之后的输出照常接得上。
func TestSnapshotCappedAtOneMiB(t *testing.T) {
	const cols, rows = 400, 50
	data := denseWide(cols, HistoryLines+100)
	tail := []byte("\x1b[31mAFTER\x1b[0m tail\r\n")

	full := New(cols, rows)
	full.Write(data)
	if full.HistoryLen() != HistoryLines {
		t.Fatalf("测试前提：历史应当是满的，得到 %d 行", full.HistoryLen())
	}
	if n := len(snapshot.Replay(full.capture(HistoryLines))); n <= MaxSnapshotBytes {
		t.Fatalf("测试前提：不加上限的快照应当超过 1 MiB，只有 %d 字节", n)
	}

	snap := full.Snapshot()
	if len(snap) > MaxSnapshotBytes {
		t.Fatalf("快照 %d 字节，超过上限 %d", len(snap), MaxSnapshotBytes)
	}
	b := New(cols, rows)
	b.Write(snap)
	if b.String() != full.String() {
		t.Fatal("减了历史之后当前屏不一致")
	}
	if b.HistoryLen() == 0 || b.HistoryLen() >= HistoryLines {
		t.Fatalf("历史应当按比例减少而不是全丢或不减，得到 %d 行", b.HistoryLen())
	}
	full.Write(tail)
	b.Write(tail)
	if b.String() != full.String() {
		t.Fatal("快照之后的输出接不上")
	}
}

// 历史全减掉仍超限（当前屏本身就很大）时，不带历史、照常出快照：当前屏不能减。
func TestSnapshotCapNeverDropsScreen(t *testing.T) {
	const cols, rows = 1000, 1000
	term := New(cols, rows)
	term.Write(denseWide(cols, rows+50))
	snap := term.Snapshot()
	b := New(cols, rows)
	b.Write(snap)
	if b.String() != term.String() {
		t.Fatal("当前屏被减了")
	}
}

// UT-name-2（模拟器一侧）：标题与写入次数（ADR-0043 §2）。同样的标题再写一次也计数 ——
// 会话靠次数判断「前台程序设过标题」，新进程设了一模一样的标题也要认得出来。
// 导出 / 导入带着标题，计数从导入后重新开始。
func TestTitleAndWrites(t *testing.T) {
	term := New(80, 24)
	if title, n := term.Title(); title != "" || n != 0 {
		t.Fatalf("新模拟器 = (%q, %d)", title, n)
	}
	term.Write([]byte("\x1b]0;✳ Claude Code\x07"))
	if title, n := term.Title(); title != "✳ Claude Code" || n != 1 {
		t.Fatalf("OSC 0 之后 = (%q, %d)", title, n)
	}
	term.Write([]byte("\x1b]2;✳ Claude Code\x1b\\")) // 同样的标题、OSC 2、ST 结尾
	if title, n := term.Title(); title != "✳ Claude Code" || n != 2 {
		t.Fatalf("再写一次同样的标题 = (%q, %d)，次数要加 1", title, n)
	}
	term.Write([]byte("\x1b]0;◐ Claude"))
	term.Write([]byte(" Code\x07")) // 切在两次写入之间
	if title, n := term.Title(); title != "◐ Claude Code" || n != 3 {
		t.Fatalf("切开的 OSC = (%q, %d)", title, n)
	}
	term.Write([]byte("\x1b]1;icon only\x07")) // 只改图标名，不是标题
	if title, n := term.Title(); title != "◐ Claude Code" || n != 3 {
		t.Fatalf("OSC 1 之后 = (%q, %d)", title, n)
	}

	data, err := term.Export()
	if err != nil {
		t.Fatal(err)
	}
	back, err := Import(data)
	if err != nil {
		t.Fatal(err)
	}
	if title, n := back.Title(); title != "◐ Claude Code" || n != 0 {
		t.Fatalf("导入之后 = (%q, %d)，标题要在、计数从 0 起", title, n)
	}
	back.Write([]byte("\x1b]0;✳ Claude Code\x07"))
	if _, n := back.Title(); n != 1 {
		t.Fatalf("导入之后再写一次，次数 = %d", n)
	}
}
