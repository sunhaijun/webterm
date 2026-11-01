-- webterm initial schema.
--
-- Sessions are not persisted (ADR-0003: they die with the agent process), so
-- there is no sessions table. Terminal output never touches disk (invariant 3),
-- so only command metadata is stored. Quick commands are not a separate
-- entity, just the pinned flag on commands (ADR-0008).

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
    id           TEXT PRIMARY KEY,      -- 16 random bytes, hex
    name         TEXT NOT NULL,         -- inferred from User-Agent, editable
    token_hash   BLOB NOT NULL,         -- SHA-256(session token); plaintext never stored
    created_at   INTEGER NOT NULL,      -- unix ms
    last_seen_at INTEGER NOT NULL,
    last_ip      TEXT,
    revoked_at   INTEGER                -- NULL = active
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_token  ON devices(token_hash);
CREATE INDEX IF NOT EXISTS        idx_devices_active ON devices(revoked_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS pairings (
    code_hash  BLOB PRIMARY KEY,        -- SHA-256(pairing code)
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,        -- created_at + 5 minutes
    used_at    INTEGER                  -- NULL = unused
);

CREATE TABLE IF NOT EXISTS commands (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    text         TEXT    NOT NULL,
    session_name TEXT,                  -- copied value, not a foreign key (sessions are not persisted)
    cwd          TEXT,
    exit_code    INTEGER,               -- NULL = still running, or a manually created quick command
    started_at   INTEGER NOT NULL,      -- unix ms
    duration_ms  INTEGER,               -- NULL: same as above
    pinned       INTEGER NOT NULL DEFAULT 0,   -- 1 = quick command
    label        TEXT,                  -- quick command short name
    pin_order    INTEGER                -- pinned sort order; NULL when not pinned
);
CREATE INDEX IF NOT EXISTS idx_cmd_started ON commands(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cmd_pinned  ON commands(pin_order) WHERE pinned = 1;
CREATE INDEX IF NOT EXISTS idx_cmd_cwd     ON commands(cwd, started_at DESC);
