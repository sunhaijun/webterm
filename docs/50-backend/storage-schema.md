# Storage schema

> Status: Accepted
>
> Library choice: [ADR-0005](../20-architecture/adr/0005-sqlite-pure-go.md) — `modernc.org/sqlite`, pure Go, no cgo.

## Location and permissions

```
$XDG_DATA_HOME/webterm/          (otherwise ~/.local/share/webterm/)
├── webterm.db          0600     main SQLite database
├── webterm.db-wal      0600
├── webterm.db-shm      0600
├── certs/              0700     autocert cache
└── run/                0700     control socket agent.sock (hot upgrade)
```

Override with `--data-dir`.

**Pre-create the db file with `os.OpenFile(path, O_CREATE, 0600)`**: when SQLite creates it, the umask applies and the file may end up 0644 (AC-1.12).

## PRAGMA

```sql
PRAGMA journal_mode  = WAL;
PRAGMA synchronous   = NORMAL;
PRAGMA foreign_keys  = ON;
PRAGMA busy_timeout  = 5000;
PRAGMA auto_vacuum   = INCREMENTAL;   -- must be set before the first table is created, or it has no effect
```

`auto_vacuum` can only be set when the database is created; changing it later takes a full `VACUUM`. So it has to come first in `0001_init.sql`, or every later `incremental_vacuum` is a no-op.

## Schema

### `settings`

```sql
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- schema_version lives here; startup reads it to decide which migrations to run.
-- history_enabled, used only by command history, was removed by 0003
```

### `devices`

```sql
CREATE TABLE devices (
    id           TEXT PRIMARY KEY,      -- random 16 bytes, hex
    name         TEXT NOT NULL,         -- inferred from User-Agent, editable
    token_hash   BLOB NOT NULL,         -- SHA-256(session token); the raw token is never stored
    created_at   INTEGER NOT NULL,      -- unix ms
    last_seen_at INTEGER NOT NULL,
    last_ip      TEXT,
    revoked_at   INTEGER                -- NULL = active
);
CREATE UNIQUE INDEX idx_devices_token ON devices(token_hash);
CREATE INDEX idx_devices_active ON devices(revoked_at) WHERE revoked_at IS NULL;
```

**Only the token hash is stored** (AC-1.10). A leaked database gives an attacker no usable cookie.

`last_seen_at` / `last_ip` updates are throttled (at most one write per device per 60 seconds), so requests don't each write to the database.

### `pairings`

```sql
CREATE TABLE pairings (
    code_hash  BLOB PRIMARY KEY,        -- SHA-256(pairing code)
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,        -- created_at + 5 minutes
    used_at    INTEGER                  -- NULL = unused
);
```

Hash only here too. Verification uses `subtle.ConstantTimeCompare` (AC-1.4).

Expired rows are deleted at startup and by an hourly cleanup task.

## Migrations

```
internal/store/migrations/
  0001_init.sql
  0002_pairing_digits.sql
  0003_drop_commands.sql      DROP TABLE IF EXISTS commands;
                              DELETE FROM settings WHERE key = 'history_enabled';
```

`0003` removes command history, following [ADR-0026](../20-architecture/adr/0026-agent-holds-terminal-state.md): an upgraded database no longer keeps the user's raw commands. It then runs `PRAGMA incremental_vacuum` to give the pages back to the filesystem.

Migrations are embedded with `go:embed`. At startup the store reads `settings.schema_version` and runs the unapplied scripts in order, each in its own transaction, bumping the version after each success.

Rules:

- **A released migration is never modified**; only new scripts are added.
- Every script must be safe to rerun after an interruption (`CREATE TABLE IF NOT EXISTS`, etc.).
- No down migrations. To roll back to an older agent, restore from a backup.

## Concurrency

A single `*sql.DB` with `SetMaxOpenConns(1)`, plus an application-level `sync.Mutex` around writes.

SQLite in WAL mode supports concurrent reads, but for this workload (pairing, device checks, throttled `last_seen_at` updates) serializing everything is the simplest reliable choice. **Don't add connection-pool complexity for performance**: this will never be the bottleneck.

## Privacy (AC-8.4)

**Terminal output must never appear in this database, and neither do the commands the user typed.** It holds only devices and pairings (tokens and pairing codes as hashes only) and settings. Terminal output lives only in memory (ring buffer and terminal emulator); see [`../60-security/threat-model.md`](../60-security/threat-model.md).

How `IT-privacy-1` checks it: run a session that prints a marker string (such as `WEBTERM_CANARY_9f3a`), then grep the whole data directory and assert zero hits.
