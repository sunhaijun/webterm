# ADR-0005 存储用纯 Go SQLite

> 状态：Accepted · 2026-09-06

## 背景

需求引入了命令历史（含搜索）、快捷命令、设备授权之后，需要一个持久化层。

## 决策

**用 `modernc.org/sqlite`（纯 Go 实现的 SQLite，无 cgo）。**

数据库文件：`~/.local/share/webterm/webterm.db`，权限 `0600`。

## 备选方案与否决理由

### A. JSON 文件

**否决**：
- 命令历史会长到几万条，需要按子串、按 CWD、按时间过滤并分页 —— JSON 要全量载入内存再过滤
- 并发写需要自己做文件锁和原子替换
- 没有事务，崩溃时容易半写

### B. `mattn/go-sqlite3`（cgo 绑定）

性能更好、更成熟。

**否决**：需要 cgo，会破坏"单二进制交叉编译"这条不变式（`GOOS=linux GOARCH=amd64 go build` 必须直接出货，`ldd` 必须显示 not a dynamic executable，见 AC-8.1）。这条不变式的价值大于性能差异 —— 我们的写入量是每分钟几条命令记录，性能完全不是瓶颈。

### C. BoltDB / bbolt（纯 Go KV）

无 cgo，简单。

**否决**：KV 存储做"按子串搜索 + 按多字段过滤 + 分页"要自己建索引，等于自己写半个查询引擎。

### D. `modernc.org/sqlite`（采纳）

纯 Go，无 cgo，支持完整 SQL 和事务。代价是二进制体积增加约 10MB、性能低于 cgo 版 —— 在本项目的负载下都无关紧要。

## 数据模型要点

完整 schema 见 [`../../50-backend/storage-schema.md`](../../50-backend/storage-schema.md)。几个决策：

### 会话本身不持久化

会话随 agent 进程消亡（[ADR-0003](0003-no-tmux.md)），所以 `sessions` 表**不存在**。命令记录里存 `session_name`（字符串快照）而不是外键，避免孤儿行和无意义的 join。

### 终端输出不落盘

只存命令元数据。环形缓冲纯内存。见 [`../../60-security/privacy-history.md`](../../60-security/privacy-history.md)。

### 快捷命令不是独立表

`commands` 表上的 `pinned` 布尔字段。见 [ADR-0008](0008-pinned-history-as-snippets.md)。

### v0.1 不用 FTS5

`modernc.org/sqlite` 支持 FTS5，但几万行历史用 `text LIKE '%x%'` 查询是毫秒级。先用 `LIKE`，等真的慢了再加 FTS5 虚拟表 —— 那是个纯增量改动。

## 实现要点

- 单连接 + `sync.Mutex`（写）：SQLite 在 WAL 模式下支持并发读，但 `modernc.org` 驱动下最简单可靠的做法是串行化写。负载完全允许。
- `PRAGMA journal_mode=WAL`、`PRAGMA synchronous=NORMAL`、`PRAGMA foreign_keys=ON`
- schema 版本号存 `settings` 表，启动时执行幂等迁移（顺序 `.sql` 脚本 `go:embed` 进二进制）
- 打开数据库前用 `os.OpenFile(..., 0600)` 创建，确保权限（SQLite 自己创建时受 umask 影响）
- 数据目录遵循 XDG：`$XDG_DATA_HOME/webterm/` 否则 `~/.local/share/webterm/`，可用 `--data-dir` 覆盖
