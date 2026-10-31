# 术语表

> 状态：Accepted

文档和代码里统一使用这些术语，不要造同义词。

## 组件

| 术语 | 含义 |
|---|---|
| **agent** | 跑在目标服务器上的 webterm 单二进制。同时提供静态资源、认证、WebSocket 终端流和会话管理。文档里说"服务端"就是指它。 |
| **client** | 浏览器里的 SPA。由 agent 通过 `go:embed` 提供。 |
| **终端模拟器（agent 侧）** | agent 给每个会话跑的一个终端模拟器（`internal/vterm`，包着 tuios.dev/vt），吃全部 PTY 输出，随时能导出快照。浏览器里的 xterm.js 只负责显示（[ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md)）。 |

## 会话与数据流

| 术语 | 含义 |
|---|---|
| **session（会话）** | agent 侧的一个 PTY + 它上面跑的 shell 进程 + 它的输出环形缓冲 + 它的终端模拟器。**注意**：会话不跨 agent 重启存活。 |
| **sid** | session id，`uint16`，agent 进程内唯一，重启后从头分配。 |
| **ring buffer（环形缓冲）** | 每个会话在内存里保留的最近 N 字节原始输出（默认 256 KiB），只用于增量续传。只在内存，不落盘。 |
| **out_seq** | 输出序列号 = 会话累计的 PTY 输出字节数中 client 已收到的位置。不是消息计数。agent 不改写输出流。 |
| **in_seq** | 输入序列号 = **client 已发给 agent 的累计字节数**（该会话）。 |
| **in_ack** | agent 已经真正写进 PTY 的累计输入字节数。按 `(client_id, sid)` 记账、跨重连存活。client 靠它决定重发队列裁到哪里。 |
| **base_seq** | 环形缓冲当前保留内容的起始 `out_seq`。client 的 `out_seq < base_seq` 时增量补不上，改发快照。 |
| **增量**（续传） | client 报上来的 `out_seq` 还在环形缓冲窗口内，agent 原样补发其后的字节。字节级连续（AC-2.1）。 |
| **快照**（snapshot） | agent 侧终端模拟器在某个 `seq` 上的完整画面：当前屏 + 至多 2000 行历史 + 模式 / 画笔 / 光标等，序列化成任何 xterm 都能吃的字节，走 `SNAPSHOT` 帧。第一次打开、刷新、落出窗口、改列数都走它。不计入 `out_seq`。 |
| **subscribe（订阅）** | client 只对**当前可见**的会话订阅实时输出。未订阅的会话在 agent 侧照常运行、照常喂给模拟器，切回去时走增量或快照。 |
| **client_id** | 一次页面加载的身份，只放内存：跨重连不变，刷新就换。输入记账的 key。 |
| **instance_id** | agent 进程本次启动的随机 id。用来识别"agent 重启过"，因为 `sid` 重启后会被重新分配。 |

## 界面

| 术语 | 含义 |
|---|---|
| **形态**（form） | 按设备分的两种界面：`compact`（手机，屏幕短边 < 600px）与 `wide`（PC、Pad）。只决定会话怎么切换，一台设备上永不翻转（[ADR-0025](../20-architecture/adr/0025-termux-style-ui.md)）。 |
| **会话抽屉** | `compact` 上点附加键左列的 ☰ 升起的底部抽屉：会话列表 + 「新会话 · 设置」。 |
| **标签栏** | `wide` 上终端顶部常驻的一排会话标签，后面跟 `+`，最右是连接状态点与 ⚙。 |

## 输入

| 术语 | 含义 |
|---|---|
| **终端直输** | 点终端打字，按键与输入法结果逐个直送 PTY。组字期间不发，`compositionend` 时一次性提交（AC-3.3）。 |
| **附加键**（extra keys） | 触屏上终端下方两行固定的按键，Termux 的默认键位：`ESC / - HOME ↑ END PGUP` / `TAB CTRL ALT ← ↓ → PGDN`。不随前台程序变。`CTRL` / `ALT` 粘滞。 |
| **文本输入页** | 附加键区的第二页：一个原生 `textarea`，输入法完全原生。回车 = 有内容发内容并回车、空着发 `\r`。点 ✎ 或在键区左右滑动切换。 |

## 认证

| 术语 | 含义 |
|---|---|
| **配对码**（pairing code） | 一次性、5 分钟有效的高熵字符串。agent 启动或执行 `webterm pair` 时生成，以 URL 片段 + 终端二维码的形式给出。 |
| **device（设备）** | 一次成功配对产生的一条记录。持有一个长效会话 Cookie。可在 UI 里单独吊销。 |
