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
| `client_id` | **一次页面加载**的身份（不是标签页的一生）。**输入记账的 key**，见 §5.3 |
| `instance_id` | agent 进程本次启动的随机 id。用于识别"agent 重启过"，见 §5.2 |

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

**握手阶段不做版本协商** —— 握手上没有携带 client 版本的字段（不使用 `Sec-WebSocket-Protocol`）。版本在 `hello`/`welcome` 里协商，不匹配时回 `error{code:"protocol_unsupported"}`，这样能给出可读的错误消息而不是一个裸的握手失败。

### 单连接约定

- 一条 WebSocket 复用所有会话，帧头带 `sid`
- 同一设备可以开多条连接（多个标签页）。**agent 允许并且不做互斥**：每条连接独立订阅、独立记 `out_seq`
- 输入侧多连接并发写同一会话是允许的但语义上由用户负责（就像两个人 attach 同一个 tmux）。`in_seq` 按 **`client_id`** 独立记账，见 §5.3

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
  1     1   flags     uint8     bit0 = ATTR_PREFIX（仅 OUTPUT，见下）
                                其余位保留：发送方填 0，接收方忽略
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
- **`flags` bit0（`ATTR_PREFIX`）**：置位表示 `payload` 的前 4 字节是 `ESC [ 0 m`（属性修正，见 §5.1），**不计入 seq**。只出现在 reset 回放的第一帧上
- **ATTR_PREFIX 是一条指令，不只是一个标记**：client 收到置位的帧必须**先清屏**（`terminal.reset()`）再写这一帧，并把 `out_seq` 置为 `seq + data_len`。它自带"这段内容与你屏幕上的东西接不上"的语义，**不依赖任何先到的控制消息** —— agent 少发一条 `reset`，屏幕也不会被接歪。`reset` 消息只负责 UI 提示（§4.2）
- **"不计入 seq"的渲染修正一共两处**，规则相同：这 4 个字节的 `ESC[0m`，以及 `redraw.modes`（§4.2）。它们都是 agent 生成的渲染指令，不是流内容；计进去两侧会永久错开
- 记 `data_len(n) = len(payload(n)) - (flags(n) & 1 ? 4 : 0)`。连续的 OUTPUT 帧对同一 `sid` 必须满足 `seq(n+1) == seq(n) + data_len(n)`
- client 收到 `seq != 期望值` 时（**仅对 `flags` bit0 未置位的帧**；置位的帧是重建，永远照写）：
  - `seq < 期望` → 重复数据（不应发生），丢弃并记 warning
  - `seq > 期望` → 出现空洞（不应发生），**立即关闭连接并走重连续传**，不要尝试自行修补

### INPUT 帧（client → agent）

- client 分配 `in_seq` 并写入本地重发队列
- agent 校验（记账属于 `(client_id, sid)`，不属于连接，见 §5.3）。设 `accepted`
  为 agent 已接受入队的累计字节数：
  - `seq == accepted` → 正常，入队待写 PTY
  - `seq < accepted` → 重发的已处理数据，**丢弃前 `accepted - seq` 字节**，接受剩余部分（重连时的正常情况）
  - `seq > accepted` → 空洞 → `error{code:"input_gap"}` 并关闭连接

  **校验用的是 `accepted` 而不是 `in_ack`。** 两者不同：`in_ack` 是已经真正
  写进 PTY 的字节数，它滞后于入队。拿 `in_ack` 做校验的话，客户端连着发两帧
  时第二帧就会被误判成空洞 —— PTY 还没来得及消费第一帧。`in_ack` 只用于
  `ack` 与重连后的重发起点。
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
  "instance_id": "a91e…",
  "resume": [
    { "sid": 1, "out_seq": 483920 }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `protocol` | client 支持的协议版本 |
| `client_id` | **每个标签页一个**，client 自己生成并存在 `sessionStorage`（不是 `localStorage` —— 那是同源共享的，区分不了标签页）。跨重连稳定，是输入记账的 key（§5.3） |
| `instance_id` | 上次 `welcome` 里拿到的值，首次连接为 `null`。与 agent 当前值不符 → agent 把所有 `resume` 项判为 `gone`（§5.2） |
| `resume` | 想要续传的会话及其输出进度。首次连接为 `[]`。**不带输入进度** —— `in_ack` 由 agent 保管 |

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
{ "t": "subscribe",   "sid": 1, "out_seq": 483920, "cols": 90, "rows": 30 }
{ "t": "unsubscribe", "sid": 1 }
```

**只对当前可见的会话订阅。** 未订阅的会话在 agent 侧照常运行和缓冲，agent 只在其产生输出时发一条 `session.updated{head_seq}`（做节流，见 §6.3），client 据此自行判定未读。

`subscribe` 携带 `out_seq`，语义与 `resume` 相同：agent 从该位置开始补齐。切回会话时用这个消息，不需要重连。

**`cols` / `rows` 是切回时的终端尺寸**，省略（或为 0）表示"沿用会话当前尺寸"。**切会话时不要再单发一条 `resize`** —— 尺寸必须和 `subscribe` 在同一条消息里，理由是顺序：

- 尺寸排在后面（比如走 100ms 防抖的 `resize`），agent 补的就是按【旧尺寸】排版的积压，绝对定位与折行全部错位；
- 尺寸排在前面单发，PTY 先收到 `TIOCSWINSZ`、全屏程序立刻整屏重画，**那批重画字节会落在 `subscribe` 之前**，被随后的 `redraw.seq` 跳过（§4.2），客户端反而拿不到那一屏。

合成一条之后，agent 就能把顺序钉死：**先算分支、先发 `redraw`/回放，再应用尺寸**。

**`out_seq < base_seq` 时按屏分流**（切走期间的输出超过了 `ring_bytes`，这是切回场景里的常态而不是异常）：

| 会话当前的屏 | agent 的动作 | client 的动作 |
|---|---|---|
| 主屏（追加流） | 先发 `reset`（§4.2），再发置位 `ATTR_PREFIX` 的回放帧 | 清屏后按字节重建 |
| 备用屏（状态） | 发 `redraw`（§4.2），**不回放窗口字节**，随后逼出一次整屏重画 | 清屏 + 恢复模式，然后等程序自己画 |

分流的理由见 [ADR-0019](../20-architecture/adr/0019-altscreen-redraw-not-replay.md)：备用屏没有 scrollback，窗口里的差分字节离开 `ESC[?1049h` 就没有意义，回放它必然画错。

**判定交给环形缓冲**，调用方不要自己钳位 —— 钳过的位置会落进"正常增量"分支，于是既不发 `reset`、也不置 `ATTR_PREFIX`，客户端把一段接不上的内容接到旧屏幕后面（§5.2 同款陷阱）。

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
  "instance_id": "a91e…",
  "limits": { "max_sessions": 20, "ring_bytes": 1048576, "max_frame_bytes": 262144 },
  "sessions": [
    {
      "sid": 1, "name": "webterm", "name_is_manual": false,
      "cwd": "/home/sun/github/webterm",
      "status": "running", "exit_code": null,
      "cols": 80, "rows": 24,
      "integration": "active",
      "unmarked_input": false,
      "prompt_state": "input",
      "base_seq": 0, "head_seq": 483920,
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
| `gone` | 该 sid 已不存在（会话已销毁 / `instance_id` 不符） | 移除该会话的 UI，提示"会话已结束" |

`resumed[].in_ack` 是 agent 对 **该 `client_id`** 在该会话上已写入 PTY 的累计字节数（§5.3）。**client 必须据此裁剪重发队列，并重发其后的全部输入。**

**未读靠 `head_seq` 推导**，不是服务端状态：`unread = head_seq > 本地 out_seq`。未读天然是 per-client 的，放在服务端会让两个标签页互相清对方的未读。

**`prompt_state` 是给重连用的。** `prompt` 消息只在状态变化的那一刻发一次 —— 客户端离线期间发生的那些【发给了零个订阅者，就此丢掉】。如果断线恰好跨过一个命令边界，客户端手里还是断线前的状态：命令早就跑完了，它却以为还在跑，于是停在 Raw 模式、Composer 收起，用户【连字都打不了】，直到下一条命令才自愈。

所以每次 `welcome` 都要把当前 prompt 状态带回去，让客户端重新对齐。取值与 `prompt` 消息相同；集成不可用时为 `null`。

#### `session.created` / `session.closed` / `session.updated`

```json
{ "t": "session.created", "req_id": "r1", "session": { …同 welcome.sessions[] 的结构… } }
{ "t": "session.closed",  "req_id": "r2", "sid": 1, "exit_code": 0 }
{ "t": "session.updated", "sid": 1, "name": "api", "cwd": "/srv/api", "status": "running", "head_seq": 491337, "integration": "active" }
```

- 三条都**广播给该设备的所有连接**（否则 B 标签页看不到 A 新建的会话）。`req_id` 只出现在发起请求的那条连接的副本上
- `session.updated` 只包含**发生变化的字段** + `sid`。client 做增量合并

#### `ack`

```json
{ "t": "ack", "sid": 1, "in_ack": 1352 }
```

agent 写入 PTY 后发送。**做节流**：同一会话最多每 50ms 一条，取最新值（这是累计量，丢中间值无害）。

#### `reset`

```json
{ "t": "reset", "sid": 1, "base_seq": 512000 }
```

在**已连接期间**发生缓冲覆盖、且会话在**主屏**时使用。触发点只有一个：`subscribe` 的 `out_seq < base_seq`（切走太久，积压超过 `ring_bytes`）。紧跟其后的是置位 `ATTR_PREFIX` 的回放帧。会话在备用屏时走 `redraw`，不发这条。

**分工**：清屏由 `ATTR_PREFIX` 驱动（§3），这条消息只负责**告诉用户**"历史输出已截断"。两者都到齐时客户端会清两次屏 —— 无害，因为两次都发生在回放帧写入之前。

重连时的 reset 不用这条消息，走 `welcome.resumed[].status`；那条路上 `welcome` 已经先到，再发一条纯属重复。

#### `redraw`

```json
{ "t": "redraw", "sid": 1, "seq": 991337, "modes": "\u001b[0m\u001b(B\u001b[?1049h\u001b[?1h\u001b[?1000h\u001b[?1006h\u001b[?2004h" }
```

会话**当前在备用屏**（agent 跟踪 `ESC[?1049h`，见 [ADR-0019](../20-architecture/adr/0019-altscreen-redraw-not-replay.md)）而又需要 reset 时发这条，**代替**字节回放。

| 字段 | 说明 |
|---|---|
| `seq` | client 把该会话的 `out_seq` **直接跳到**这里（= 发出时的 `head_seq`）。跳过的字节被有意丢弃 |
| `modes` | agent 按跟踪表拼出来的粘性模式前缀，纯 ASCII 转义序列，几十字节。**只含 agent 自己生成的开关，不含任何程序输出的原文** |

**client 动作**，按这个顺序：① 清空输出写队列并恢复跟随 → ② `terminal.reset()` → ③ 原样写入 `modes` → ④ `out_seq = catchup_to = seq` → ⑤ 之后按普通实时帧接收。第一批实时帧就是程序自己的整屏重画。**不显示"历史输出已截断"**：备用屏本来就没有历史，那条提示是误导。

**`modes` 的字节不计入 `out_seq`** —— 与 `ATTR_PREFIX` 同一条规则（§3）。它是渲染修正，不是流内容。

**顺序承诺**：`redraw` 与后续 OUTPUT 帧走同一条按序写队列；"把 `seq` 定为 `head_seq`"与入队在同一把锁下完成，**逼出重画的动作（应用尺寸 / 抖动 winsize）必须排在入队之后**。反过来的话重画字节先进环形缓冲、随后被 `seq` 跳过，客户端拿不到那一屏。

**兜底**：agent 发出重画请求后起一个 300ms 定时器，判据是 `head_seq` 有没有超过 `redraw.seq`。没超过 → 判定程序不响应 SIGWINCH → 退回主屏那条路（`ATTR_PREFIX` + 窗口内容）。最坏情况不比字节回放差。

**为什么不复用 `resumed[].status` 加一个取值**：协议里唯一明文的前向兼容承诺是"未知 `t` 一律忽略"（§4）。用独立消息，老 client 看不懂就当没收到，退化成今天的行为；加新的 status 取值则没有这条保护。

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

它【不可续传】—— 离线期间的状态变化就是丢了。重连后靠 `welcome.sessions[].prompt_state` 重新对齐，见 §4.2。
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
- **顺序承诺**：`command.start` / `command.end`（以及同一次 PTY 读里产生的 `prompt` / `cwd`）**先于**包含其 `out_seq` 位置的 OUTPUT 帧到达。事件与帧走同一条按序写队列，agent 在推帧之前先发事件。client 据此能在写入 xterm 时把帧在 `out_seq` 处切开、登记行锚点 ——「在终端里看」才能定位到块（[ADR-0011](../20-architecture/adr/0011-read-first-layout.md) ④）。不保证这一点的旧 agent 只是让 client 登记不了锚点，定位退回按命令原文搜索
- **`out_seq` 是该标记在剥离后输出流里的精确位置**，不是发消息那一刻的 head。`[start.out_seq, end.out_seq)` 恰好是这条命令的输出字节 —— 命令块视图靠它切块。同一次 PTY 读里可能同时到达 `133;C`、输出、`133;D`，每个标记各有各的位置（解析器为每个事件报告它在本块干净输出里的偏移，见 [shell-integration.md §5](shell-integration.md#5-agent-侧-osc-解析器要求)）。**用整块 append 之后的 head 盖戳是错的**：快命令的 start 和 end 会相等，块为空

#### `transcript`

```json
{ "t": "transcript", "sid": 1, "source": "claude", "reset": true, "items": [] }
{ "t": "transcript", "sid": 1, "source": "claude", "items": [
  { "id": "u1#0", "role": "user", "kind": "text", "text": "解释一下 context 包", "at": 1757116800000 },
  { "id": "a1#1", "role": "assistant", "kind": "text", "text": "## context\n\n…", "at": 1757116805000 },
  { "id": "a1#2", "role": "tool", "kind": "tool_use", "name": "Bash", "text": "go test ./...", "at": 1757116805000 }
] }
```

前台起了 claude / codex（`command.start` 的 `text` 认出程序名），agent 跟踪它的会话文件（[ADR-0012](../20-architecture/adr/0012-ai-cli-conversation-first.md) β）并把对话按到达顺序推过来。

- `source`：`claude`（`~/.claude/projects/<cwd-slug>/*.jsonl`）或 `codex`（`~/.codex/sessions/…/rollout-*.jsonl`）
- `reset: true` 的那条在新一轮跟踪开始时发（`items` 为空）：客户端先清空
- `role`：`user` / `assistant` / `tool`（工具调用摘要，`name` 是工具名）/ `system`（斜杠命令的本地回显）；`kind`：`text`（Markdown 正文）/ `tool_use`
- 消息是**整块完成才落盘**的，流式过程看终端；子代理、思考、工具结果、开发者提示、注入的上下文都不进转录
- 与 `command.*` 一样发给**所有连接**、不可续传；重连 / 切会话后用 [`GET /api/transcript`](http-api.md#转录) 回放，再接增量
- 命令结束（`command.end` 或 shell 退出）停止跟踪；条目留到下一次 AI 命令开始或会话关闭

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
- **只有 reset 回放**（`status == "reset"` 或 `reset` 消息）在起点前置 `ESC [ 0 m`（SGR reset），清除因裁剪而悬空的颜色/属性。承载它的帧置 `flags` bit0，这 4 个字节**不计入 `out_seq`**（§3）
  - 增量续传（`status == "ok"`）**绝不能注入** —— 客户端的终端状态是完整的，注入会把断点处生效中的属性清掉，让 AC-2.1 的字节级比较失败

> **已知限制**：硬裁剪可能把一个转义序列切成两半，导致回放起点出现少量可见垃圾字符。这个瑕疵在一行内自愈。只在"断开很久 + 期间输出很多"时才可能触发，正常网络抖动（几秒）永远走不到这条路径。已接受，记录在此。

**备用屏会话不走上面这一段。** 会话当前在备用屏（`ESC[?1049h`）时，窗口里的字节是一串**离开上下文就没有意义**的差分补丁：模式开关只在会话开头出现一次，早被裁掉了。这种情况下 reset 改发 `redraw`（§4.2）—— 清屏 + 恢复模式 + 逼程序自己整屏重画，不回放窗口。理由与边界见 [ADR-0019](../20-architecture/adr/0019-altscreen-redraw-not-replay.md)。

### 5.2 重连续传流程

```
①  client 检测到断开
②  client 保留：每会话的 out_seq、未 ack 的输入队列
③  指数退避重连（0.5s 起，×1.5，上限 15s，±20% 抖动）
    online 事件 / 页面重新可见 → 立即重试一次并重置退避
④  连接建立 → 发 hello{ client_id, instance_id, resume: [{sid, out_seq}, …] }
⑤  agent 对每个 sid 判定：
       instance_id 不符        → status: "gone"   （agent 重启过，sid 会被重新分配，见下）
       sid 不存在              → status: "gone"
       out_seq ∈ [base, head]  → status: "ok",    from_seq = out_seq
       out_seq <  base_seq     → status: "reset", from_seq = base_seq
       out_seq >  head_seq     → status: "ok",    from_seq = head_seq   （client 领先，不应发生；不回放）
⑥  agent 回 welcome（含 instance_id 与 resumed[].in_ack）
⑦  client：
       status=="reset"  → terminal.reset() + 显示截断提示
       status=="gone"   → 移除会话 UI
       按 in_ack 裁剪重发队列 → 重发其后全部输入
⑧  agent 从 from_seq 开始推送 OUTPUT 帧
       该会话在备用屏、且判定为 reset → 改发 redraw（§4.2），不回放窗口
```

**为什么要 `instance_id`**：`sid` 是 `uint16` 且 agent 重启后从头分配。没有实例标识时，一个 `resume{sid:1, out_seq:很大}` 会落进"client 领先"分支 —— 屏幕上留着旧会话的内容，之后接的却是一个**毫不相干的新会话**的输出，用户无从察觉。

**热升级不算重启**（[ADR-0016](../20-architecture/adr/0016-hot-reexec.md)）：agent 原地 re-exec 时把 `instance_id`、每会话的环形缓冲与 `in_ack` 一并交接给新进程，所以升级后客户端重连仍是 `status: "ok"` 的增量续传，不是 `gone`。client 侧对此**无感**，走的就是上面这条流程 —— 它只会看到一次普通的断线重连。只有真正的进程重启（`SIGTERM`、崩溃）才换 `instance_id`。

**关键点**：只有当前可见的会话在 `resume` 里带 `out_seq` 并被立即回放。后台会话可以在 `resume` 里报进度但暂不订阅 —— 由 client 决定，避免重连瞬间涌入大量数据。推荐做法：`resume` 只列可见会话，其它会话在用户切过去时用 `subscribe{out_seq}` 补齐。

**「补课」的字节必须被标成回放。** client 侧每会话记一个 `catchup_to`：`out_seq` 追到它之前收到的输出都算回放。取值：

| 时机 | `catchup_to` |
|---|---|
| `welcome` | 该会话的 `head_seq` |
| `subscribe`（切回会话） | 该会话已知的 `head_seq`（由 `session.updated` 维护） |
| 收到 `ATTR_PREFIX` 帧 | 新的 `out_seq`（reset 已重建到当前，之后就是 live） |

**为什么非标不可**：历史输出里有程序发过的终端查询（DSR / DA / `CSI ?u` …）。把这段字节写进终端，终端会**再答一遍** —— 那不是用户输入，送进 PTY 就是一串乱码键入，前台程序（claude / codex）会当成按键吃掉。回放期间必须抑制这些自动应答。重连路径一直是这么做的；**切回会话时的补课同样是回放**，漏标就等于每切回一次给前台程序喂一次乱码。

**抑制的是自动应答，不是用户的按键。** 这两样东西都从终端的 `onData` 出来，区别在于**谁产生的**：自动应答同步发生在 `term.write()` 的解析里，用户按键同步发生在一次 DOM 输入事件的派发里。按"此刻是否在回放"一刀切会把用户正在敲的字一起吞掉，而回放窗口在 `ring_bytes` 满载时是秒级的（[ADR-0020](../20-architecture/adr/0020-input-never-silently-dropped.md)）。client 必须按来源区分：**正在派发用户输入事件时产生的 `onData` 一律放行**，其余的才受回放门约束。

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

**记账的 key 是 `(client_id, sid)`，不是连接。** 两个标签页各自独立计数（混在一起没有意义），但**同一标签页的重连必须继承 `in_ack`**：

- agent 为每个 `(client_id, sid)` 维护 `in_ack`，**保留到会话销毁为止**（一个 `uint64`，上界 `max_conns × max_sessions`）
- 该 `client_id` 从未对这个会话发过输入时 `in_ack = 0`，此时 client 侧的 `in_seq_next` 也必然是 0，两侧天然对齐

**`client_id` 的生存期必须是【一次页面加载】，不能跨刷新保留。**

`in_seq_next` 与 `pending` 都活在页面里，页面一走它们就归零；而 agent 的 `accepted` 按 `client_id` 记、保留到会话销毁。把 id 留到刷新之后（比如存 `sessionStorage`），两侧记账就错位了：client 从 `seq = 0` 重新开始，agent 看到 `seq < accepted` 且 `accepted - seq >= len(data)`，于是把**新输入当成重发整段丢掉** —— 不写 PTY、不 ack、不报错。

症状是**刷新之后打字完全没反应**，而且**刷新不会让它变好**：`accepted` 只增不减，刷一次欠账只会更多。要等用户又打够 `accepted` 字节才恢复，观感上就是"一直打不进"（2026-09-19 实测确认，[ADR-0020](../20-architecture/adr/0020-input-never-silently-dropped.md) 的那条原则在这里被破了）。

代价是 agent 为每个 `(client_id, sid)` 留一份记账（两个 `uint64` + key，约 60 B），上界从"`max_conns × max_sessions`"变成"**该会话生命周期内的页面加载次数 × max_sessions**"。会话销毁即释放；按每天刷新上百次算也只有几十 KB，**换来的是"刷新之后打字还进得去"**，值。
- 若按连接记账，重连后 `in_ack` 归零而 client 的 `pending` 仍从旧 `seq` 起，agent 会判 `seq > in_ack` → `input_gap` → 关连接 → 无限重连。**断线期间的输入不丢**（US-2.2）整条就废了

**连接断开时，agent 必须丢弃该 `client_id` 已入队但尚未写入 PTY 的输入**，并把
`accepted` 回退到 `in_ack`。这些字节从未被 ack，client 仍持在 `pending` 里，
重连后会重发；不丢的话它们会被写进 PTY 一次、重发时再写一次。回退之后
`accepted == in_ack`，client 按 `in_ack` 重发就精确对齐。

### 5.4 心跳与超时

| 方向 | 规则 |
|---|---|
| client → agent | 每 30 秒发 `ping` |
| agent → client | 收到 `ping` 立即回 `pong` |
| client 判死 | 发出 `ping` 后 10 秒未收到 `pong` → 主动关闭并重连 |
| client 探活 | `online` 事件 / 页面重新可见时**立刻**发一次 `ping`，**2 秒**未收到 `pong` → 关闭并重连 |
| agent 判死 | 60 秒未收到任何帧 → 关闭连接 |

`ping`/`pong` 不影响 `out_seq`/`in_seq`。探活复用同一对消息，**agent 侧不需要任何改动**。

**为什么要单独一条探活规则。** 线路断掉不一定有 `onclose`：手机息屏、切 App、Wi-Fi 切蜂窝、NAT / 反向代理静默回收连接，这些场合 TCP 上没有 FIN，浏览器那边 `readyState` 一直是 OPEN。这种**僵尸连接**自认在线，唯一的暴露渠道就是心跳，最坏 30 + 10 = 40 秒 —— 而 `setInterval` 在后台标签页还会被节流，实际更久。这 40 秒里用户打的字全都写进一条死 socket，屏幕上毫无变化。

`online` 与"页面重新可见"是**已知的可疑时刻**：系统刚说网络变了、或者用户刚把应用切回前台。此时连接要么是活的（本机 RTT 远小于 2 秒），要么就是死的，所以探针用 2 秒而不是心跳的 10 秒。判错的代价只是多一次重连，而重连是无损的（§5.2 续传 + §5.3 按 `in_ack` 重发）。

理由与取舍见 [ADR-0020](../20-architecture/adr/0020-input-never-silently-dropped.md)。

### 5.5 有界队列策略（读写两侧）

| 队列 | 上限 | 满了怎么办 |
|---|---|---|
| 连接写队列（输出 → client） | 4 MiB，`--conn-queue-bytes` | 关闭该连接 |
| 会话输入队列（client → PTY） | 256 KiB | 回 `error{code:"input_stalled", sid}` 并关闭该连接 |

**两侧都绝不阻塞。** 写侧阻塞会反压到 `PTY.Read()` 卡住 shell —— 一个慢客户端不能拖慢服务器上真正在跑的活。读侧阻塞更糟：**一条 WebSocket 复用所有会话**，一个不读 stdin 的前台程序（`sleep`、某些 TUI）会把 PTY 输入缓冲填满，进而卡住整条连接的读循环 —— ping/pong、`resize`、`session.create`、其它会话的输入全停。

关连接是无损的：client 自动重连走续传，输出只要没落后超过 `ring_bytes`、输入按 `in_ack`（§5.3）重发即可。

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
- 收到 `OSC 1701;hello` → 仍 `pending`，但取消握手超时（hello 现在发在用户 dotfile **之前**，只表示脚本开始加载）
- 收到第一个 `OSC 133` 标记 → `active`
- 10 秒内**连 hello 都没收到** → `inactive`，并发 `session.updated{integration:"inactive"}`
- `active` → `inactive`（钩子被摘掉，如 `trap - DEBUG` / `exec bash`）：**在 prompt 前连续 2 次 Enter 有输出却零标记**（[shell-integration.md §4.7](shell-integration.md#47-活性探测按命令)）。不再靠"多久没标记"猜 —— 长命令和发呆都不产生标记。再收到 133 标记立即转回 `active`

`unmarked_input` 字段（bool）：命令**在跑**时连续 2 次 Enter 有输出却零标记 → `true`。说明输入正去往一个没有集成的子程序（ssh / su / 容器 / REPL）；**`integration` 不受影响**，因为外层 shell 没坏。子程序退出、外层标记回来 → `false`。客户端据此提示"当前程序里没有 shell 集成"，命令块在此期间自然合并为一个。

### 6.3 节流规则汇总

| 消息 | 节流 |
|---|---|
| `ack` | 每会话最多 50ms 一条，取最新累计值；**被吞掉的要补发** |
| `session.updated{head_seq}` | 每会话最多 1s 一条（client 只用它判未读，中间值无害）；**被吞掉的要补发** |
| `cwd` | 仅在路径实际变化时发送 |
| `resize`（client 侧） | 100ms 防抖；**切会话时例外，见 §4.1 `subscribe`** |

**"被吞掉的要补发"不是可选项。** 这两条都是累计量，丢中间值无害 —— 但**丢最后一个值有害**：
输出常常是一阵一阵的，一秒内打完就安静了，后面再没有新消息来触发下一条。只节流不补发，
客户端手里的值就永远停在那一阵之前 —— `head_seq` 停住意味着未读点不亮（AC-4.3），
`in_ack` 停住意味着重发队列清不掉。实现上：节流时记下最新值，由写循环的定时器在窗口
过期后补发。

---

## 7. 错误码

| `code` | 含义 | 是否关闭连接 |
|---|---|---|
| `expected_hello` | 首条消息不是 `hello` | 是 |
| `protocol_unsupported` | 协议版本无法协商 | 是 |
| `bad_frame` | 帧格式非法（长度不足、payload 为空、JSON 解析失败） | 是 |
| `frame_too_large` | 超过 `max_frame_bytes` | 是 |
| `input_gap` | INPUT 帧的 `seq` 大于 `in_ack`，出现空洞 | 是 |
| `input_stalled` | 会话输入队列满（PTY 长时间写不进去，§5.5） | 是 |
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
      "hex": "0100000100000000000000e86869",
      "decoded": { "type": 1, "flags": 0, "sid": 1, "seq": "232", "payload_hex": "6869" },
      "data_len": 2
    },
    {
      "name": "output_attr_prefix",
      "hex": "0101000100000000000000e81b5b306d6869",
      "decoded": { "type": 1, "flags": 1, "sid": 1, "seq": "232", "payload_hex": "1b5b306d6869" },
      "data_len": 2,
      "note": "flags bit0：前 4 字节 ESC[0m 不计入 seq，data_len == 2"
    }
  ],
  "invalid_frames": [
    { "name": "too_short_header", "hex": "010000010000", "expect_error": "bad_frame" },
    { "name": "header_only_empty_payload", "hex": "0100000100000000000000e8", "expect_error": "bad_frame" }
  ],
  "control_messages": [
    { "name": "hello_first_connect", "json": { "t": "hello", "protocol": 1, "client_id": "x", "resume": [] } }
  ],
  "unknown_messages": [
    { "name": "future_type", "json": { "t": "session.split", "sid": 1 }, "note": "接收方必须忽略，不能关连接" }
  ]
}
```

**`seq` 在 fixture 里是字符串。** 它是 `uint64`，而 JS 的 `JSON.parse` 会把超过 2^53 的整数变成浮点丢精度 —— 一份要给两侧共用的 fixture 不能有一边读不准。Go 侧用 `strconv.ParseUint`，TS 侧用 `BigInt(string)`。

`unknown_messages` 用来钉住前向兼容：两侧都必须【忽略】不认识的 `t` 值，而不是当成错误。

必测项见 [`../70-testing/strategy.md`](../70-testing/strategy.md)。最关键的一条是 **AC-2.1 字节级连续性**。
