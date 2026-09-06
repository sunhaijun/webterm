# WebSocket 协议

> 状态：Accepted · 协议版本 `1`
>
> ★ **这是前后端的唯一契约。** 任何改动必须先改这篇文档，再改代码。不允许一侧先改。
> 实现位置：`internal/protocol`（Go）与 `web/src/protocol`（TS），两者必须严格对应，并对同一组测试向量做单测。

---

## 0. 术语速查

| 名字 | 定义 |
|---|---|
| `sid` | 会话 id，`uint16`，agent 进程内唯一，进程重启后重新分配 |
| `out_seq` | **agent 已发给 client 的累计字节数**（按会话）。剥离 OSC 之后计数 |
| `in_seq` | **client 已发给 agent 的累计字节数**（按会话） |
| `in_ack` | agent 已真正写入 PTY 的累计输入字节数 |
| `base_seq` | 环形缓冲当前保留内容的起始 `out_seq` |
| `head_seq` | 环形缓冲当前的末尾 `out_seq`（= 该会话累计产出字节数） |

**seq 是字节计数，不是消息计数。** 理由见 [ADR-0009](../20-architecture/adr/0009-hybrid-ws-framing.md)。

---

## 1. 连接建立

### 端点

```
GET /ws
Upgrade: websocket
Cookie: webterm_session=<token>
Origin: https://<配置的域名>
```

### 服务端校验（全部失败即拒绝，不升级）

| 检查 | 失败响应 |
|---|---|
| Cookie 存在且对应未吊销的设备 | `401` |
| `Origin` 与配置域名严格相等（`--dev` 下允许 `http://localhost:*` 与 `http://127.0.0.1:*`） | `403` |
| 协议版本可协商（见下） | `426` + JSON 说明 |

**不使用子协议（`Sec-WebSocket-Protocol`）做版本协商** —— 版本在 `hello`/`welcome` 里协商，这样版本不匹配时能给出可读的错误消息而不是一个裸的握手失败。

### 单连接约定

- 一条 WebSocket 复用所有会话，帧头带 `sid`
- 同一设备可以开多条连接（多个标签页）。**agent 允许并且不做互斥**：每条连接独立订阅、独立记 `out_seq`
- 输入侧多连接并发写同一会话是允许的但语义上由用户负责（就像两个人 attach 同一个 tmux）。`in_seq` 按 **连接** 独立记账，见 §5.3

---

## 2. 帧类型

WebSocket 原生的 opcode 就是判别依据，不需要额外的判别字节。

| WebSocket 帧 | 内容 |
|---|---|
| **binary** | 终端数据。12 字节定长头 + 原始负载 |
| **text** | 控制消息。JSON 对象，必有 `t` 字段 |

任何不符合上述格式的帧 → 接收方发 `error{code:"bad_frame"}` 并关闭连接。

---

## 3. 二进制数据帧

### 布局（大端）

```
偏移  长度  字段      类型      说明
────  ────  ────────  ────────  ──────────────────────────────────────
  0     1   type      uint8     0x01 = OUTPUT (agent→client)
                                0x02 = INPUT  (client→agent)
  1     1   flags     uint8     保留。发送方必须填 0；接收方忽略未知位
  2     2   sid       uint16    会话 id
  4     8   seq       uint64    本帧【首字节】的 out_seq / in_seq
 12     N   payload   bytes     原始终端字节，N ≥ 1
```

- 头部固定 12 字节
- `payload` 长度为 0 的帧是非法的 → `error{code:"bad_frame"}`
- 单帧 `payload` 上限 **256 KiB**；超出 → `error{code:"frame_too_large"}` 并关闭连接
- **不做任何编码**。`payload` 可以是任意字节序列，包括被切断的多字节 UTF-8 字符

### OUTPUT 帧（agent → client）

- agent 从环形缓冲连续读出后发送。分帧边界完全由 agent 的读取时机决定，**没有语义**
- 连续的 OUTPUT 帧对同一 `sid` 必须满足 `seq(n+1) == seq(n) + len(payload(n))`
- client 收到 `seq != 期望值` 时：
  - `seq < 期望` → 重复数据（不应发生），丢弃并记 warning
  - `seq > 期望` → 出现空洞（不应发生），**立即关闭连接并走重连续传**，不要尝试自行修补

### INPUT 帧（client → agent）

- client 分配 `in_seq` 并写入本地重发队列
- agent 校验：
  - `seq == 该连接的 in_ack` → 正常，写 PTY
  - `seq < in_ack` → 重发的已处理数据，**丢弃前 `in_ack - seq` 字节**，写入剩余部分（重连时的正常情况）
  - `seq > in_ack` → 空洞 → `error{code:"input_gap"}` 并关闭连接
- 会话状态为 `exited` 时收到 INPUT → 丢弃并回 `error{code:"session_exited", sid}`，不关闭连接

---

## 4. 控制消息（JSON 文本帧）

所有控制消息形如 `{"t": "<类型>", ...}`。未知 `t` 值：**接收方必须忽略**（前向兼容）。

### 4.1 client → agent

#### `hello` — 连接后的第一条消息，必须

```json
{
  "t": "hello",
  "protocol": 1,
  "client_id": "c7f3…",
  "resume": [
    { "sid": 1, "out_seq": 483920, "in_seq": 1204 }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `protocol` | client 支持的协议版本 |
| `client_id` | client 自己生成并存在 `localStorage` 的稳定 id，用于日志关联和多标签页区分 |
| `resume` | 想要续传的会话及其进度。首次连接为 `[]` |

agent 在收到 `hello` 之前收到任何其它帧 → `error{code:"expected_hello"}` 并关闭。

#### `session.create`

```json
{ "t": "session.create", "req_id": "r1", "name": null, "cwd": null, "cols": 80, "rows": 24 }
```

`name`/`cwd` 为 `null` 时用默认值（`cwd` 默认为用户 home）。成功回 `session.created`，失败回 `error`。

#### `session.close`

```json
{ "t": "session.close", "req_id": "r2", "sid": 1 }
```

对 `running` 会话：`SIGHUP` → 2 秒后仍存活则 `SIGKILL`。
对 `exited` 会话：直接释放缓冲并销毁。
均回 `session.closed`。

#### `session.rename`

```json
{ "t": "session.rename", "req_id": "r3", "sid": 1, "name": "构建" }
```

设置后该会话**停止**跟随 CWD 自动改名。`name` 传 `null` 恢复自动改名。

#### `subscribe` / `unsubscribe`

```json
{ "t": "subscribe",   "sid": 1, "out_seq": 483920 }
{ "t": "unsubscribe", "sid": 1 }
```

**只对当前可见的会话订阅。** 未订阅的会话在 agent 侧照常运行和缓冲，agent 只在其产生输出时发一条 `session.updated{unread:true}`（做节流，见 §6.3）。

`subscribe` 携带 `out_seq`，语义与 `resume` 相同：agent 从该位置开始补齐。切回会话时用这个消息，不需要重连。

#### `resize`

```json
{ "t": "resize", "sid": 1, "cols": 100, "rows": 30 }
```

client 侧做 100ms 防抖。agent 对 PTY 执行 `TIOCSWINSZ`。

#### `ping`

```json
{ "t": "ping", "ts": 1757116800123 }
```

每 30 秒发一次。**用协议级 ping 而不是 WebSocket 控制帧**，因为浏览器 API 不暴露 ping/pong，且我们要测 RTT。

### 4.2 agent → client

#### `welcome` — 对 `hello` 的响应

```json
{
  "t": "welcome",
  "protocol": 1,
  "server_version": "0.1.0",
  "limits": { "max_sessions": 20, "ring_bytes": 1048576, "max_frame_bytes": 262144 },
  "sessions": [
    {
      "sid": 1, "name": "webterm", "name_is_manual": false,
      "cwd": "/home/sun/github/webterm",
      "status": "running", "exit_code": null,
      "cols": 80, "rows": 24,
      "integration": "active",
      "base_seq": 0, "head_seq": 483920,
      "unread": false,
      "created_at": 1757116000000
    }
  ],
  "resumed": [
    { "sid": 1, "status": "ok", "from_seq": 483920, "in_ack": 1204 }
  ]
}
```

`resumed[].status`：

| 值 | 含义 | client 动作 |
|---|---|---|
| `ok` | 可增量续传 | 不清屏，等着接 OUTPUT 帧 |
| `reset` | 缓冲已覆盖（`out_seq < base_seq`） | **先清屏**（`terminal.reset()`），再接 OUTPUT 帧，并提示"历史输出已截断" |
| `gone` | 该 sid 已不存在（agent 重启过 / 会话已销毁） | 移除该会话的 UI，提示"会话已结束" |

`resumed[].in_ack` 是 agent 侧对该会话已写入 PTY 的累计字节数。**client 必须据此裁剪重发队列，并重发其后的全部输入。**

#### `session.created` / `session.closed` / `session.updated`

```json
{ "t": "session.created", "req_id": "r1", "session": { …同 welcome.sessions[] 的结构… } }
{ "t": "session.closed",  "req_id": "r2", "sid": 1, "exit_code": 0 }
{ "t": "session.updated", "sid": 1, "name": "api", "cwd": "/srv/api", "status": "running", "unread": true, "integration": "active" }
```

`session.updated` 只包含**发生变化的字段** + `sid`。client 做增量合并。

#### `ack`

```json
{ "t": "ack", "sid": 1, "in_ack": 1352 }
```

agent 写入 PTY 后发送。**做节流**：同一会话最多每 50ms 一条，取最新值（这是累计量，丢中间值无害）。

#### `reset`

```json
{ "t": "reset", "sid": 1, "base_seq": 512000 }
```

在**已连接期间**发生缓冲覆盖时使用（罕见：客户端写队列积压导致落后太多）。语义同 `resumed.status = "reset"`：client 清屏后重新接收。

重连时的 reset 不用这条消息，走 `welcome.resumed[].status`。

#### `cwd`

```json
{ "t": "cwd", "sid": 1, "path": "/home/sun/github/webterm" }
```

来自 shell 集成的 OSC 7。会话自动命名也由它驱动（`name_is_manual == false` 时）。

#### `prompt`

```json
{ "t": "prompt", "sid": 1, "state": "input" }
```

`state` 取值：

| 值 | 来源 | 含义 | 目标输入模式 |
|---|---|---|---|
| `"input"` | OSC `133;B` | prompt 画完，等用户输入 | **Composer** |
| `"running"` | OSC `133;C` | 命令开始执行 | **Raw** |
| `"done"` | OSC `133;D` | 命令结束，即将回到 prompt | **Composer** |

**这条消息驱动输入模式自动切换**（[ADR-0007](../20-architecture/adr/0007-dual-mode-input.md)）。
`133;A`（prompt 开始）不产生消息 —— 对客户端没有用处。

#### `command.start` / `command.end`

```json
{ "t": "command.start", "sid": 1, "cmd_id": 8842, "text": "go test ./...", "cwd": "/srv/x", "at": 1757116800000, "out_seq": 483920 }
{ "t": "command.end",   "sid": 1, "cmd_id": 8842, "exit_code": 0, "duration_ms": 4210, "out_seq": 491337 }
```

- `cmd_id` 是 `commands` 表的主键，client 可用它做置顶等操作
- `out_seq` 标记该命令的输出在流中的起止偏移。**v0.1 不使用这个字段**，它是为 v0.2 的命令块视图预留的（[ADR-0006](../20-architecture/adr/0006-agent-side-osc-parsing.md)）
- 以空格开头的命令不上报（隐私，AC-6.2）
- 有 `command.start` 但 shell 在命令结束前就死了 → 不会有 `command.end`。client 需要容忍悬空的 start

#### `pong`

```json
{ "t": "pong", "ts": 1757116800123 }
```

`ts` 原样回显 client 的值，client 据此算 RTT。

#### `error`

```json
{ "t": "error", "req_id": "r1", "sid": 1, "code": "session_limit", "message": "会话数已达上限 20" }
```

`req_id` / `sid` 在适用时携带。错误码表见 §7。

#### `notice`

```json
{ "t": "notice", "level": "warn", "message": "agent 即将重启，所有会话将结束" }
```

`level`：`info` / `warn` / `error`。用于 agent 主动告知（如 `SIGTERM` 时的关闭预告、设备被吊销）。

---

## 5. 续传机制

### 5.1 环形缓冲

每个会话在内存里保留最近 `ring_bytes`（默认 1 MiB，可配）的输出。

```
                      base_seq                      head_seq
                          │                             │
输出字节流: ──────────────┼─────────────────────────────┼──────>
            (已被覆盖)    │      (缓冲内保留的内容)      │
```

- `head_seq` = 该会话自创建以来累计产出的字节数（剥离 OSC 之后）
- `base_seq` = `max(0, head_seq - 缓冲实际保留字节数)`
- **裁剪规则**：需要腾空间时，优先裁剪到下一个 `\n` 之后，以减少把转义序列切成两半的概率。若 64 KiB 内找不到换行则按字节硬裁（AC-2.7）
- **回放起点前置 `ESC [ 0 m`**（SGR reset），清除因裁剪而悬空的颜色/属性。这 4 个字节**不计入 `out_seq`** —— 它是渲染修正，不是流内容

> **已知限制**：硬裁剪可能把一个转义序列切成两半，导致回放起点出现少量可见垃圾字符。这个瑕疵在一行内自愈。只在"断开很久 + 期间输出很多"时才可能触发，正常网络抖动（几秒）永远走不到这条路径。已接受，记录在此。

### 5.2 重连续传流程

```
①  client 检测到断开
②  client 保留：每会话的 out_seq、未 ack 的输入队列
③  指数退避重连（0.5s 起，×1.5，上限 15s，±20% 抖动）
    online 事件 / 页面重新可见 → 立即重试一次并重置退避
④  连接建立 → 发 hello{ resume: [{sid, out_seq, in_seq}, …] }
⑤  agent 对每个 sid 判定：
       sid 不存在              → status: "gone"
       out_seq ∈ [base, head]  → status: "ok",    from_seq = out_seq
       out_seq <  base_seq     → status: "reset", from_seq = base_seq
       out_seq >  head_seq     → status: "ok",    from_seq = head_seq   （client 领先，不应发生；不回放）
⑥  agent 回 welcome（含 resumed[].in_ack）
⑦  client：
       status=="reset"  → terminal.reset() + 显示截断提示
       status=="gone"   → 移除会话 UI
       按 in_ack 裁剪重发队列 → 重发其后全部输入
⑧  agent 从 from_seq 开始推送 OUTPUT 帧
```

**关键点**：只有当前可见的会话在 `resume` 里带 `out_seq` 并被立即回放。后台会话可以在 `resume` 里报进度但暂不订阅 —— 由 client 决定，避免重连瞬间涌入大量数据。推荐做法：`resume` 只列可见会话，其它会话在用户切过去时用 `subscribe{out_seq}` 补齐。

### 5.3 输入重发队列

client 侧每会话维护：

```
in_seq_next : uint64        下一个要分配的 in_seq
pending     : [{seq, bytes}]  已发送但未被 ack 的输入
```

- 发送时：分配 `seq = in_seq_next`，`in_seq_next += len`，入队 `pending`
- 收到 `ack{in_ack}`：丢弃 `pending` 中 `seq + len <= in_ack` 的项；若某项被部分 ack，裁掉其前部
- 重连后：按 `welcome.resumed[].in_ack` 裁剪，然后**按 seq 升序重发** `pending` 全部内容
- `pending` 上限 **64 KiB**。超出时停止接受新输入并在 UI 上明确提示"离线输入已满"，**不要静默丢弃**

**多连接下的 in_seq**：`in_seq` 与 `in_ack` 按 **(连接, 会话)** 记账，不是全局。因为两个标签页各自独立计数，混在一起没有意义。agent 为每条连接的每个会话维护独立的 `in_ack`。

### 5.4 心跳与超时

| 方向 | 规则 |
|---|---|
| client → agent | 每 30 秒发 `ping` |
| agent → client | 收到 `ping` 立即回 `pong` |
| client 判死 | 发出 `ping` 后 10 秒未收到 `pong` → 主动关闭并重连 |
| agent 判死 | 60 秒未收到任何帧 → 关闭连接 |

`ping`/`pong` 不影响 `out_seq`/`in_seq`。

### 5.5 慢客户端策略

每条连接的写队列有界（默认 4 MiB）。**队列满时 agent 关闭该连接，而不是阻塞会话。**

理由：阻塞写会反压到 `PTY.Read()`，进而卡住 shell —— 一个慢客户端不能拖慢服务器上真正在跑的活。被关掉的客户端会自动重连并走续传，只要没落后超过 `ring_bytes` 就无损。

---

## 6. 状态与节流

### 6.1 会话状态机

```
（不存在）──session.create──> running ──shell 退出──> exited ──session.close──> （销毁）
                                 │
                                 └──session.close──> SIGHUP ─2s─> SIGKILL ──> （销毁）
```

`exited` 会话：保留缓冲、可续传、可查看，**不接受输入**。

### 6.2 集成状态

`integration` 字段：`pending` → `active` | `inactive`

- 会话创建时为 `pending`
- 收到 `OSC 1701;hello` → `active`
- 10 秒内未收到 → `inactive`，并发 `session.updated{integration:"inactive"}`
- 从 `active` 变回 `inactive` 也要上报（如用户 `exec zsh`）：连续 2 个命令周期缺失 OSC 133 标记则判定失效

### 6.3 节流规则汇总

| 消息 | 节流 |
|---|---|
| `ack` | 每会话最多 50ms 一条，取最新累计值 |
| `session.updated{unread:true}` | 每会话最多 1s 一条（未读是布尔量，重复无意义） |
| `cwd` | 仅在路径实际变化时发送 |
| `resize`（client 侧） | 100ms 防抖 |

---

## 7. 错误码

| `code` | 含义 | 是否关闭连接 |
|---|---|---|
| `expected_hello` | 首条消息不是 `hello` | 是 |
| `protocol_unsupported` | 协议版本无法协商 | 是 |
| `bad_frame` | 帧格式非法（长度不足、payload 为空、JSON 解析失败） | 是 |
| `frame_too_large` | 超过 `max_frame_bytes` | 是 |
| `input_gap` | INPUT 帧的 `seq` 大于 `in_ack`，出现空洞 | 是 |
| `unauthorized` | 设备已被吊销 | 是（先发 `notice`） |
| `unknown_session` | `sid` 不存在 | 否 |
| `session_exited` | 向已退出的会话写输入 | 否 |
| `session_limit` | 会话数达上限 | 否 |
| `bad_request` | 参数非法（如 `cols <= 0`） | 否 |
| `internal` | agent 内部错误 | 视情况 |

---

## 8. 协议版本演进

- `protocol` 为整数，当前 `1`
- **可以自由添加**：新的控制消息类型、已有消息的新字段。接收方忽略未知 `t` 和未知字段
- **必须升版本**：二进制帧布局变更、已有字段语义变更、删除字段
- 版本不匹配时 agent 回 `error{code:"protocol_unsupported"}` 并在 `message` 里写清双方版本，client 展示"请刷新页面 / agent 版本过旧"

---

## 9. 测试向量

`internal/protocol/testdata/vectors.json` 是前后端共用的 fixture，两侧单测都必须跑它（防止实现漂移）。格式：

```json
{
  "binary_frames": [
    {
      "name": "output_basic",
      "hex": "0100000100000000000000e8" ,
      "decoded": { "type": "OUTPUT", "flags": 0, "sid": 1, "seq": 232, "payload_hex": "" },
      "note": "头部单独校验，payload 另测"
    }
  ],
  "control_messages": [
    { "name": "hello_first_connect", "json": { "t": "hello", "protocol": 1, "client_id": "x", "resume": [] } }
  ],
  "invalid_frames": [
    { "name": "too_short", "hex": "010000010000", "expect_error": "bad_frame" },
    { "name": "empty_payload", "hex": "0100000100000000000000e8", "expect_error": "bad_frame" }
  ]
}
```

必测项见 [`../70-testing/strategy.md`](../70-testing/strategy.md)。最关键的一条是 **AC-2.1 字节级连续性**。
