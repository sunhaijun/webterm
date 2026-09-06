# 存储模型

> 状态：Accepted
>
> 技术选型见 [ADR-0005](../20-architecture/adr/0005-sqlite-pure-go.md)：`modernc.org/sqlite`，纯 Go 无 cgo。

## 位置与权限

```
$XDG_DATA_HOME/webterm/          （否则 ~/.local/share/webterm/）
├── webterm.db          0600     SQLite 主库
├── webterm.db-wal      0600
├── webterm.db-shm      0600
├── certs/              0700     autocert 缓存
└── run/                0700     临时 rcfile（会话结束即删）
```

可用 `--data-dir` 覆盖。

**必须用 `os.OpenFile(path, O_CREATE, 0600)` 预创建 db 文件**，因为 SQLite 自己创建时会受 umask 影响，可能得到 0644（AC-1.12）。

## PRAGMA

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

## Schema

### `settings`

```sql
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- schema_version 存在这里，启动时读它决定跑哪些迁移
```

### `devices`

```sql
CREATE TABLE devices (
    id           TEXT PRIMARY KEY,      -- 随机 16 字节 hex
    name         TEXT NOT NULL,         -- 从 User-Agent 推断，可改
    token_hash   BLOB NOT NULL,         -- SHA-256(session token)，不存原文
    created_at   INTEGER NOT NULL,      -- unix ms
    last_seen_at INTEGER NOT NULL,
    last_ip      TEXT,
    revoked_at   INTEGER                -- NULL = 有效
);
CREATE UNIQUE INDEX idx_devices_token ON devices(token_hash);
CREATE INDEX idx_devices_active ON devices(revoked_at) WHERE revoked_at IS NULL;
```

**只存 token 的哈希**（AC-1.10）。库泄露时攻击者拿不到可用的 Cookie。

`last_seen_at` / `last_ip` 的更新做节流（每设备最多 60 秒写一次），避免每个请求都写库。

### `pairings`

```sql
CREATE TABLE pairings (
    code_hash  BLOB PRIMARY KEY,        -- SHA-256(配对码)
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,        -- created_at + 5 分钟
    used_at    INTEGER                  -- NULL = 未使用
);
```

同样只存哈希。校验时用 `subtle.ConstantTimeCompare`（AC-1.4）。

过期记录由启动时和每小时的清理任务删除。

### `commands`

```sql
CREATE TABLE commands (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    text         TEXT    NOT NULL,
    session_name TEXT,                  -- 快照，非外键（会话不持久化）
    cwd          TEXT,
    exit_code    INTEGER,               -- NULL = 未完成 或 手动新建的快捷命令
    started_at   INTEGER NOT NULL,      -- unix ms
    duration_ms  INTEGER,               -- NULL 同上
    pinned       INTEGER NOT NULL DEFAULT 0,   -- 1 = 快捷命令
    label        TEXT,                  -- 快捷命令的短名
    pin_order    INTEGER                -- 置顶排序，非置顶为 NULL
);

CREATE INDEX idx_cmd_started  ON commands(started_at DESC);
CREATE INDEX idx_cmd_pinned   ON commands(pin_order) WHERE pinned = 1;
CREATE INDEX idx_cmd_cwd      ON commands(cwd, started_at DESC);
```

**一张表承载历史和快捷命令**（[ADR-0008](../20-architecture/adr/0008-pinned-history-as-snippets.md)）。

`session_name` 是**字符串快照**不是外键 —— 会话不持久化（[ADR-0005](../20-architecture/adr/0005-sqlite-pure-go.md)），存 sid 或外键都会立刻变成孤儿。

## 查询

### 历史列表（AC-6.3）

```sql
SELECT * FROM commands
WHERE (:q      IS NULL OR text LIKE '%' || :q || '%')
  AND (:cwd    IS NULL OR cwd = :cwd)
  AND (:failed = 0     OR (exit_code IS NOT NULL AND exit_code != 0))
ORDER BY started_at DESC
LIMIT :limit OFFSET :offset;
```

**v0.1 用 `LIKE` 不用 FTS5。** 5 万行的 `LIKE '%x%'` 是毫秒级。等真的慢了再加 FTS5 虚拟表 —— 那是纯增量改动。

### 快捷命令列表

```sql
SELECT * FROM commands WHERE pinned = 1 ORDER BY pin_order ASC;
```

### Composer 的历史导航（前缀匹配）

```sql
SELECT DISTINCT text FROM commands
WHERE text LIKE :prefix || '%'
ORDER BY started_at DESC LIMIT 50;
```

`DISTINCT` 很重要 —— 否则连按 `↑` 会翻到同一条命令十几次。

### 命令面板（去重 + 时间衰减）

```sql
SELECT text, MAX(started_at) AS last_at, MAX(pinned) AS pinned
FROM commands
WHERE text LIKE '%' || :q || '%'
GROUP BY text
ORDER BY pinned DESC, last_at DESC
LIMIT 200;
```

模糊匹配的打分在 Go 侧（或前端）做，SQL 只负责粗筛。

## 写入路径

命令记录分两次写（对应 `133;C` 和 `133;D`）：

```
133;C  →  INSERT INTO commands (text, session_name, cwd, started_at, pinned)
          VALUES (?, ?, ?, ?, 0)                      → 得到 cmd_id
133;D  →  UPDATE commands SET exit_code = ?, duration_ms = ?
          WHERE id = ?
```

shell 在 `133;D` 之前死掉 → 该行的 `exit_code` / `duration_ms` 永久为 NULL。查询时按"未完成"展示（UI 显示 `—`）。这是可接受的：知道"我跑了什么"比知道"结果如何"更重要。

## 淘汰（AC-6.10）

每小时一次，以及每 1000 条插入后触发一次：

```sql
DELETE FROM commands
WHERE pinned = 0
  AND id NOT IN (
      SELECT id FROM commands WHERE pinned = 0
      ORDER BY started_at DESC LIMIT :max_history
  );
```

`max_history` 默认 50000，`--max-history` 可配。

**置顶记录永不淘汰** —— 这是 [ADR-0008](../20-architecture/adr/0008-pinned-history-as-snippets.md) 的直接要求，因为快捷命令的生命周期跟历史行绑定。

淘汰后周期性 `PRAGMA incremental_vacuum`（或每月一次 `VACUUM`），避免文件无限增长。

## 迁移

```
internal/store/migrations/
  0001_init.sql
  0002_….sql
```

`go:embed` 进二进制。启动时读 `settings.schema_version`，顺序执行未应用的脚本，每个脚本在一个事务里，成功后更新版本号。

规则：

- **迁移脚本一旦发布不再修改**，只追加新脚本
- 每个脚本必须幂等友好（用 `CREATE TABLE IF NOT EXISTS` 等），以容忍中断后重跑
- 不做降级迁移。回滚旧版本 agent 的做法是从备份恢复

## 并发

单个 `*sql.DB`，`SetMaxOpenConns(1)` + 应用层 `sync.Mutex` 保护写。

WAL 模式下 SQLite 支持并发读，但在本项目的负载（每分钟几条命令记录 + 偶尔的历史查询）下，串行化是最简单可靠的选择。**不要为了性能引入连接池的复杂度** —— 这里永远不会是瓶颈。

## 隐私（AC-8.4）

**这个库里绝对不能出现终端输出内容。** 存的只有：

- 命令原文（用户主动输入的）
- CWD、退出码、耗时、时间戳
- 设备与配对的哈希

见 [`../60-security/privacy-history.md`](../60-security/privacy-history.md)。

`IT-privacy-1` 的做法：跑一个会话输出一个特征字符串（如 `WEBTERM_CANARY_9f3a`），然后 grep 整个数据目录，断言零命中。
