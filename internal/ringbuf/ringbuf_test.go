package ringbuf_test

import (
	"bytes"
	"fmt"
	"math/rand"
	"strings"
	"testing"

	"github.com/sunhaijun/webterm/internal/ringbuf"
)

// checkInvariants 断言 docs/50-backend/ring-buffer.md 的不变式 1–5。
func checkInvariants(t *testing.T, b *ringbuf.Buffer, totalAppended uint64) {
	t.Helper()
	// 1. HeadSeq 永远等于历史上 Append 的字节总数
	if b.HeadSeq() != totalAppended {
		t.Fatalf("HeadSeq = %d, want %d", b.HeadSeq(), totalAppended)
	}
	// 2. BaseSeq == HeadSeq - len(保留内容)
	all, _ := b.Slice(b.BaseSeq())
	if b.BaseSeq()+uint64(len(all)) != b.HeadSeq() {
		t.Fatalf("BaseSeq(%d) + len(retained)(%d) != HeadSeq(%d)", b.BaseSeq(), len(all), b.HeadSeq())
	}
	// 3. Slice(HeadSeq()) 返回空且 StatusOK
	d, st := b.Slice(b.HeadSeq())
	if len(d) != 0 || st != ringbuf.StatusOK {
		t.Fatalf("Slice(HeadSeq) = %q/%v, want empty/OK", d, st)
	}
	// 5. 对任意 from ∈ [Base, Head]，len(Slice(from)) == Head - from
	for from := b.BaseSeq(); from <= b.HeadSeq(); from++ {
		d, st := b.Slice(from)
		if st != ringbuf.StatusOK {
			t.Fatalf("Slice(%d) status = %v, want OK", from, st)
		}
		if uint64(len(d)) != b.HeadSeq()-from {
			t.Fatalf("len(Slice(%d)) = %d, want %d", from, len(d), b.HeadSeq()-from)
		}
	}
}

// UT-ring-1：顺序 Append 后 Slice(k) 对每个 k ∈ [0, Head] 长度都等于 Head-k，
// 且内容正好是原始流的对应尾巴。这是字节级连续性的数学基础。
func TestRing1_SliceLengthAndContent(t *testing.T) {
	b := ringbuf.New(4096)
	var stream []byte
	for i := 0; i < 50; i++ {
		chunk := []byte(fmt.Sprintf("line-%02d\n", i))
		if got := b.Append(chunk); got != uint64(len(stream)) {
			t.Fatalf("Append 返回 seq = %d, want %d", got, len(stream))
		}
		stream = append(stream, chunk...)
	}
	checkInvariants(t, b, uint64(len(stream)))
	for k := uint64(0); k <= b.HeadSeq(); k++ {
		d, _ := b.Slice(k)
		if !bytes.Equal(d, stream[k:]) {
			t.Fatalf("Slice(%d) 内容不匹配", k)
		}
	}
}

// UT-ring-2：超容后 Slice(0) 返回 StatusReset 且内容 == 末尾 capacity 字节。
func TestRing2_OverflowResets(t *testing.T) {
	const capacity = 256
	b := ringbuf.New(capacity)
	var stream []byte
	for i := 0; i < 100; i++ {
		chunk := []byte(fmt.Sprintf("%03d\n", i))
		b.Append(chunk)
		stream = append(stream, chunk...)
	}
	d, st := b.Slice(0)
	if st != ringbuf.StatusReset {
		t.Fatalf("status = %v, want StatusReset", st)
	}
	if len(d) > capacity {
		t.Fatalf("len = %d, 超过容量 %d", len(d), capacity)
	}
	if !bytes.Equal(d, stream[len(stream)-len(d):]) {
		t.Fatal("reset 返回的内容不是流的末尾")
	}
	checkInvariants(t, b, uint64(len(stream)))
}

// UT-ring-3：裁剪优先落在 \n 之后；无换行时硬裁；64 KiB 窗口生效。
func TestRing3_TrimPrefersNewline(t *testing.T) {
	t.Run("落在换行之后", func(t *testing.T) {
		b := ringbuf.New(64)
		b.Append([]byte(strings.Repeat("ab\n", 20))) // 60 字节，8 行边界
		b.Append([]byte("xxxxxxxx"))                 // 8 字节，需要腾 4
		d, _ := b.Slice(b.BaseSeq())
		if len(d) > 0 && d[0] != 'a' {
			t.Fatalf("裁剪起点 = %q，应落在 \\n 之后（'a'）", d[0])
		}
	})
	t.Run("没有换行则硬裁", func(t *testing.T) {
		b := ringbuf.New(64)
		b.Append(bytes.Repeat([]byte("x"), 64))
		before := b.BaseSeq()
		b.Append([]byte("yyyy"))
		if got := b.BaseSeq() - before; got != 4 {
			t.Fatalf("硬裁了 %d 字节，want 恰好 4（不能多裁）", got)
		}
	})
	t.Run("超过 64 KiB 窗口就不再找换行", func(t *testing.T) {
		const capacity = 200 << 10 // 200 KiB
		b := ringbuf.New(capacity)
		// 头部 1 字节，然后 128 KiB 无换行，再一个换行
		b.Append([]byte("\n"))
		b.Append(bytes.Repeat([]byte("x"), 128<<10))
		b.Append([]byte("\n"))
		b.Append(bytes.Repeat([]byte("y"), capacity-(128<<10)-2))
		// 缓冲已满；再写 1 字节需要腾 1 字节。最近的换行在 129 KiB 之外，
		// 超出扫描窗口 → 必须硬裁 1 字节，而不是扫穿整个缓冲。
		before := b.BaseSeq()
		b.Append([]byte("z"))
		if got := b.BaseSeq() - before; got != 1 {
			t.Fatalf("裁了 %d 字节，want 1（窗口外的换行不该被采用）", got)
		}
	})
}

// UT-ring-5：环绕（start + n > capacity）时 Slice 拼接正确。
func TestRing5_WrapAround(t *testing.T) {
	b := ringbuf.New(16)
	b.Append([]byte("0123456789")) // 10
	b.Append([]byte("ABCDEFGHIJ")) // 又 10，触发裁剪与环绕
	all, _ := b.Slice(b.BaseSeq())
	if len(all) != 16 {
		t.Fatalf("保留 %d 字节，want 16", len(all))
	}
	if !bytes.Equal(all, []byte("456789ABCDEFGHIJ")) {
		t.Fatalf("环绕后内容 = %q", all)
	}
	checkInvariants(t, b, 20)
}

// UT-ring-6：单次 Append 超过 capacity —— 只留末尾，HeadSeq 加满。
func TestRing6_SingleAppendExceedsCapacity(t *testing.T) {
	b := ringbuf.New(8)
	seq := b.Append([]byte("0123456789ABCDEF")) // 16 字节进 8 字节的缓冲
	if seq != 0 {
		t.Fatalf("首段 seq = %d, want 0", seq)
	}
	if b.HeadSeq() != 16 {
		t.Fatalf("HeadSeq = %d, want 16（必须加满整个长度）", b.HeadSeq())
	}
	if b.BaseSeq() != 8 {
		t.Fatalf("BaseSeq = %d, want 8", b.BaseSeq())
	}
	d, _ := b.Slice(8)
	if string(d) != "89ABCDEF" {
		t.Fatalf("保留内容 = %q, want %q", d, "89ABCDEF")
	}
	checkInvariants(t, b, 16)
}

// UT-ring-7：Slice(HeadSeq()) 返回空 + OK；Slice(HeadSeq()+1) 返回 nil + OK。
func TestRing7_ClientAhead(t *testing.T) {
	b := ringbuf.New(64)
	b.Append([]byte("hello"))

	d, st := b.Slice(b.HeadSeq())
	if d == nil || len(d) != 0 || st != ringbuf.StatusOK {
		t.Fatalf("Slice(Head) = %v/%v, want 非 nil 空切片 + OK", d, st)
	}
	d, st = b.Slice(b.HeadSeq() + 1)
	if d != nil || st != ringbuf.StatusOK {
		t.Fatalf("Slice(Head+1) = %v/%v, want nil + OK（客户端领先，不回放）", d, st)
	}
}

// UT-ring-8：模糊测试 —— 随机 Append/Slice 序列，断言不变式始终成立。
// 环形缓冲的 bug 几乎都在边界情况，随机化比手写用例更可能撞到。
func TestRing8_Fuzz(t *testing.T) {
	rng := rand.New(rand.NewSource(20260906))
	for iter := 0; iter < 200; iter++ {
		capacity := 1 + rng.Intn(512)
		b := ringbuf.New(capacity)
		var stream []byte
		for step := 0; step < 60; step++ {
			n := rng.Intn(capacity*2 + 4)
			chunk := make([]byte, n)
			for i := range chunk {
				if rng.Intn(8) == 0 {
					chunk[i] = '\n'
				} else {
					chunk[i] = byte('a' + rng.Intn(26))
				}
			}
			seq := b.Append(chunk)
			if seq != uint64(len(stream)) {
				t.Fatalf("iter %d step %d: Append seq = %d, want %d", iter, step, seq, len(stream))
			}
			stream = append(stream, chunk...)

			if b.HeadSeq() != uint64(len(stream)) {
				t.Fatalf("iter %d: HeadSeq = %d, want %d", iter, b.HeadSeq(), len(stream))
			}
			retained, _ := b.Slice(b.BaseSeq())
			if b.BaseSeq()+uint64(len(retained)) != b.HeadSeq() {
				t.Fatalf("iter %d: BaseSeq + len != HeadSeq", iter)
			}
			if !bytes.Equal(retained, stream[b.BaseSeq():]) {
				t.Fatalf("iter %d step %d: 保留内容与原始流不符", iter, step)
			}
			// 随机切一刀，长度和内容都必须精确
			if h := b.HeadSeq(); h > b.BaseSeq() {
				from := b.BaseSeq() + uint64(rng.Int63n(int64(h-b.BaseSeq())))
				d, st := b.Slice(from)
				if st != ringbuf.StatusOK || uint64(len(d)) != h-from || !bytes.Equal(d, stream[from:]) {
					t.Fatalf("iter %d: Slice(%d) 不精确", iter, from)
				}
			}
			// 已被覆盖的位置必须报 reset
			if b.BaseSeq() > 0 {
				if _, st := b.Slice(b.BaseSeq() - 1); st != ringbuf.StatusReset {
					t.Fatalf("iter %d: Slice(Base-1) 应当是 StatusReset", iter)
				}
			}
		}
	}
}

// UT-ring-9：Append 在稳态下零分配（热路径）。
func TestRing9_AppendZeroAlloc(t *testing.T) {
	b := ringbuf.New(1 << 20)
	chunk := bytes.Repeat([]byte("x"), 4096)
	b.Append(chunk) // 预热
	if got := testing.AllocsPerRun(200, func() { b.Append(chunk) }); got != 0 {
		t.Fatalf("Append 每次分配 %v 次，want 0", got)
	}
}

// UT-ring-4：SGR reset 前缀只在 StatusReset 时产生，且不影响 seq 记账。
//
// 这是最容易写错、后果又最严重的一条：注多了 AC-2.1 会偶发失败，
// 计进 seq 则两侧永久错开 4 字节，之后所有续传都错位。
func TestRing4_AttrPrefixOnlyOnReset(t *testing.T) {
	const capacity = 64
	b := ringbuf.New(capacity)
	b.Append([]byte(strings.Repeat("hello\n", 8))) // 48 字节，未溢出

	t.Run("增量续传不前置", func(t *testing.T) {
		for from := b.BaseSeq(); from <= b.HeadSeq(); from++ {
			data, attrPrefix, st := b.Replay(from)
			if st != ringbuf.StatusOK {
				t.Fatalf("Replay(%d) status = %v, want OK", from, st)
			}
			if attrPrefix {
				t.Fatalf("Replay(%d) 前置了 ESC[0m —— 增量续传绝不能注入", from)
			}
			if uint64(len(data)) != b.HeadSeq()-from {
				t.Fatalf("Replay(%d) 长度 = %d, want %d", from, len(data), b.HeadSeq()-from)
			}
		}
	})

	t.Run("reset 才前置", func(t *testing.T) {
		b.Append([]byte(strings.Repeat("world\n", 8))) // 溢出，头部被裁
		if b.BaseSeq() == 0 {
			t.Fatal("测试前提不成立：缓冲没有发生裁剪")
		}
		data, attrPrefix, st := b.Replay(0)
		if st != ringbuf.StatusReset || !attrPrefix {
			t.Fatalf("Replay(0) = %v/%v, want StatusReset/true", st, attrPrefix)
		}
		// 前置的 4 个字节不进缓冲、不进 seq：HeadSeq 与保留内容长度都不受影响
		if b.BaseSeq()+uint64(len(data)) != b.HeadSeq() {
			t.Fatal("属性修正影响了 seq 记账")
		}
	})

	t.Run("Replay 不改变任何 seq", func(t *testing.T) {
		head, base := b.HeadSeq(), b.BaseSeq()
		for i := 0; i < 5; i++ {
			b.Replay(0)
			b.Replay(head)
		}
		if b.HeadSeq() != head || b.BaseSeq() != base {
			t.Fatal("Replay 有副作用")
		}
	})
}

// UT-ring-10：导出 / 恢复往返（ADR-0016 热升级交接）。
//
// 环形缓冲交接到新进程之后，序号与内容必须一个字节都不差 —— 否则客户端
// 重连时按 out_seq 切片就会错位，AC-2.1 在跨进程这一步被破坏。
func TestExportRestoreRoundTrip(t *testing.T) {
	b := ringbuf.New(64)
	// 写到回绕、裁剪都发生过
	for i := 0; i < 30; i++ {
		b.Append([]byte("line-" + string(rune('a'+i%26)) + "\n"))
	}
	base, data := b.Export()
	if base != b.BaseSeq() || uint64(len(data)) != b.HeadSeq()-b.BaseSeq() {
		t.Fatalf("Export 自相矛盾: base=%d BaseSeq=%d len=%d span=%d", base, b.BaseSeq(), len(data), b.HeadSeq()-b.BaseSeq())
	}
	r := ringbuf.Restore(64, base, data)
	if r.BaseSeq() != b.BaseSeq() || r.HeadSeq() != b.HeadSeq() {
		t.Fatalf("序号变了: base %d→%d head %d→%d", b.BaseSeq(), r.BaseSeq(), b.HeadSeq(), r.HeadSeq())
	}
	for from := b.BaseSeq(); from <= b.HeadSeq(); from++ {
		want, ws := b.Slice(from)
		got, gs := r.Slice(from)
		if ws != gs || string(want) != string(got) {
			t.Fatalf("Slice(%d) 不一致", from)
		}
	}
	// 恢复之后继续 Append，行为与原缓冲一致（回绕位置不同不能影响语义）
	b.Append([]byte("after"))
	r.Append([]byte("after"))
	if bs, _ := b.Slice(b.BaseSeq()); string(bs) != func() string { rs, _ := r.Slice(r.BaseSeq()); return string(rs) }() {
		t.Fatal("恢复后继续写入的结果不一致")
	}
}

// 升级时 --ring-bytes 改小：只保留末尾，HeadSeq 不变，base 前移。
func TestRestoreIntoSmallerCapacity(t *testing.T) {
	b := ringbuf.New(128)
	for i := 0; i < 10; i++ {
		b.Append([]byte("0123456789"))
	}
	base, data := b.Export()
	r := ringbuf.Restore(32, base, data)
	if r.HeadSeq() != b.HeadSeq() {
		t.Fatalf("HeadSeq 变了: %d → %d", b.HeadSeq(), r.HeadSeq())
	}
	if r.BaseSeq() != b.HeadSeq()-32 {
		t.Fatalf("base 应前移到 head-32=%d，实际 %d", b.HeadSeq()-32, r.BaseSeq())
	}
	got, st := r.Slice(r.BaseSeq())
	want, _ := b.Slice(b.HeadSeq() - 32)
	if st != ringbuf.StatusOK || string(got) != string(want) {
		t.Fatalf("保留的不是末尾 32 字节")
	}
	// 老位置现在要走 reset
	if _, st := r.Slice(base); st != ringbuf.StatusReset {
		t.Fatal("裁掉的位置应当判 reset")
	}
}
