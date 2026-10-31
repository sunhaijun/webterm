package ringbuf_test

import (
	"bytes"
	"fmt"
	"math/rand"
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
	// 2. BaseSeq == HeadSeq - len(保留内容)；4. Slice(BaseSeq) 返回全部保留内容
	all, ok := b.Slice(b.BaseSeq())
	if !ok || b.BaseSeq()+uint64(len(all)) != b.HeadSeq() {
		t.Fatalf("BaseSeq(%d) + len(retained)(%d) != HeadSeq(%d)", b.BaseSeq(), len(all), b.HeadSeq())
	}
	// 3. Slice(HeadSeq()) 返回空且 ok
	d, ok := b.Slice(b.HeadSeq())
	if len(d) != 0 || !ok {
		t.Fatalf("Slice(HeadSeq) = %q/%v, want empty/true", d, ok)
	}
	// 5. 对任意 from ∈ [Base, Head]，len(Slice(from)) == Head - from
	for from := b.BaseSeq(); from <= b.HeadSeq(); from++ {
		d, ok := b.Slice(from)
		if !ok {
			t.Fatalf("Slice(%d) 落在窗口内却报不可续传", from)
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

// UT-ring-2：超容后 Slice(k < BaseSeq) 返回 (nil, false)；Slice(BaseSeq) 返回末尾 capacity 字节。
func TestRing2_OverflowFallsOutOfWindow(t *testing.T) {
	const capacity = 256
	b := ringbuf.New(capacity)
	var stream []byte
	for i := 0; i < 100; i++ {
		chunk := []byte(fmt.Sprintf("%03d\n", i))
		b.Append(chunk)
		stream = append(stream, chunk...)
	}
	if d, ok := b.Slice(0); ok || d != nil {
		t.Fatalf("Slice(0) = %q/%v, want nil/false（已被裁掉 → 调用方改走快照）", d, ok)
	}
	d, ok := b.Slice(b.BaseSeq())
	if !ok || len(d) != capacity {
		t.Fatalf("Slice(Base) len = %d ok=%v, want %d/true", len(d), ok, capacity)
	}
	if !bytes.Equal(d, stream[len(stream)-capacity:]) {
		t.Fatal("保留的内容不是流的末尾")
	}
	checkInvariants(t, b, uint64(len(stream)))
}

// 裁剪按字节，刚好够用 —— 不找换行边界（ADR-0026 §3）。
func TestRingTrimIsExact(t *testing.T) {
	b := ringbuf.New(64)
	b.Append(bytes.Repeat([]byte("ab\n"), 20)) // 60 字节
	before := b.BaseSeq()
	b.Append([]byte("xxxxxxxx")) // 8 字节，需要腾 4
	if got := b.BaseSeq() - before; got != 4 {
		t.Fatalf("裁了 %d 字节，want 恰好 4", got)
	}
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

// UT-ring-7：Slice(HeadSeq()) 返回空 + true；Slice(HeadSeq()+1) 返回 (nil, false)。
func TestRing7_ClientAhead(t *testing.T) {
	b := ringbuf.New(64)
	b.Append([]byte("hello"))

	d, ok := b.Slice(b.HeadSeq())
	if d == nil || len(d) != 0 || !ok {
		t.Fatalf("Slice(Head) = %v/%v, want 非 nil 空切片 + true", d, ok)
	}
	d, ok = b.Slice(b.HeadSeq() + 1)
	if d != nil || ok {
		t.Fatalf("Slice(Head+1) = %v/%v, want nil + false（客户端领先 → 快照）", d, ok)
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
				chunk[i] = byte(rng.Intn(256))
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
			if len(retained) > capacity {
				t.Fatalf("iter %d: 保留 %d 字节超过容量 %d", iter, len(retained), capacity)
			}
			if !bytes.Equal(retained, stream[b.BaseSeq():]) {
				t.Fatalf("iter %d step %d: 保留内容与原始流不符", iter, step)
			}
			// 不变式 6 的推论：只要流比容量长，就保留满 capacity 字节（按字节裁剪，不多裁）
			if len(stream) >= capacity && len(retained) != capacity {
				t.Fatalf("iter %d: 流长 %d ≥ 容量 %d，却只保留了 %d 字节", iter, len(stream), capacity, len(retained))
			}
			// 随机切一刀，长度和内容都必须精确
			if h := b.HeadSeq(); h > b.BaseSeq() {
				from := b.BaseSeq() + uint64(rng.Int63n(int64(h-b.BaseSeq())))
				d, ok := b.Slice(from)
				if !ok || uint64(len(d)) != h-from || !bytes.Equal(d, stream[from:]) {
					t.Fatalf("iter %d: Slice(%d) 不精确", iter, from)
				}
			}
			// 已被覆盖的位置必须报不可续传
			if b.BaseSeq() > 0 {
				if d, ok := b.Slice(b.BaseSeq() - 1); ok || d != nil {
					t.Fatalf("iter %d: Slice(Base-1) 应当是 (nil, false)", iter)
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
		want, wok := b.Slice(from)
		got, gok := r.Slice(from)
		if wok != gok || string(want) != string(got) {
			t.Fatalf("Slice(%d) 不一致", from)
		}
	}
	// 恢复之后继续 Append，行为与原缓冲一致（回绕位置不同不能影响语义）
	b.Append([]byte("after"))
	r.Append([]byte("after"))
	bs, _ := b.Slice(b.BaseSeq())
	rs, _ := r.Slice(r.BaseSeq())
	if string(bs) != string(rs) {
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
	got, ok := r.Slice(r.BaseSeq())
	want, _ := b.Slice(b.HeadSeq() - 32)
	if !ok || string(got) != string(want) {
		t.Fatalf("保留的不是末尾 32 字节")
	}
	// 老位置现在落出窗口
	if _, ok := r.Slice(base); ok {
		t.Fatal("裁掉的位置应当报不可续传")
	}
}
