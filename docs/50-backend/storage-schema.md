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
└── run/                0700     控制 socket agent.sock（热升级用）
```

可用 `--data-dir` 覆盖。

**必须用 `os.OpenFile(path, O_CREATE, 0600)` 预创建 db 文件**，因为 SQLite 自己创建时会受 umask 影响，可能得到 0644（AC-1.12）。

## PRAGMA

```sql
PRAGMA journal_mode  = WAL;
PRAGMA synchronous   = NORMAL;
PRAGMA foreign_keys  = ON;
PRAGMA busy_timeout  = 5000;
PRAGMA auto_vacuum   = INCREMENTAL;   -- 必须在建第一张表之前设，否则无效
```

`auto_vacuum` 只在建库时能设定，事后改要整库 `VACUUM` 才生效 —— 所以它必须出现在 `0001_init.sql` 的最前面，否则后面的 `incremental_vacuum` 是空操作。

## Schema

### `settings`

```sql
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- schema_version 存在这里，启动时读它决定跑哪些迁移。
-- 只为命令历史服务的 history_enabled 由 0003 删除
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

## 迁移

```
internal/store/migrations/
  0001_init.sql
  0002_pairing_digits.sql
  0003_drop_commands.sql      DROP TABLE IF EXISTS commands;
                              DELETE FROM settings WHERE key = 'history_enabled';
```

`0003` 随 [ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md) 删除命令历史：老库升级后不再留着用户的命令原文。删完跑一次 `PRAGMA incremental_vacuum` 把页还给文件系统。

`go:embed` 进二进制。启动时读 `settings.schema_version`，顺序执行未应用的脚本，每个脚本在一个事务里，成功后更新版本号。

规则：

- **迁移脚本一旦发布不再修改**，只追加新脚本
- 每个脚本必须幂等友好（用 `CREATE TABLE IF NOT EXISTS` 等），以容忍中断后重跑
- 不做降级迁移。回滚旧版本 agent 的做法是从备份恢复

## 并发

单个 `*sql.DB`，`SetMaxOpenConns(1)` + 应用层 `sync.Mutex` 保护写。

WAL 模式下 SQLite 支持并发读，但在本项目的负载（配对、设备校验与 `last_seen_at` 的节流更新）下，串行化是最简单可靠的选择。**不要为了性能引入连接池的复杂度** —— 这里永远不会是瓶颈。

## 隐私（AC-8.4）

**这个库里绝对不能出现终端输出内容，也不存用户敲过的命令。** 存的只有设备与配对（token 与配对码只存哈希）、设置项。终端输出只在内存里（环形缓冲与终端模拟器），见 [`../60-security/threat-model.md`](../60-security/threat-model.md)。

`IT-privacy-1` 的做法：跑一个会话输出一个特征字符串（如 `WEBTERM_CANARY_9f3a`），然后 grep 整个数据目录，断言零命中。
