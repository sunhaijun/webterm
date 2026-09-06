# 环形缓冲

> 状态：Accepted
>
> 这是"永不断线"这个核心承诺的实现基础。`internal/ringbuf`。

## 契约

```go
type Buffer struct { … }

// New 创建容量为 capacity 字节的缓冲。
func New(capacity int) *Buffer

// Append 追加数据，返回本段【首字节】的 seq。
// 空间不足时从头部裁剪（优先在 \n 边界）。
func (b *Buffer) Append(p []byte) (seq uint64)

// Slice 返回从 from 开始的所有内容。
//   from ∈ [BaseSeq, HeadSeq]  → (data, StatusOK)
//   from <  BaseSeq            → (缓冲全部内容, StatusReset)
//   from >  HeadSeq            → (nil, StatusOK)   客户端领先，不回放
func (b *Buffer) Slice(from uint64) (data []byte, st Status)

func (b *Buffer) BaseSeq() uint64   // 保留内容的起始 seq
func (b *Buffer) HeadSeq() uint64   // 累计追加的总字节数
```

## 不变式（必须由单测保证）

1. **`HeadSeq()` 永远等于历史上 `Append` 的字节总数。** 裁剪不影响它。
2. **`BaseSeq() == HeadSeq() - len(保留内容)`**。
3. **`Slice(HeadSeq())` 返回空且 `StatusOK`。**（客户端完全跟上时不回放）
4. **`Slice(BaseSeq())` 返回全部保留内容。**
5. 对任意 `from ∈ [BaseSeq, HeadSeq]`，`Slice(from)` 的长度 `== HeadSeq - from`。
6. `Append` 单次超过容量时，只保留末尾 `capacity` 字节，`HeadSeq` 仍加满整个长度。

第 5 条是**字节级连续性**（AC-2.1）的数学基础：客户端说"我到 N 了"，切片长度必然正好是它缺的那些字节，不多不少。

## 裁剪规则（AC-2.7）

空间不足时需要丢弃头部。规则：

```
1. 计算需要腾出的最小字节数 need
2. 从当前 base 位置向前扫，找第一个位置 p >= need 使得 buf[p-1] == '\n'
   扫描窗口上限 64 KiB
3. 找到 → 裁剪到 p（在行边界，干净）
   没找到 → 硬裁剪到 need（可能切断转义序列）
4. BaseSeq += 实际裁剪的字节数
```

**为什么优先行边界**：ANSI 转义序列（`ESC[31m`）不跨行出现在行首的概率很高。在 `\n` 之后开始回放，绝大多数情况下不会切到序列中间。

**64 KiB 扫描窗口**：防止在一个巨大的无换行输出（比如 `cat` 一个二进制文件）里无限扫描。

## 回放的属性修正

**只在 `Slice` 返回 `StatusReset` 时**：前面的字节已被裁掉，回放起点可能落在一段颜色/属性设置的中间，后续文本会继承错误的属性。修正是在数据前插入 `ESC [ 0 m`（SGR reset，4 字节），承载它的 OUTPUT 帧置 `flags` bit0（协议 §3）。

**两条都必须做对，各自都是永久性错位的来源**：

1. **`StatusOK` 绝不能插。** 增量续传时客户端的终端状态是完整的，插入 SGR reset 会把断点处生效中的属性清掉 —— AC-2.1 的字节级比较会在"断点恰好落在着色区间内"时失败（偶发，很难查）
2. **这 4 个字节不计入 `out_seq`。** 它是渲染修正，不是流内容。实现上：`Push` 一个特殊标记让连接层插入这 4 字节并置 `flags` bit0，seq 记账只按 `data` 长度走。若计入 seq，两侧会永久错开 4 字节

**这两条都必须有单测**（UT-ring-4）。

## 已知限制（已接受）

硬裁剪可能把一个转义序列切成两半，回放起点出现少量可见垃圾字符。

- **自愈**：一行内即恢复
- **触发条件极窄**：需要"断开时间 × 输出速率 > 1 MiB"，且恰好裁在序列中间。正常网络抖动（几秒）永远走不到
- **不做完美方案**：完美方案是在服务端跑一个 headless 终端模拟器维护完整屏幕状态（mosh 的做法），成本远超收益

记录在 [`../30-protocol/websocket-protocol.md`](../30-protocol/websocket-protocol.md#51-环形缓冲) 里。

## 实现选择

用**单个 `[]byte` + 读写位置**的经典环形结构，不用 `bytes.Buffer` 链表：

- `Slice` 需要返回连续数据 → 环绕时需要一次拷贝拼接。可接受（回放不是热路径）
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
| UT-ring-2 | 超容后 `Slice(0)` 返回 `StatusReset` 且内容 == 末尾 capacity 字节 |
| UT-ring-3 | 裁剪优先落在 `\n` 之后；无换行时硬裁；64 KiB 窗口生效 |
| UT-ring-4 | SGR reset 前缀：只在 `StatusReset` 时产生，且不计入 seq（`HeadSeq` 不变） |
| UT-ring-5 | 环绕（`start + n > capacity`）时 `Slice` 拼接正确 |
| UT-ring-6 | 单次 Append 超过 capacity：只留末尾，`HeadSeq` 加满 |
| UT-ring-7 | `Slice(HeadSeq())` 返回空 + OK；`Slice(HeadSeq()+1)` 返回 nil + OK |
| UT-ring-8 | 模糊测试：随机 Append/Slice 序列，断言不变式 1–6 始终成立 |
| UT-ring-9 | `Append` 在稳态下零分配（`testing.AllocsPerRun == 0`） |

UT-ring-8 的模糊测试是这个模块最有价值的测试 —— 环形缓冲的 bug 几乎都在边界情况，随机化比手写用例更可能撞到。
