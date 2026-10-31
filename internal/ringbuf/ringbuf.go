// Package ringbuf 是每会话的输出环形缓冲 —— 增量续传（AC-2.1）的实现基础。
//
// 契约与不变式见 docs/50-backend/ring-buffer.md。最关键的一条：
// 对任意 from ∈ [BaseSeq, HeadSeq]，Slice(from) 的长度必然正好是 HeadSeq-from，
// 不多不少。这是字节级连续性（AC-2.1）的数学基础。
//
// 它只服务增量这一条路（ADR-0026 §3）：落出窗口的客户端一律走模拟器的快照，
// 所以这里按字节裁剪，不找换行边界，也不在回放前插任何东西。
package ringbuf

// Buffer 是单个 []byte + 读写位置的经典环形结构。
// 容量固定，不动态增长；Append 是热路径，稳态零分配。
//
// Buffer 本身不加锁 —— 调用方必须保证 ring 的内容与它的 seq 在同一把锁下更新
// （见 docs/50-backend/session-manager.md 的锁规则）。
type Buffer struct {
	buf   []byte
	start int    // 保留内容在 buf 中的起始下标
	n     int    // 保留内容长度，n <= cap(buf)
	base  uint64 // start 处的 seq
}

// New 创建容量为 capacity 字节的缓冲。capacity 必须为正。
func New(capacity int) *Buffer {
	if capacity <= 0 {
		panic("ringbuf: capacity must be positive")
	}
	return &Buffer{buf: make([]byte, capacity)}
}

// Cap 返回容量。
func (b *Buffer) Cap() int { return len(b.buf) }

// BaseSeq 返回保留内容的起始 seq。
func (b *Buffer) BaseSeq() uint64 { return b.base }

// HeadSeq 返回累计追加的总字节数。裁剪不影响它。
func (b *Buffer) HeadSeq() uint64 { return b.base + uint64(b.n) }

// Append 追加数据，返回本段【首字节】的 seq。空间不足时从头部按字节裁剪。
func (b *Buffer) Append(p []byte) (seq uint64) {
	seq = b.HeadSeq()
	total := len(p)
	if total == 0 {
		return seq
	}
	capacity := len(b.buf)

	// 单次超过容量：只保留末尾 capacity 字节，但 HeadSeq 加满整个长度。
	if total >= capacity {
		copy(b.buf, p[total-capacity:])
		b.start = 0
		b.n = capacity
		b.base = seq + uint64(total-capacity)
		return seq
	}

	if free := capacity - b.n; free < total {
		b.trim(total - free)
	}

	w := b.start + b.n
	if w >= capacity {
		w -= capacity
	}
	k := copy(b.buf[w:], p)
	if k < total {
		copy(b.buf, p[k:])
	}
	b.n += total
	return seq
}

// trim 从头部丢掉正好 need 个字节。
func (b *Buffer) trim(need int) {
	if need >= b.n {
		b.base += uint64(b.n)
		b.start = 0
		b.n = 0
		return
	}
	b.start += need
	if b.start >= len(b.buf) {
		b.start -= len(b.buf)
	}
	b.n -= need
	b.base += uint64(need)
}

// Slice 返回从 from 开始的所有内容。
//
//	from ∈ [BaseSeq, HeadSeq]       → (缺的那一段, true)
//	其余（已被裁掉 / 领先于 head） → (nil, false)   调用方改走快照
//
// 返回的是拷贝，调用方可以自由持有。
func (b *Buffer) Slice(from uint64) (data []byte, ok bool) {
	if from < b.base || from > b.HeadSeq() {
		return nil, false
	}
	off := int(from - b.base)
	return b.copyRange(off, b.n-off), true
}

func (b *Buffer) copyRange(off, length int) []byte {
	out := make([]byte, length)
	if length == 0 {
		return out
	}
	s := b.start + off
	if s >= len(b.buf) {
		s -= len(b.buf)
	}
	k := copy(out, b.buf[s:])
	if k < length {
		copy(out[k:], b.buf)
	}
	return out
}

// Export 导出缓冲的全部保留内容（拷贝）及其起始 seq，供热升级交接（ADR-0016）。
// 与 Slice(BaseSeq()) 等价，单独命名是为了让调用点说清意图。
func (b *Buffer) Export() (base uint64, data []byte) {
	return b.base, b.copyRange(0, b.n)
}

// Restore 用 Export 的结果在新进程里重建缓冲。
//
// 不变式：Restore(capacity, Export()) 之后 BaseSeq / HeadSeq 与导出时完全相等，
// 对任意 from ∈ [base, head]，Slice(from) 逐字节一致 —— 跨进程版的 AC-2.1。
// data 比 capacity 大时只保留末尾 capacity 字节、base 相应前移，HeadSeq 不变
// （与单次 Append 超容量的规则一致）—— 升级时 --ring-bytes 改小了也不会算错序号。
func Restore(capacity int, base uint64, data []byte) *Buffer {
	b := New(capacity)
	if len(data) > capacity {
		base += uint64(len(data) - capacity)
		data = data[len(data)-capacity:]
	}
	copy(b.buf, data)
	b.start = 0
	b.n = len(data)
	b.base = base
	return b
}
