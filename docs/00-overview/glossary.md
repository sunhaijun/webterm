# 术语表

> 状态：Accepted

文档和代码里统一使用这些术语，不要造同义词。

## 组件

| 术语 | 含义 |
|---|---|
| **agent** | 跑在目标服务器上的 webterm 单二进制。同时提供静态资源、认证、WebSocket 终端流和会话管理。文档里说"服务端"就是指它。 |
| **client** | 浏览器里的 SPA。由 agent 通过 `go:embed` 提供。 |
| **shell 集成**（shell integration） | 注入到 bash 的一组钩子，通过 OSC 转义序列向 agent 上报命令原文、退出码、CWD、prompt 状态。见 [`../30-protocol/shell-integration.md`](../30-protocol/shell-integration.md)。 |

## 会话与数据流

| 术语 | 含义 |
|---|---|
| **session（会话）** | agent 侧的一个 PTY + 它上面跑的 shell 进程 + 它的输出环形缓冲。**注意**：会话不跨 agent 重启存活。 |
| **sid** | session id，`uint16`，agent 进程内唯一，重启后从头分配。 |
| **ring buffer（环形缓冲）** | 每个会话在内存里保留的最近 N 字节输出，用于断线后的增量回放。只在内存，不落盘。 |
| **out_seq** | 输出序列号 = **agent 已发给 client 的累计字节数**（该会话）。不是消息计数。剥离 OSC 之后再计数。 |
| **in_seq** | 输入序列号 = **client 已发给 agent 的累计字节数**（该会话）。 |
| **in_ack** | agent 已经真正写进 PTY 的累计输入字节数。按 `(client_id, sid)` 记账、跨重连存活。client 靠它决定重发队列裁到哪里。 |
| **base_seq** | 环形缓冲当前保留内容的起始 `out_seq`。client 的 `out_seq < base_seq` 时说明缓冲已覆盖，触发 reset。 |
| **resume（续传）** | 重连时 client 上报各会话的 `out_seq` / `in_seq`，agent 只回放缺失的增量。 |
| **reset（重置）** | 断开太久、缓冲被覆盖，无法续传。client 清屏，agent 把缓冲里现存的全部内容重发。 |
| **subscribe（订阅）** | client 只对**当前可见**的会话订阅实时输出。未订阅的会话在 agent 侧照常运行和缓冲，切回去时走 resume 补齐。 |
| **client_id** | 一个浏览器标签页的身份，存 `sessionStorage`，跨重连稳定。输入记账的 key。 |
| **instance_id** | agent 进程本次启动的随机 id。用来识别"agent 重启过"，因为 `sid` 重启后会被重新分配。 |

## 输入

| 术语 | 含义 |
|---|---|
| **Composer 模式** | 默认模式。终端区只读，底部是独立的多行输入框。IME 组字完全发生在原生 `textarea` 里。提交时整行写入 PTY。 |
| **Raw 模式** | 按键直通 PTY，用于 vim / htop 这类前台 TUI 程序。IME 组字期间只在 `compositionend` 时提交。 |
| **模式自动切换** | 依据 shell 集成的 prompt 状态：停在 prompt 等输入 → Composer；有命令在跑 → Raw。用户可手动覆盖。 |
| **功能键条**（key bar） | 移动端软键盘上方的一排按钮：`Esc` `Tab` `Ctrl` `Alt` `↑↓←→` `\|` `~` `/` `-` 等。 |

## 命令

| 术语 | 含义 |
|---|---|
| **command（命令记录）** | 一条执行过的命令：原文、CWD、退出码、开始时间、耗时、所属会话。由 shell 集成上报，存 SQLite。 |
| **pinned（置顶）** | 命令记录上的一个布尔标记。置顶的命令就是**快捷命令**，没有单独的实体。 |
| **快捷命令**（quick command） | `pinned = true` 的命令记录。点击 = 填入 Composer 待编辑。 |

## 认证

| 术语 | 含义 |
|---|---|
| **配对码**（pairing code） | 一次性、5 分钟有效的高熵字符串。agent 启动或执行 `webterm pair` 时生成，以 URL 片段 + 终端二维码的形式给出。 |
| **device（设备）** | 一次成功配对产生的一条记录。持有一个长效会话 Cookie。可在 UI 里单独吊销。 |

## OSC

| 术语 | 含义 |
|---|---|
| **OSC** | Operating System Command，形如 `ESC ] <参数> ST` 的终端转义序列。 |
| **OSC 133** | 半标准的 prompt 标记序列（A=prompt 开始，B=输入开始，C=命令开始执行，D=命令结束+退出码）。 |
| **OSC 7** | 半标准的 CWD 上报，负载是 `file://<host><path>`。 |
| **OSC 1701** | webterm 私有命名空间，用于标准序列覆盖不到的信息（集成握手、命令原文）。 |
