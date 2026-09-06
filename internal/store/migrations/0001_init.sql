-- webterm 初始 schema。
--
-- 会话【不持久化】（ADR-0003：会话随 agent 进程消亡），所以没有 sessions 表。
-- 终端输出【不落盘】（不变式 3），所以只有命令元数据。
-- 快捷命令不是独立实体，就是 commands 上的 pinned 标记（ADR-0008）。

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
    id           TEXT PRIMARY KEY,      -- 随机 16 字节 hex
    name         TEXT NOT NULL,         -- 从 User-Agent 推断，可改
    token_hash   BLOB NOT NULL,         -- SHA-256(session token)，不存原文
    created_at   INTEGER NOT NULL,      -- unix ms
    last_seen_at INTEGER NOT NULL,
    last_ip      TEXT,
    revoked_at   INTEGER                -- NULL = 有效
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_token  ON devices(token_hash);
CREATE INDEX IF NOT EXISTS        idx_devices_active ON devices(revoked_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS pairings (
    code_hash  BLOB PRIMARY KEY,        -- SHA-256(配对码)
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,        -- created_at + 5 分钟
    used_at    INTEGER                  -- NULL = 未使用
);

CREATE TABLE IF NOT EXISTS commands (
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
CREATE INDEX IF NOT EXISTS idx_cmd_started ON commands(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cmd_pinned  ON commands(pin_order) WHERE pinned = 1;
CREATE INDEX IF NOT EXISTS idx_cmd_cwd     ON commands(cwd, started_at DESC);
