# 环形缓冲

> 状态：Accepted
>
> 增量续传（AC-2.1）的实现基础。`internal/ringbuf`。落出窗口的客户端走快照，不由它负责（[ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md)）。

## 它在整条输出链路里的位置

每个会话的 PTY 输出在**同一把锁里**做两件事：追加进环形缓冲，喂给终端模拟器（`internal/vterm`）。环形缓冲只回答一个问题：「客户端说它到了 `out_seq`，我还能不能把它缺的那段原始字节原样补给它」。能，就是增量续传；不能，就由模拟器出一份快照（[协议 §5.1](../30-protocol/websocket-protocol.md)）。

所以它**不需要**为「回放起点切在哪」操心：缓冲之外的一律走快照，缓冲之内的回放起点永远是客户端自己报上来的 `out_seq` —— 那个位置上客户端的终端状态是完整的。

## 契约

```go
type Buffer struct { … }

// New 创建容量为 capacity 字节的缓冲。默认 256 KiB（--ring-bytes）。
func New(capacity int) *Buffer

// Append 追加数据，返回本段【首字节】的 seq。空间不足时从头部按字节裁剪。
func (b *Buffer) Append(p []byte) (seq uint64)

// Slice 返回从 from 开始的所有内容。
//   from ∈ [BaseSeq, HeadSeq] → (data, true)
//   其余                       → (nil, false)   调用方改走快照
func (b *Buffer) Slice(from uint64) (data []byte, ok bool)

func (b *Buffer) BaseSeq() uint64 // 保留内容的起始 seq
func (b *Buffer) HeadSeq() uint64 // 累计追加的总字节数
```

## 不变式（必须由单测保证）

1. **`HeadSeq()` 永远等于历史上 `Append` 的字节总数。** 裁剪不影响它。
2. **`BaseSeq() == HeadSeq() - len(保留内容)`**。
3. **`Slice(HeadSeq())` 返回空且 `ok`。**（客户端完全跟上时没有要补的）
4. **`Slice(BaseSeq())` 返回全部保留内容。**
5. 对任意 `from ∈ [BaseSeq, HeadSeq]`，`Slice(from)` 的长度 `== HeadSeq - from`。
6. `Append` 单次超过容量时，只保留末尾 `capacity` 字节，`HeadSeq` 仍加满整个长度。

第 5 条是**字节级连续性**（AC-2.1）的数学基础：客户端说"我到 N 了"，切片长度必然正好是它缺的那些字节，不多不少。

## 裁剪

空间不足时从头部丢掉刚好够用的字节数，`BaseSeq` 跟着前移。**不找 `\n` 边界、不在回放前插任何东西**：被裁掉的那部分客户端只能从快照拿，回放起点也就不会落在一段被裁断的转义序列中间。

## 导出与恢复（ADR-0016）

热升级把缓冲交接给新进程：`Export()` 返回 `(base_seq, 保留内容的拷贝)`，`Restore(capacity, base, data)` 在新进程里重建。不变式：

- `Restore(Export())` 之后 `BaseSeq` / `HeadSeq` 与导出时**完全相等**，对任意 `from ∈ [base, head]`，`Slice(from)` 逐字节一致 —— 这是跨进程版的 AC-2.1
- `data` 比新容量大时只保留末尾 `capacity` 字节、`base` 相应前移，`HeadSeq` 不变（与单次 `Append` 超容量的规则一致）—— 升级时 `--ring-bytes` 改小了也不会算错序号

模拟器的状态由 `internal/vterm` 另行导出，见 [session-manager.md](session-manager.md)。

## 实现选择

用**单个 `[]byte` + 读写位置**的经典环形结构，不用 `bytes.Buffer` 链表：

- `Slice` 需要返回连续数据 → 环绕时需要一次拷贝拼接。可接受（续传不是热路径）
- `Append` 是热路径，必须零分配：`copy` 进预分配的数组，不扩容
- 容量在创建时固定，不动态增长

```go
type Buffer struct {
    buf   []byte    // 固定 capacity
    start int       // 保留内容在 buf 中的起始下标
    n     int       // 保留内容长度，n <= capacity
    base  uint64    // start 处的 seq
}
```

`HeadSeq() = base + uint64(n)`。

## 必测用例

| ID | 用例 |
|---|---|
| UT-ring-1 | 顺序 Append 后 `Slice(k)` 对每个 `k ∈ [0, Head]` 长度都等于 `Head - k` |
| UT-ring-2 | 超容后 `Slice(k < BaseSeq)` 返回 `(nil, false)`；`Slice(BaseSeq)` 返回末尾 capacity 字节 |
| UT-ring-5 | 环绕（`start + n > capacity`）时 `Slice` 拼接正确 |
| UT-ring-6 | 单次 Append 超过 capacity：只留末尾，`HeadSeq` 加满 |
| UT-ring-7 | `Slice(HeadSeq())` 返回空 + `true`；`Slice(HeadSeq()+1)` 返回 `(nil, false)` |
| UT-ring-8 | 模糊测试：随机 Append/Slice 序列，断言不变式 1–6 始终成立 |
| UT-ring-9 | `Append` 在稳态下零分配（`testing.AllocsPerRun == 0`） |
| UT-ring-10 | `Restore(Export())` 前后 `BaseSeq` / `HeadSeq` / 任意 `Slice` 逐字节相等；新容量更小时只留末尾 |

UT-ring-3（`\n` 边界裁剪）与 UT-ring-4（`ESC[0m` 前缀）随 ADR-0026 删除，编号不复用。UT-ring-8 的模糊测试是这个模块最有价值的测试 —— 环形缓冲的 bug 几乎都在边界情况，随机化比手写用例更可能撞到。
