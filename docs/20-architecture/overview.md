# 架构总览

> 状态：Accepted

## 全景

```
┌──────────────────────────────────────────────────────────┐
│ 浏览器 (PWA)                                              │
│                                                           │
│  ┌────────────┐  ┌───────────────┐  ┌─────────────────┐  │
│  │ 抽屉/标签栏 │  │ xterm.js      │  │ 附加键 /        │  │
│  │ 未读指示    │  │ 只负责显示    │  │ 文本输入页      │  │
│  └────────────┘  └───────────────┘  └─────────────────┘  │
│         └──────────────┬──────────────────┘               │
│                 ┌──────▼───────┐                          │
│                 │ 连接层        │  seq 记账 / 重发队列     │
│                 │ (单个 WS)     │  流式 UTF-8 解码 / 退避  │
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
│  │  *    /api/devices*  → 设备管理 REST                 │ │
│  │  GET  /ws            → WebSocket 升级（认证+Origin）  │ │
│  │  TLS: autocert (生产) | 明文 (--dev)                 │ │
│  └───────────────┬─────────────────────────────────────┘ │
│                  │                                        │
│  ┌───────────────▼─────────────┐   ┌───────────────────┐ │
│  │ Session Manager              │   │ Store (SQLite)     │ │
│  │  sid → Session               │   │  devices           │ │
│  │  上限 / 命名 / 生命周期       │   │  pairings          │ │
│  └───────────────┬─────────────┘   │  settings          │ │
│                  │                  └───────────────────┘ │
│  ┌───────────────▼───────────────────────────────────┐   │
│  │ Session                                           │   │
│  │                                                   │   │
│  │   PTY ──read──┬──> 环形缓冲 (out_seq) ──> 增量     │   │
│  │    ▲          └──> 终端模拟器 (vterm)  ──> 快照    │   │
│  │    │               （同一把锁、同一段字节）         │   │
│  │    └──write── 输入队列 (in_ack)                   │   │
│  │                                                   │   │
│  │   bash -l -i      CWD ← /proc/<前台进程组>/cwd    │   │
│  └───────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

## 关键数据流

### 输出路径（PTY → 浏览器）

```
PTY.Read()
   ↓  原始字节（可能在任意位置被分片），一个字节都不改
锁内 ┬─> 环形缓冲 append       out_seq += len
     └─> 终端模拟器 Write      吃到的字节数 == head_seq；它的查询应答丢弃
   ↓
已订阅的 WS 连接：OUTPUT 帧
   ↓
浏览器：流式 TextDecoder → term.write(字符串)
```

**关键不变式**：`out_seq` = 会话累计的 PTY 输出字节数，agent 不改写输出流；`SNAPSHOT` 帧不计入 `out_seq`（CLAUDE.md 不变式 ④）。见 [ADR-0026](adr/0026-agent-holds-terminal-state.md)。

### 输入路径（浏览器 → PTY）

```
按键 / 附加键 / 文本输入页
   ↓  分配 in_seq（累计字节数）
写入本地重发队列（未 ack 的保留）
   ↓
WS 二进制帧 → agent
   ↓  校验 in_seq 连续性
PTY.Write()
   ↓
in_ack += len  →  ack 控制消息 → client 裁剪重发队列
```

### 续传路径（重连、切回、刷新）

```
client 重连（Cookie 认证）
   ↓  hello{ client_id, instance_id, resume: [{sid, out_seq}, ...] }
agent 对每个会话判断：
   ├─ instance_id 不符                         → gone：agent 重启过，sid 已被重新分配
   ├─ out_seq > 0 且 ∈ [base_seq, head_seq]    → ok：从 out_seq 增量补发原始字节
   └─ 其余（刷新、落出窗口…）                   → snapshot：模拟器导出当前屏 + 至多 2000 行历史
   ↓  welcome{ instance_id, sessions, resumed: [{sid, status, from_seq, in_ack}, ...] }
client 按 in_ack 裁剪重发队列，重发其后的输入
（in_ack 按 (client_id, sid) 记账，跨重连存活 —— 否则重连必然触发 input_gap）
```

切回会话用 `subscribe{out_seq, cols, rows}`，判定相同；列数变了一律走快照（以 agent 的重排为准）。细节见 [`../30-protocol/websocket-protocol.md`](../30-protocol/websocket-protocol.md) §5。

## 分层与目录

```
cmd/webterm/            main、CLI 子命令（serve / pair / devices / doctor / reload / update）
internal/
  agent/                HTTP 路由、TLS、生命周期
  auth/                 配对、设备、Cookie 会话、限速
  session/              Session Manager、Session、PTY、CWD 轮询
  ringbuf/              环形缓冲（序列号、按字节裁剪、切片）
  vterm/                agent 侧终端模拟器（包着 tuios.dev/vt）：写入、改尺寸、快照、导出 / 导入状态
  handoff/              热升级交接的会话快照
  protocol/             消息类型、二进制帧编解码（前后端契约的 Go 侧）
  store/                SQLite schema、迁移、查询
  wsconn/               WebSocket 连接层
  webui/                前端产物的 go:embed 挂载点
web/
  src/
    app/                装配：形态判定、标签栏 / 会话抽屉、连接横幅与提示
    keys/               附加键与文本输入页、keymap、终端直输的 IME 兜底、输入路径计数
    term/               xterm 封装、回放门、手势
    sessions/           会话状态、切换、未读
    conn/               WebSocket 连接层、seq 记账、重发队列、退避
    ui/                 通用组件：浮层、配对页、视口
    protocol/           消息类型、编解码（前后端契约的 TS 侧）
  tests/                Vitest
  e2e/                  Playwright
docs/                   本目录
```

**`internal/protocol` 与 `web/src/protocol` 必须严格对应**，且两者都以 [`../30-protocol/websocket-protocol.md`](../30-protocol/websocket-protocol.md) 为准。任何一侧单独改动视为 bug。

## 并发模型（agent）

每个 Session 四个 goroutine：

| goroutine | 职责 |
|---|---|
| `readLoop` | `PTY.Read()` → 环形缓冲 + 终端模拟器（同锁）→ 广播给订阅者 |
| `writeLoop` | 从输入 channel 取数据 → `PTY.Write()` → 更新 `in_ack` |
| `waitLoop` | `cmd.Wait()`，进程退出后设置 `exited` 状态与退出码 |
| `cwdLoop` | 每秒读一次 `/proc/<前台进程组>/cwd`，变了就更新会话名并广播 |

每个 WebSocket 连接两个 goroutine（读、写）。**读写两侧的队列都有界，且都不阻塞** —— 满了就断开该连接，让它走续传重连。

- 写侧阻塞会反压到 `PTY.Read()`，一个慢客户端就能拖慢服务器上真正在跑的活
- 读侧阻塞更糟：一条连接复用所有会话，一个不读 stdin 的前台程序会把整条连接的读循环卡死（ping、resize、其它会话的输入全停）

`Session.mu` 是读写锁；环形缓冲的追加与模拟器的写入必须在同一把锁下、对同一段字节做，否则快照的 `seq` 与内容对不上，续传也会算错切片。

## 会话与进程生命周期

```
create ──> running ──(shell 退出)──> exited ──(用户关闭)──> 销毁
              │
              └──(用户关闭)──> SIGHUP ──2s──> SIGKILL ──> 销毁
```

`exited` 状态下会话仍保留环形缓冲与模拟器，可查看、可续传、可出快照，但不接受输入。

**agent 进程退出 = 所有会话销毁**（PTY master 关闭 → shell 收到 SIGHUP）。这是已接受的取舍，见 [ADR-0003](adr/0003-no-tmux.md)。

## 决策记录

| ADR | 主题 |
|---|---|
| [0001](adr/0001-agent-first-no-ssh.md) | Agent-first，链路上不用 SSH |
| [0002](adr/0002-self-contained-binary.md) | 自包含单二进制，不依赖外部平台 |
| [0003](adr/0003-no-tmux.md) | 不用 tmux，agent 自持 PTY |
| [0004](adr/0004-acme-only-tls.md) | TLS 只做 ACME 一档 |
| [0005](adr/0005-sqlite-pure-go.md) | 存储用纯 Go SQLite |
| [0006](adr/0006-agent-side-osc-parsing.md) | OSC 由 agent 解析并剥离（已被 0026 取代） |
| [0007](adr/0007-dual-mode-input.md) | 双模输入（Composer / Raw）（已被 0013、0025 取代） |
| [0008](adr/0008-pinned-history-as-snippets.md) | 快捷命令 = 置顶的历史（已被 0025 取代） |
| [0009](adr/0009-hybrid-ws-framing.md) | WebSocket 混合帧（二进制数据 + JSON 控制）（被 0026 修订：新增 SNAPSHOT 帧、删除 ATTR_PREFIX） |
| [0010](adr/0010-bash-rcfile-injection.md) | 通过临时 rcfile 注入 shell 集成（已被 0026 取代） |
| [0011](adr/0011-read-first-layout.md) | 读态优先的三态布局（移动端部分已被 0013 取代） |
| [0012](adr/0012-ai-cli-conversation-first.md) | 面向 claude / codex 的「对话优先」读写（移动端部分已被 0013 取代） |
| [0013](adr/0013-terminal-only.md) | 终端是唯一显示面（§2–§5 已被 0025 取代） |
| [0014](adr/0014-input-toggle.md) | 底栏输入互切键（已被 0025 取代） |
| [0015](adr/0015-bottom-keyrow.md) | 底栏单行键行（已被 0025 取代） |
| [0016](adr/0016-hot-reexec.md) | 热升级：原地 re-exec 交接会话 |
| [0017](adr/0017-numeric-pairing-code.md) | 数字配对码，二维码之外可以手输 |
| [0018](adr/0018-one-drawer-primitive.md) | 次要界面共用一个浮层原语（⋯ 菜单与历史浮层已随 0025 删除，设置与居中浮窗随 0030 删除，又随 0037 回来、改按形态分） |
| [0019](adr/0019-altscreen-redraw-not-replay.md) | 备用屏不回放历史，改为重画（已被 0026 取代） |
| [0020](adr/0020-input-never-silently-dropped.md) | 输入路径绝不静默丢弃 |
| [0021](adr/0021-drag-preview-not-live-relayout.md) | 跟手的手势只做预览，布局改动推到松手（适用对象已随 0025 删除，原则保留） |
| [0022](adr/0022-drop-command-palette.md) | 砍掉命令面板 |
| [0023](adr/0023-terminal-font-list.md) | 终端字体给一份探测过的清单（被 0030 取代） |
| [0024](adr/0024-scrollback-layered-model.md) | 回滚历史的分层模型：先把内容留在追加流里（§2–§4 已被 0026 取代，§1 保留） |
| [0025](adr/0025-termux-style-ui.md) | Termux 式界面：全屏终端 + 两行附加键，会话按设备分两种切换（§3 回车被 0027 修订，§5 纵向拖被 0029 修订，设置被 0030 删除、0037 加回两项，标签宽度被 0031 修订，`+` 被 0035 移出标签条，§3 文本页被 0036 改为跟着会话走） |
| [0026](adr/0026-agent-holds-terminal-state.md) | 输出链路：agent 持有终端状态，浏览器只负责显示 |
| [0027](adr/0027-text-page-enter-submits.md) | 文本输入页：回车 = 发送并提交 |
| [0028](adr/0028-settings-without-notes.md) | 设置面板不写说明文字（面板被 0030 删除） |
| [0029](adr/0029-touch-drag-to-wheel.md) | 触屏纵向拖：程序开了鼠标跟踪时转成滚轮（标定被 0032 去掉） |
| [0030](adr/0030-no-settings.md) | 不要设置：主题跟随系统，字号与字体用默认；会话按钮显示会话数（主题、字号与浮层形态被 0037 取代） |
| [0031](adr/0031-tabs-equal-width.md) | 标签栏：按宽度等分，放不下时横向滚动（`+` 的位置被 0035 修订） |
| [0032](adr/0032-drag-wheel-per-row.md) | 触屏拖动转滚轮：去掉标定，手指每移动一行高发一次 |
| [0033](adr/0033-own-fit.md) | 终端行列自己算，不用 FitAddon（修某些宽度上列数来回翻） |
| [0034](adr/0034-system-service-oom-priority.md) | 以普通用户运行的系统服务：agent 不再先于会话被 OOM 杀掉 |
| [0035](adr/0035-tabbar-new-button-pinned.md) | 标签栏的 `+` 移出滚动条：常驻可见、与标签隔开、与状态点对齐 |
| [0036](adr/0036-text-page-per-session.md) | 文本输入页跟着会话走：每个会话各记页与草稿 |
| [0037](adr/0037-settings-theme-and-font-size.md) | 设置回来，只有主题与终端字号；浮层按形态分；会话抽屉有最小高度与底部留白 |
| [0038](adr/0038-close-confirm-sheet.md) | 关闭确认不用浏览器的 `confirm()`，用自己的浮层；关闭中的会话不再收东西 |
| [0039](adr/0039-drawer-row-swipe-actions.md) | 手机会话列表左滑出按钮；改名用一张小 sheet；浮层跟着可视区走 |
| [0040](adr/0040-session-order-drag.md) | 会话可以拖动排序，顺序存在 agent 上（协议加 `session.move` / `session.order`） |
