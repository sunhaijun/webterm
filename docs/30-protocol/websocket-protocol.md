# WebSocket 协议

> 状态：Accepted · 协议版本 `2`（[ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md)）
>
> ★ **这是前后端的唯一契约。** 任何改动必须先改这篇文档，再改代码。不允许一侧先改。
> 实现位置：`internal/protocol`（Go）与 `web/src/protocol`（TS），两者必须严格对应，并对同一组测试向量做单测。

---

## 0. 术语速查

| 名字 | 定义 |
|---|---|
| `sid` | 会话 id，`uint16`，agent 进程内唯一，进程重启后重新分配 |
| `out_seq` | **会话累计的 PTY 输出字节数**中 client 已收到的位置。agent 不改写输出流，一个字节都不剥离 |
| `in_seq` | **client 已发给 agent 的累计字节数**（按会话） |
| `in_ack` | agent 已真正写入 PTY 的累计输入字节数 |
| `base_seq` | 环形缓冲当前保留内容的起始 `out_seq` |
| `head_seq` | 环形缓冲当前的末尾 `out_seq`（= 该会话累计产出字节数） |
| 快照 | agent 侧终端模拟器在某个 `seq` 上的完整状态，序列化成任何 xterm 都能吃的字节（§5.2） |
| `client_id` | 一次页面加载的身份。**输入记账的 key**，见 §5.4 |
| `instance_id` | agent 进程本次启动的随机 id。用于识别"agent 重启过"，见 §5.3 |

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
- 输入侧多连接并发写同一会话是允许的但语义上由用户负责（就像两个人 attach 同一个 tmux）。`in_seq` 按 **`client_id`** 独立记账，见 §5.4

---

## 2. 帧类型

WebSocket 原生的 opcode 就是判别依据，不需要额外的判别字节。

| WebSocket 帧 | 内容 |
|---|---|
| **binary** | 终端数据与快照。12 字节定长头 + 原始负载 |
| **text** | 控制消息。JSON 对象，必有 `t` 字段 |

任何不符合上述格式的帧 → 接收方发 `error{code:"bad_frame"}` 并关闭连接。

---

## 3. 二进制数据帧

### 布局（大端）

```
偏移  长度  字段      类型      说明
────  ────  ────────  ────────  ──────────────────────────────────────
  0     1   type      uint8     0x01 = OUTPUT   (agent→client)
                                0x02 = INPUT    (client→agent)
                                0x03 = SNAPSHOT (agent→client)
  1     1   flags     uint8     bit0 = MORE（仅 SNAPSHOT，见下）
                                其余位保留：发送方填 0，接收方忽略
  2     2   sid       uint16    会话 id
  4     8   seq       uint64    OUTPUT / INPUT：本帧【首字节】的 out_seq / in_seq
                                SNAPSHOT：这份快照对应的 out_seq（见下）
 12     N   payload   bytes     N ≥ 1
```

- 头部固定 12 字节
- `payload` 长度为 0 的帧是非法的 → `error{code:"bad_frame"}`
- 未知 `type`、方向不对的 `type`（client 发来 `OUTPUT` / `SNAPSHOT`，agent 发来 `INPUT`）→ `error{code:"bad_frame"}`
- 单帧 `payload` 上限 **256 KiB**；超出 → `error{code:"frame_too_large"}` 并关闭连接
- **不做任何编码**。`payload` 可以是任意字节序列，包括被切断的多字节 UTF-8 字符 —— client 必须用**流式** UTF-8 解码器接（§5.2）

### OUTPUT 帧（agent → client）

- `payload` 是 PTY 的原始输出，原样转发。分帧边界完全由 agent 的读取时机决定，**没有语义**
- 连续的 OUTPUT 帧对同一 `sid` 必须满足 `seq(n+1) == seq(n) + len(payload(n))`
- client 收到 `seq != 期望值` 时：
  - `seq < 期望` → 重复数据（不应发生），丢弃并记 warning
  - `seq > 期望` → 出现空洞（不应发生），**立即关闭连接并走重连续传**，不要尝试自行修补

### SNAPSHOT 帧（agent → client）

一份快照可以拆成多帧：同一份快照的所有帧 `seq` 相同，**除最后一帧外都置 `flags` bit0（MORE）**。agent 保证一份快照的各帧之间不夹杂同一 `sid` 的其它帧。

- `seq` 是这份快照对应的 `out_seq`：agent 的模拟器恰好吃完了前 `seq` 个字节。之后的 OUTPUT 帧从 `seq` 开始
- `payload`（拼起来之后）是一段**任何 xterm 兼容终端都能吃的字节**：从清空的终端开始画出至多 2000 行历史、当前屏、模式、画笔、滚动区域、字符集、制表位、光标，以及模拟器解析到一半的序列（放在最后，让之后的 OUTPUT 帧把它接完）
- **快照的字节不计入 `out_seq`**。它是 agent 生成的渲染指令，不是流内容
- client 收齐最后一帧后：在写入流里先写 RIS（`ESC c`）复位 → 换一个新的 UTF-8 解码器 → 把快照当作**回放**写入（§5.3 回放门）→ `out_seq = seq`
- **用写入流里的 RIS（`ESC c`）复位，不要调 `term.reset()`**：`reset()` 是同步的，不清写缓冲。列数一变 agent 立刻重发快照，此时还没解析完的旧输出会被画到复位之后、快照之前。RIS 和快照一起进写缓冲，顺序天然正确（xterm 自己在 `reset()` 的注释里也建议这种场合用 RIS）

### INPUT 帧（client → agent）

- client 分配 `in_seq` 并写入本地重发队列
- agent 校验（记账属于 `(client_id, sid)`，不属于连接，见 §5.4）。设 `accepted`
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
  "protocol": 2,
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
| `client_id` | **每次页面加载一个**，client 自己生成、只放内存；跨重连靠同一个连接对象保持不变。是输入记账的 key（§5.4）。**不能存 `sessionStorage`**：刷新后 id 还是那个，agent 记的 `in_ack` 停在刷新前的累计值，新页面的 `in_seq` 却从 0 重新数，开头那几个字节会被当成重发静默丢掉。也不能存 `localStorage`：同源共享，区分不了标签页 |
| `instance_id` | 上次 `welcome` 里拿到的值，首次连接为 `null`。与 agent 当前值不符 → agent 把所有 `resume` 项判为 `gone`（§5.3） |
| `resume` | 想要续传的会话及其输出进度。首次连接为 `[]`。**不带输入进度** —— `in_ack` 由 agent 保管 |

agent 在收到 `hello` 之前收到任何其它帧 → `error{code:"expected_hello"}` 并关闭。

#### `session.create`

```json
{ "t": "session.create", "req_id": "r1", "name": null, "cwd": null, "cols": 80, "rows": 24 }
```

`name`/`cwd` 为 `null` 时用默认值（`cwd` 默认为用户 home）。成功回 `session.created`，失败回 `error`。

**建会话不自动订阅**：client 收到 `session.created` 后自己发 `subscribe{out_seq: 0}`，走快照拿到第一屏。只有这一条路。

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

**只对当前可见的会话订阅。** 未订阅的会话在 agent 侧照常运行、照常喂给模拟器，agent 只在其产生输出时发一条 `session.updated{head_seq}`（做节流，见 §6.2），client 据此自行判定未读。

`subscribe` 携带 `out_seq`，判定与 `resume` 相同（§5.1）：**增量**或**快照**。第一次打开、切回会话都用这个消息，不需要重连。client 手里没有这个会话的内容时（第一次打开、刷新页面）报 `out_seq: 0`。

**`cols` / `rows` 是此刻的终端尺寸**，省略、为 0、或超出 1..1000 表示"沿用会话当前尺寸"。列数变了时，快照发给**该会话的每个订阅者**（不只是这条连接），与 `resize` 相同。**订阅时不要再单发一条 `resize`** —— 尺寸必须和 `subscribe` 在同一条消息里，agent 才能把顺序钉死：

```
锁内: 列数变了 → 模拟器.Resize → 走快照（不管 out_seq）
      否则     → 按 §5.1 判定增量 / 快照；行数变了就 模拟器.Resize
      把要发的帧入队，加入订阅者集合
锁外: 尺寸变了 → TIOCSWINSZ
```

程序因 SIGWINCH 重画的字节因此一定排在快照或增量之后。反过来的话，那批重画字节会进入快照之前的位置，客户端拿不到那一屏。

#### `resize`

```json
{ "t": "resize", "sid": 1, "cols": 100, "rows": 30 }
```

client 侧做 100ms 防抖。agent：

- **列数变了**：锁内 `模拟器.Resize` → 生成快照（`seq` = `head_seq`）→ 发给**该会话的每个订阅者**；锁外 `TIOCSWINSZ`。两边各自重排的结果不一致（[ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) §4），以 agent 的为准
- **只有行数变了**：`模拟器.Resize` + `TIOCSWINSZ`，不发快照

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
  "protocol": 2,
  "server_version": "0.2.0",
  "instance_id": "a91e…",
  "home": "/home/sun",
  "limits": { "max_sessions": 20, "ring_bytes": 262144, "max_frame_bytes": 262144 },
  "sessions": [
    {
      "sid": 1, "name": "webterm", "name_is_manual": false,
      "cwd": "/home/sun/github/webterm",
      "status": "running", "exit_code": null,
      "cols": 80, "rows": 24,
      "base_seq": 221776, "head_seq": 483920,
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
| `ok` | 增量续传 | 不清屏，从 `from_seq`（= 自己的 `out_seq`）接 OUTPUT 帧 |
| `snapshot` | 发快照 | 等 SNAPSHOT 帧（§3）；`from_seq` = 快照的 `seq` |
| `gone` | 该 sid 已不存在（会话已销毁 / `instance_id` 不符） | 移除该会话的 UI，提示"会话已结束" |

`home` 是 agent 用户的家目录，client 用它把 CWD 缩写成 `~`（cwd 等于它或以 `home + "/"` 开头时）。没有这个字段时不缩写。

`resumed[].in_ack` 是 agent 对 **该 `client_id`** 在该会话上已写入 PTY 的累计字节数（§5.4）。**client 必须据此裁剪重发队列，并重发其后的全部输入。**

**未读靠 `head_seq` 推导**，不是服务端状态：`unread = head_seq > 本地 out_seq`。未读天然是 per-client 的，放在服务端会让两个标签页互相清对方的未读。

#### `session.created` / `session.closed` / `session.updated`

```json
{ "t": "session.created", "req_id": "r1", "session": { …同 welcome.sessions[] 的结构… } }
{ "t": "session.closed",  "req_id": "r2", "sid": 1, "exit_code": 0 }
{ "t": "session.updated", "sid": 1, "name": "api", "cwd": "/srv/api", "status": "running", "head_seq": 491337 }
```

- 三条都**广播给该设备的所有连接**（否则 B 标签页看不到 A 新建的会话）。`req_id` 只出现在发起请求的那条连接的副本上
- `session.updated` 只包含**发生变化的字段** + `sid`。client 做增量合并
- `cwd` 来自 agent 每秒读一次 `/proc/<前台进程组>/cwd`，变了才发；`name_is_manual == false` 时 `name` 跟着变（AC-4.4）
- **会话退出**：`session.updated{status:"exited", exit_code, head_seq}` 一定排在该会话**最后一个 OUTPUT 之后**（agent 等 PTY 读到 EOF 再发，最多等 500 ms —— 后台进程占着 PTY 时 EOF 不会来）。`head_seq` 是最终的输出总量：client 的 `out_seq` 追到它，才说明输出收齐了

#### `ack`

```json
{ "t": "ack", "sid": 1, "in_ack": 1352 }
```

agent 写入 PTY 后发送。**做节流**：同一会话最多每 50ms 一条，取最新值（这是累计量，丢中间值无害）。

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

### 5.1 增量还是快照

`hello.resume` 的每一项与每一条 `subscribe`，agent 都做同一个判定：

```
instance_id 不符 / sid 不存在          → gone（仅 hello）
subscribe 带来的列数与会话当前不同      → 快照（先 模拟器.Resize；该会话的其它订阅者也收到这份快照）
out_seq > 0 且 base_seq ≤ out_seq ≤ head_seq → 增量：from_seq = out_seq，发 [out_seq, head_seq) 的原始字节
其余（out_seq == 0、落出窗口、领先于 head）→ 快照：from_seq = 快照的 seq
```

- **增量**是网络抖动、短时切走的常态，字节级连续（AC-2.1）
- **快照**覆盖其余一切：第一次打开、刷新页面、断线太久、切走太久、程序在备用屏、列数变了。没有"按屏分流"，没有"历史输出已截断"
- **判定在锁内，与入队、加入订阅者集合一起完成**。分开做的话，中间到达的一批输出要么被发两遍（重复），要么两边都漏（空洞）

### 5.2 环形缓冲与模拟器

每个会话的 PTY 输出，在**同一把锁里**做两件事：追加进环形缓冲、喂给终端模拟器。所以任何时刻 `模拟器吃到的字节数 == head_seq`，快照的 `seq` 就取那一刻的 `head_seq`。

```
                      base_seq                      head_seq
                          │                             │
输出字节流: ──────────────┼─────────────────────────────┼──────>
            (已被覆盖)    │  环形缓冲（默认 256 KiB）    │
                                                        └── 模拟器的状态恰好对应这里
```

- **环形缓冲**只服务增量这一条路，默认 `ring_bytes` = **256 KiB**（`--ring-bytes`）。按字节裁剪，不找 `\n` 边界：落出窗口的客户端一律走快照，裁剪位置不影响显示
- **模拟器**（`internal/vterm`，tuios.dev/vt）保留 2000 行历史，不管有没有人订阅都喂。它自己生成的查询应答**丢弃** —— 终端查询仍由浏览器的 xterm 回答（§5.3）
- **快照**由模拟器导出：当前屏 + 至多 2000 行历史 + 模式 / 画笔 / 滚动区 / 字符集 / 制表位 / 光标 + 解析到一半的序列。普通内容生成约 0.5 ms（只有当前屏）到 35 ms（满 2000 行，100 列）
- **快照上限 1 MiB**：超过就按比例减少带的历史行数重新生成一次（当前屏与模式不减）。宽终端（几百列）配上每格换色的极端输出，满 2000 行可达数 MiB，会撑爆连接写队列（4 MiB，§5.6）而断开、重连又要快照，形成死循环
- client 侧：**每会话一个流式 UTF-8 解码器**（`TextDecoder` + `stream: true`），把字节解成字符串再写进 xterm。直接写 `Uint8Array` 时，xterm.js 会在某些切法下丢字（第 2 字节为 `0x80` 的三字节字符切在第 2 字节之后，如 `。` `…` `—`），见 [ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) §背景。收到快照时换一个新的解码器

### 5.3 重连续传流程

```
①  client 检测到断开
②  client 保留：每会话的 out_seq、未 ack 的输入队列
③  指数退避重连（0.5s 起，×1.5，上限 15s，±20% 抖动）
    online 事件 / 页面重新可见 → 立即重试一次并重置退避
④  连接建立 → 发 hello{ client_id, instance_id, resume: [{sid, out_seq}, …] }
⑤  agent 对每个 sid 按 §5.1 判定 ok / snapshot / gone
⑥  agent 回 welcome（含 instance_id 与 resumed[].in_ack）
⑦  client：
       status=="gone"   → 移除会话 UI
       按 in_ack 裁剪重发队列 → 重发其后全部输入
⑧  agent 推送：ok → 从 from_seq 起的 OUTPUT 帧；snapshot → SNAPSHOT 帧，随后从它的 seq 起的 OUTPUT 帧
```

**为什么要 `instance_id`**：`sid` 是 `uint16` 且 agent 重启后从头分配。没有实例标识时，一个 `resume{sid:1, out_seq:很大}` 会被当成"领先于 head"，屏幕上留着旧会话的内容，之后接的却是一个**毫不相干的新会话**的输出，用户无从察觉。

**热升级不算重启**（[ADR-0016](../20-architecture/adr/0016-hot-reexec.md)）：agent 原地 re-exec 时把 `instance_id`、每会话的环形缓冲、模拟器状态与 `in_ack` 一并交接给新进程，所以升级后客户端重连仍是增量续传，不是 `gone`。只有真正的进程重启（`SIGTERM`、崩溃）才换 `instance_id`。

**推荐做法**：`resume` 只列可见会话，其它会话在用户切过去时用 `subscribe{out_seq}` 补齐，避免重连瞬间涌入大量数据。

**回放门：补课与快照的字节写进终端时，终端产生的自动应答不进 PTY。** 历史输出里有程序发过的终端查询（DSR / DA / `CSI ?u` …），把这段字节写进 xterm，它会**再答一遍** —— 那不是用户输入，送进 PTY 就是一串乱码键入。client 侧每会话记一个 `catchup_to`：`out_seq` 追到它之前收到的 OUTPUT 都算回放；SNAPSHOT 一律算回放。

| 时机 | `catchup_to` |
|---|---|
| `welcome`，`status == "ok"` | 该会话的 `head_seq` |
| `subscribe`，增量 | 该会话已知的 `head_seq`（由 `session.updated` 维护） |
| 收到 SNAPSHOT | 它的 `seq`（快照之后就是 live） |

**抑制的是自动应答，不是用户的输入。** 两者都从 xterm 的 `onData` 出来，区别在于**谁产生的**：自动应答同步发生在 `term.write()` 的解析里，用户输入同步发生在一次 DOM 输入事件的派发里。client 按来源区分：**正在派发用户输入事件时产生的 `onData` 一律放行**，其余的才受回放门约束（[ADR-0020](../20-architecture/adr/0020-input-never-silently-dropped.md)）。

### 5.4 输入重发队列

client 侧每会话维护：

```
in_seq_next : uint64        下一个要分配的 in_seq
pending     : [{seq, bytes}]  已发送但未被 ack 的输入
```

- 发送时：分配 `seq = in_seq_next`，`in_seq_next += len`，入队 `pending`
- 收到 `ack{in_ack}`：丢弃 `pending` 中 `seq + len <= in_ack` 的项；若某项被部分 ack，裁掉其前部
- 重连后：按 `welcome.resumed[].in_ack` 裁剪，然后**按 seq 升序重发** `pending` 全部内容
- `pending` 上限 **64 KiB**。超出时停止接受新输入并在 UI 上明确提示"离线输入已满"，**不要静默丢弃**

**记账的 key 是 `(client_id, sid)`，不是连接。** 两个标签页各自独立计数（混在一起没有意义），但**同一页面的重连必须继承 `in_ack`**：

- agent 为每个 `(client_id, sid)` 维护 `in_ack`，**保留到会话销毁为止**。刷新一次就多一个 `client_id`，条目数随刷新次数增长；每条是一个 id 加两个 `uint64`，长期运行的会话上也只是 KB 量级，所以不回收 —— 回收之后，那个页面带着 `pending` 重连会被判 `input_gap`
- 该 `client_id` 从未对这个会话发过输入时 `in_ack = 0`，此时 client 侧的 `in_seq_next` 也必然是 0，两侧天然对齐。这一条成立的前提是 `client_id` 每次页面加载都是新的（§4.1）
- 反过来，`seq == 0` 而这个 `(client_id, sid)` 已有记账，说明 client 把计数器重置了却沿用了旧 `client_id`。正常的重连不会出现这个形状：断开时 `accepted` 已回退到 `in_ack`，client 按 `in_ack` 裁剪后从 `seq = in_ack` 重发。agent 仍按重发处理（丢掉重复的部分），但**记一条 Warn**（`sid`、`client`、`accepted`、`len`）—— 这类丢弃在浏览器一侧看不出任何迹象（[ADR-0020](../20-architecture/adr/0020-input-never-silently-dropped.md) 第 5 条）
- 若按连接记账，重连后 `in_ack` 归零而 client 的 `pending` 仍从旧 `seq` 起，agent 会判 `seq > in_ack` → `input_gap` → 关连接 → 无限重连。**断线期间的输入不丢**（US-2.2）整条就废了

**连接断开时，agent 必须丢弃该 `client_id` 已入队但尚未写入 PTY 的输入**，并把
`accepted` 回退到 `in_ack`。这些字节从未被 ack，client 仍持在 `pending` 里，
重连后会重发；不丢的话它们会被写进 PTY 一次、重发时再写一次。回退之后
`accepted == in_ack`，client 按 `in_ack` 重发就精确对齐。

### 5.5 心跳与超时

| 方向 | 规则 |
|---|---|
| client → agent | 每 30 秒发 `ping` |
| agent → client | 收到 `ping` 立即回 `pong` |
| client 判死 | 发出 `ping` 后 10 秒未收到 `pong` → 主动关闭并重连 |
| client 探活 | `online` 事件 / 页面重新可见时**立刻**发一次 `ping`，**2 秒**未收到 `pong` → 关闭并重连 |
| agent 判死 | 60 秒未收到任何帧 → 关闭连接 |

`ping`/`pong` 不影响 `out_seq`/`in_seq`。探活复用同一对消息，**agent 侧不需要任何改动**。

**为什么要单独一条探活规则。** 线路断掉不一定有 `onclose`：手机息屏、切 App、Wi-Fi 切蜂窝、NAT / 反向代理静默回收连接，这些场合 TCP 上没有 FIN，浏览器那边 `readyState` 一直是 OPEN。这种**僵尸连接**自认在线，唯一的暴露渠道就是心跳，最坏 30 + 10 = 40 秒 —— 而 `setInterval` 在后台标签页还会被节流，实际更久。这 40 秒里用户打的字全都写进一条死 socket，屏幕上毫无变化。

`online` 与"页面重新可见"是**已知的可疑时刻**：系统刚说网络变了、或者用户刚把应用切回前台。此时连接要么是活的（本机 RTT 远小于 2 秒），要么就是死的，所以探针用 2 秒而不是心跳的 10 秒。判错的代价只是多一次重连，而重连是无损的（§5.3 续传 + §5.4 按 `in_ack` 重发）。

理由与取舍见 [ADR-0020](../20-architecture/adr/0020-input-never-silently-dropped.md)。

### 5.6 有界队列策略（读写两侧）

| 队列 | 上限 | 满了怎么办 |
|---|---|---|
| 连接写队列（输出 → client） | 4 MiB（常量） | 关闭该连接 |
| 会话输入队列（client → PTY） | 256 KiB | 回 `error{code:"input_stalled", sid}` 并关闭该连接 |

**两侧都绝不阻塞。** 写侧阻塞会反压到 `PTY.Read()` 卡住 shell —— 一个慢客户端不能拖慢服务器上真正在跑的活。读侧阻塞更糟：**一条 WebSocket 复用所有会话**，一个不读 stdin 的前台程序（`sleep`、某些 TUI）会把 PTY 输入缓冲填满，进而卡住整条连接的读循环 —— ping/pong、`resize`、`session.create`、其它会话的输入全停。

关连接是无损的：client 自动重连走续传，输出走增量或快照、输入按 `in_ack`（§5.4）重发即可。

---

## 6. 状态与节流

### 6.1 会话状态机

```
（不存在）──session.create──> running ──shell 退出──> exited ──session.close──> （销毁）
                                 │
                                 └──session.close──> SIGHUP ─2s─> SIGKILL ──> （销毁）
```

`exited` 会话：保留缓冲、可续传、可查看，**不接受输入**。

### 6.2 节流规则汇总

| 消息 | 节流 |
|---|---|
| `ack` | 每会话最多 50ms 一条，取最新累计值；**被吞掉的要补发** |
| `session.updated{head_seq}` | 每会话最多 1s 一条（client 只用它判未读，中间值无害）；**被吞掉的要补发** |
| `session.updated{cwd}` | agent 每秒读一次，仅在路径实际变化时发送 |
| `resize`（client 侧） | 100ms 防抖；**订阅时例外，见 §4.1 `subscribe`** |

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
| `bad_frame` | 帧格式非法（长度不足、payload 为空、未知 `type`、方向不对的 `type`、JSON 解析失败） | 是 |
| `frame_too_large` | 超过 `max_frame_bytes` | 是 |
| `input_gap` | INPUT 帧的 `seq` 大于 agent 已接受的累计字节数（`accepted`，§3），出现空洞 | 是 |
| `input_stalled` | 会话输入队列满（PTY 长时间写不进去，§5.6） | 是 |
| `unauthorized` | 设备已被吊销 | 是（先发 `notice`） |
| `unknown_session` | `sid` 不存在 | 否 |
| `session_exited` | 向已退出的会话写输入 | 否 |
| `session_limit` | 会话数达上限 | 否 |
| `bad_request` | 参数非法（如 `cols <= 0`） | 否 |
| `internal` | agent 内部错误 | 视情况 |

---

## 8. 协议版本演进

- `protocol` 为整数，当前 `2`
- **可以自由添加**：新的控制消息类型、已有消息的新字段。接收方忽略未知 `t` 和未知字段
- **必须升版本**：二进制帧布局变更、已有字段语义变更、删除字段
- 版本不匹配时 agent 回 `error{code:"protocol_unsupported"}` 并在 `message` 里写清双方版本，client 展示"agent 已升级，请刷新页面"

| 版本 | 变化 |
|---|---|
| 1 | 初版 |
| 2 | [ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md)：新增 `SNAPSHOT` 帧与 `resumed[].status: "snapshot"`；删除 `ATTR_PREFIX`、`reset`、`redraw`、`cwd`、`prompt`、`command.start` / `command.end`、会话字段 `integration` / `prompt_state` / `unmarked_input`；`out_seq` 不再剥离 OSC |

---

## 9. 测试向量

`internal/protocol/testdata/vectors.json` 是前后端共用的 fixture，两侧单测都必须跑它（防止实现漂移）。格式：

```json
{
  "binary_frames": [
    {
      "name": "output_basic",
      "hex": "0100000100000000000000e86869",
      "decoded": { "type": 1, "flags": 0, "sid": 1, "seq": "232", "payload_hex": "6869" }
    },
    {
      "name": "snapshot_more",
      "hex": "0301000100000000000000e81b5b48",
      "decoded": { "type": 3, "flags": 1, "sid": 1, "seq": "232", "payload_hex": "1b5b48" },
      "note": "flags bit0 = MORE：同一份快照后面还有帧"
    }
  ],
  "invalid_frames": [
    { "name": "too_short_header", "hex": "010000010000", "expect_error": "bad_frame" },
    { "name": "header_only_empty_payload", "hex": "0100000100000000000000e8", "expect_error": "bad_frame" },
    { "name": "unknown_type", "hex": "0400000100000000000000e86869", "expect_error": "bad_frame" }
  ],
  "control_messages": [
    { "name": "hello_first_connect", "json": { "t": "hello", "protocol": 2, "client_id": "x", "resume": [] } }
  ],
  "unknown_messages": [
    { "name": "future_type", "json": { "t": "session.split", "sid": 1 }, "note": "接收方必须忽略，不能关连接" }
  ]
}
```

`binary_frames[].data_len` 是该帧**计入 seq 的字节数**：OUTPUT / INPUT 等于 payload 长度，SNAPSHOT 为 0（快照不计入 seq）。两侧都要逐帧校验它。

**`seq` 在 fixture 里是字符串。** 它是 `uint64`，而 JS 的 `JSON.parse` 会把超过 2^53 的整数变成浮点丢精度 —— 一份要给两侧共用的 fixture 不能有一边读不准。Go 侧用 `strconv.ParseUint`，TS 侧用 `BigInt(string)`。

`unknown_messages` 用来钉住前向兼容：两侧都必须【忽略】不认识的 `t` 值，而不是当成错误。

必测项见 [`../70-testing/strategy.md`](../70-testing/strategy.md)。最关键的两条是 **AC-2.1 字节级连续性**（增量）与 **AC-2.21 屏幕级一致性**（快照）。
