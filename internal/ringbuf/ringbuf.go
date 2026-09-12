// Package ringbuf 是每会话的输出环形缓冲 —— "永不断线"这个核心承诺的实现基础。
//
// 契约与不变式见 docs/50-backend/ring-buffer.md。最关键的一条：
// 对任意 from ∈ [BaseSeq, HeadSeq]，Slice(from) 的长度必然正好是 HeadSeq-from，
// 不多不少。这是字节级连续性（AC-2.1）的数学基础。
package ringbuf

// Status 是 Slice 的结果类型。
type Status int

const (
	// StatusOK：可增量续传，返回的就是调用方缺的那段。
	StatusOK Status = iota
	// StatusReset：请求位置已被裁掉，返回缓冲现存的全部内容。
	// 【只有这种情况】才在回放起点前置 ESC[0m（协议 §5.1）。
	StatusReset
)

// scanWindow 是寻找换行边界时向后扫描的上限。
// 防止在一个巨大的无换行输出（比如 cat 一个二进制文件）里无限扫描。
const scanWindow = 64 << 10 // 64 KiB

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

// Append 追加数据，返回本段【首字节】的 seq。
// 空间不足时从头部裁剪（优先在 \n 边界）。
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

// trim 丢弃头部至少 need 个字节，优先落在 \n 之后。
func (b *Buffer) trim(need int) {
	if need >= b.n {
		b.base += uint64(b.n)
		b.start = 0
		b.n = 0
		return
	}
	// 找第一个位置 p >= need 使得 buf[p-1] == '\n'，扫描窗口上限 64 KiB。
	// 在换行之后开始回放，绝大多数情况下不会把转义序列切成两半。
	limit := need + scanWindow
	if limit > b.n {
		limit = b.n
	}
	cut := need
	for p := need; p <= limit; p++ {
		if b.at(p-1) == '\n' {
			cut = p
			break
		}
	}
	b.start += cut
	if b.start >= len(b.buf) {
		b.start -= len(b.buf)
	}
	b.n -= cut
	b.base += uint64(cut)
}

// at 返回保留内容中逻辑下标 i 处的字节。
func (b *Buffer) at(i int) byte {
	j := b.start + i
	if j >= len(b.buf) {
		j -= len(b.buf)
	}
	return b.buf[j]
}

// Slice 返回从 from 开始的所有内容。
//
//	from ∈ [BaseSeq, HeadSeq]  → (缺的那一段, StatusOK)
//	from <  BaseSeq            → (缓冲全部内容, StatusReset)
//	from >  HeadSeq            → (nil, StatusOK)   客户端领先，不回放
//
// 返回的是拷贝，调用方可以自由持有。
func (b *Buffer) Slice(from uint64) ([]byte, Status) {
	head := b.HeadSeq()
	if from > head {
		return nil, StatusOK
	}
	if from < b.base {
		return b.copyRange(0, b.n), StatusReset
	}
	off := int(from - b.base)
	return b.copyRange(off, b.n-off), StatusOK
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

// Replay 返回从 from 开始应当回放给客户端的内容，以及是否需要前置属性修正。
//
// attrPrefix 只在 StatusReset 时为 true —— 那时前面的字节已被裁掉，回放起点
// 可能落在一段颜色/属性设置的中间。增量续传（StatusOK）【绝不能】前置：
// 客户端的终端状态是完整的，注入 SGR reset 会把断点处生效中的属性清掉，
// 让 AC-2.1 的字节级比较在"断点恰好落在着色区间内"时失败。
//
// 把这条规则收在这里，是为了让调用点没有写错的机会。前置的 4 个字节由连接层
// 插入并置 protocol.FlagAttrPrefix，【不计入 seq】。
func (b *Buffer) Replay(from uint64) (data []byte, attrPrefix bool, st Status) {
	data, st = b.Slice(from)
	return data, st == StatusReset, st
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
