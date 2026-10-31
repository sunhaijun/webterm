# 隐私

> 状态：Accepted

webterm 不记命令历史（[ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) 已整体删除），不存终端输出。这篇定义边界。

## 铁律：终端输出不落盘

**终端输出只在内存里：每会话的环形缓冲与终端模拟器。任何情况下都不写入磁盘，浏览器也不存。**

为什么：终端输出里有

- `cat .env`、`env`、`kubectl get secret -o yaml` 的结果
- 日志里的 token、session id、连接字符串
- `git push` 时打印的 URL（可能含 token）
- AI agent 的对话内容

这些东西一旦落盘就成了长期的泄露面。所以选择：**要么在内存里，要么不存在。**

对应不变式（[CLAUDE.md](../../CLAUDE.md)）：`3. 输出不落盘`。
验证：`IT-privacy-1` 跑一个会话输出特征字符串 `WEBTERM_CANARY_<随机>`，然后 grep 整个数据目录 + 日志，断言零命中。

### 后果

- **agent 重启后看不到之前的输出**。这是 [ADR-0003](../20-architecture/adr/0003-no-tmux.md) 会话不持久化的必然结果，两件事互相印证。
- **热升级不算重启**：模拟器状态经内存文件交给新进程（[ADR-0016](../20-architecture/adr/0016-hot-reexec.md)），不经过磁盘。
- **刷新页面后的回看来自 agent 的快照**（至多 2000 行），浏览器本地不留任何终端内容。
- 没有"会话录像"功能。如果将来要做，必须是显式开关 + 明确的界面告知 + 独立的文件权限，且默认关闭。

## 落盘的是什么

`webterm.db` 里只有设备与配对（token 与配对码只存哈希）、设置项（[storage-schema.md](../50-backend/storage-schema.md)）。不存命令原文、不存 CWD、不存输出。

## 日志（AC-8.5）

agent 的日志**不得包含**：

- 配对码（任何形式，包括前缀）
- 会话 Cookie token
- 用户的输入（INPUT 帧的内容）
- 终端输出

**可以包含**（刻意保留）：

- IP 与 User-Agent —— 设备列表和限速需要
- 会话 sid、字节计数、seq —— 排障必需
- 错误码与堆栈

日志级别默认 `info`。`--log-level debug` 会输出更多协议细节，但**仍然不输出上面禁止的内容** —— debug 模式不是安全旁路。

## 数据目录权限

```
$XDG_DATA_HOME/webterm/    0700
├── webterm.db             0600
├── certs/                 0700
└── run/                   0700   （控制 socket agent.sock 0600）
```

同机的其它本地用户不在信任边界内（[`threat-model.md`](threat-model.md#信任边界)）。

## 备份的责任在用户

webterm 不做自动备份。`webterm.db` 是单文件，用户可以自己 `cp`（建议先 `sqlite3 webterm.db ".backup"` 或停服，避免 WAL 状态不一致）。里面只有设备与配对的哈希，丢了的代价是所有设备重新配对一次。
