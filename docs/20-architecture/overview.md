# 架构总览

> 状态：Accepted

## 全景

```
┌──────────────────────────────────────────────────────────┐
│ 浏览器 (PWA)                                              │
│                                                           │
│  ┌────────────┐  ┌───────────────┐  ┌─────────────────┐  │
│  │ 会话列表    │  │ xterm.js      │  │ Composer /      │  │
│  │ 未读指示    │  │ WebGL 渲染    │  │ 功能键条        │  │
│  └────────────┘  └───────────────┘  └─────────────────┘  │
│         └──────────────┬──────────────────┘               │
│                 ┌──────▼───────┐                          │
│                 │ 连接层        │  seq 记账 / 重发队列     │
│                 │ (单个 WS)     │  指数退避 / 心跳         │
│                 └──────┬───────┘                          │
└────────────────────────┼─────────────────────────────────┘
                         │  WSS  (同源, 单端口)
┌────────────────────────▼─────────────────────────────────┐
│ webterm agent  (单个 Go 二进制)                            │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ HTTP 层                                              │ │
│  │  GET  /              → go:embed 静态资源            │ │
│  │  POST /auth/pair     → 配对                          │ │
│  │  *    /api/*         → 设备/历史/快捷命令 REST        │ │
│  │  GET  /ws            → WebSocket 升级（认证+Origin）  │ │
│  │  TLS: autocert (生产) | 明文 (--dev)                 │ │
│  └───────────────┬─────────────────────────────────────┘ │
│                  │                                        │
│  ┌───────────────▼─────────────┐   ┌───────────────────┐ │
│  │ Session Manager              │   │ Store (SQLite)     │ │
│  │  sid → Session               │   │  devices           │ │
│  │  上限 / 命名 / 生命周期       │   │  pairings          │ │
│  └───────────────┬─────────────┘   │  commands (含pinned)│ │
│                  │                  │  settings          │ │
│  ┌───────────────▼──────────────────┴───────────────┐   │ │
│  │ Session                                           │   │ │
│  │                                                   │   │ │
│  │   PTY ──read──> OSC 剥离器 ──> 环形缓冲 ──> 订阅者 │   │ │
│  │    ▲                 │            (out_seq)       │   │ │
│  │    │                 └──> 控制事件 ──> Store + WS │   │ │
│  │    └──write── 输入队列 (in_ack)                   │   │ │
│  │                                                   │   │ │
│  │   bash --rcfile <生成的集成 rc> -i                 │   │ │
│  └───────────────────────────────────────────────────┘   │ │
└──────────────────────────────────────────────────────────┘
```

## 关键数据流

### 输出路径（PTY → 浏览器）

```
PTY.Read()
   ↓  原始字节（可能在任意位置被分片）
OSC 剥离器（流式状态机）
   ├─→ 剥离后的字节  ────────────────┐
   └─→ 控制事件（命令开始/结束/CWD）   │
         ↓                            ↓
    Store 写入 + WS 控制消息      环形缓冲 append
                                       ↓  out_seq += len
                                  已订阅的 WS 连接
```

**关键不变式**：`out_seq` 在**剥离之后**递增，等于 agent 发给 client 的累计字节数。这保证了续传时按 `out_seq` 切片必然正确。见 [ADR-0006](adr/0006-agent-side-osc-parsing.md)。

### 输入路径（浏览器 → PTY）

```
按键 / Composer 提交
   ↓  分配 in_seq（累计字节数）
写入本地重发队列（未 ack 的保留）
   ↓
WS 二进制帧 → agent
   ↓  校验 in_seq 连续性
PTY.Write()
   ↓
in_ack += len  →  ack 控制消息 → client 裁剪重发队列
```

### 续传路径（重连）

```
client 重连（Cookie 认证）
   ↓  hello{ client_id, instance_id, resume: [{sid, out_seq}, ...] }
agent 对每个会话判断：
   ├─ instance_id 不符               → gone：agent 重启过，sid 已被重新分配
   ├─ out_seq ∈ [base_seq, head_seq]  → 从 out_seq 增量回放
   └─ out_seq <  base_seq             → reset：client 清屏 + 全量重发缓冲
   ↓  welcome{ instance_id, sessions, resumed: [{sid, status, in_ack}, ...] }
client 按 in_ack 裁剪重发队列，重发其后的输入
（in_ack 按 (client_id, sid) 记账，跨重连存活 —— 否则重连必然触发 input_gap）
```

## 分层与目录

```
cmd/webterm/            main、CLI 子命令（serve / pair / devices / shell-init）
internal/
  agent/                HTTP 路由、TLS、生命周期
  auth/                 配对、设备、Cookie 会话、限速
  session/              Session Manager、Session、PTY
  ringbuf/              环形缓冲（序列号、裁剪、切片）
  oscparse/             流式 OSC 状态机（剥离 + 事件）
  protocol/             消息类型、二进制帧编解码（前后端契约的 Go 侧）
  store/                SQLite schema、迁移、查询
  shellinit/            bash 集成脚本（go:embed 的 .bash 模板）
  webui/                前端产物的 go:embed 挂载点
web/
  src/
    conn/               WebSocket 连接层、seq 记账、重发队列、退避
    term/               xterm 封装、渲染、搜索、滚动
    input/              Composer、Raw、IME、keymap、功能键条
    sessions/           会话列表、切换、未读
    commands/           历史、快捷命令
    ui/                 布局、断点、主题
    protocol/           消息类型、编解码（前后端契约的 TS 侧）
  tests/                Vitest
  e2e/                  Playwright
docs/                   本目录
```

**`internal/protocol` 与 `web/src/protocol` 必须严格对应**，且两者都以 [`../30-protocol/websocket-protocol.md`](../30-protocol/websocket-protocol.md) 为准。任何一侧单独改动视为 bug。

## 并发模型（agent）

每个 Session 三个 goroutine：

| goroutine | 职责 |
|---|---|
| `readLoop` | `PTY.Read()` → OSC 剥离 → 环形缓冲 → 广播给订阅者 |
| `writeLoop` | 从输入 channel 取数据 → `PTY.Write()` → 更新 `in_ack` |
| `waitLoop` | `cmd.Wait()`，进程退出后设置 `exited` 状态与退出码 |

每个 WebSocket 连接两个 goroutine（读、写）。**读写两侧的队列都有界，且都不阻塞** —— 满了就断开该连接，让它走续传重连。

- 写侧阻塞会反压到 `PTY.Read()`，一个慢客户端就能拖慢服务器上真正在跑的活
- 读侧阻塞更糟：一条连接复用所有会话，一个不读 stdin 的前台程序会把整条连接的读循环卡死（ping、resize、其它会话的输入全停）

环形缓冲用 `sync.RWMutex`；`out_seq` 与缓冲内容必须在同一把锁下更新，否则续传会算错切片。

## 会话与进程生命周期

```
create ──> running ──(shell 退出)──> exited ──(用户关闭)──> 销毁
              │
              └──(用户关闭)──> SIGHUP ──2s──> SIGKILL ──> 销毁
```

`exited` 状态下会话仍保留环形缓冲，可查看、可续传，但不接受输入。

**agent 进程退出 = 所有会话销毁**（PTY master 关闭 → shell 收到 SIGHUP）。这是已接受的取舍，见 [ADR-0003](adr/0003-no-tmux.md)。

## 决策记录

| ADR | 主题 |
|---|---|
| [0001](adr/0001-agent-first-no-ssh.md) | Agent-first，链路上不用 SSH |
| [0002](adr/0002-self-contained-binary.md) | 自包含单二进制，不依赖外部平台 |
| [0003](adr/0003-no-tmux.md) | 不用 tmux，agent 自持 PTY |
| [0004](adr/0004-acme-only-tls.md) | TLS 只做 ACME 一档 |
| [0005](adr/0005-sqlite-pure-go.md) | 存储用纯 Go SQLite |
| [0006](adr/0006-agent-side-osc-parsing.md) | OSC 由 agent 解析并剥离 |
| [0007](adr/0007-dual-mode-input.md) | 双模输入（Composer / Raw） |
| [0008](adr/0008-pinned-history-as-snippets.md) | 快捷命令 = 置顶的历史 |
| [0009](adr/0009-hybrid-ws-framing.md) | WebSocket 混合帧（二进制数据 + JSON 控制） |
| [0010](adr/0010-bash-rcfile-injection.md) | 通过临时 rcfile 注入 shell 集成 |
| [0011](adr/0011-read-first-layout.md) | 读态优先的三态布局（移动端部分已被 0013 取代） |
| [0012](adr/0012-ai-cli-conversation-first.md) | 面向 claude / codex 的「对话优先」读写（移动端部分已被 0013 取代） |
| [0013](adr/0013-terminal-only.md) | 终端是唯一显示面 |
| [0014](adr/0014-input-toggle.md) | 底栏输入互切键（终端输入 ⇄ 编辑面板） |
| [0015](adr/0015-bottom-keyrow.md) | 底栏单行键行，互切键永远在行首 |
| [0016](adr/0016-hot-reexec.md) | 热升级：原地 re-exec 交接会话 |
| [0017](adr/0017-numeric-pairing-code.md) | 数字配对码，二维码之外可以手输 |
| [0018](adr/0018-one-drawer-primitive.md) | 次要界面共用一个浮层原语 |
| [0019](adr/0019-altscreen-redraw-not-replay.md) | 备用屏不回放历史，改为重画 |
| [0020](adr/0020-input-never-silently-dropped.md) | 输入路径绝不静默丢弃 |
