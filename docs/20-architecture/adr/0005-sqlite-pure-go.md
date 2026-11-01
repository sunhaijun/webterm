# ADR-0005 Pure-Go SQLite for storage

Status: Accepted (2026-09-06). Command history (the `commands` table) was later removed along with shell integration ([ADR-0026](0026-agent-holds-terminal-state.md)); the database now holds devices, pairings and settings.

## Context

Command history (with search), snippets and device authorization needed a persistence layer.

## Decision

**Use `modernc.org/sqlite`, a pure-Go SQLite with no cgo.**

Database file: `~/.local/share/webterm/webterm.db`, mode `0600`.

Rejected alternatives:

- **JSON files.** History grows to tens of thousands of rows that need substring, CWD and time filters plus paging; JSON means loading everything into memory and filtering there. Concurrent writes need our own file locking and atomic replace. No transactions, so a crash can leave a half-written file.
- **`mattn/go-sqlite3` (cgo bindings).** Faster and more mature, but cgo breaks single-binary cross-compilation: `GOOS=linux GOARCH=amd64 go build` must produce a shippable binary and `ldd` must report "not a dynamic executable" (AC-8.1). That invariant is worth more than the speed difference; we write a few command records a minute, so performance is not a bottleneck.
- **BoltDB / bbolt (pure-Go key-value store).** No cgo and simple, but substring search plus multi-field filters plus paging on a KV store means building our own indexes, which is half a query engine.

`modernc.org/sqlite` is pure Go, has no cgo, and supports full SQL and transactions. The costs, about 10 MB of binary size and slower queries than the cgo driver, don't matter at our load.

Data model (full schema in [`../../50-backend/storage-schema.md`](../../50-backend/storage-schema.md)):

- **Sessions are not persisted.** They die with the agent process ([ADR-0003](0003-no-tmux.md)), so there is no `sessions` table. Command rows stored `session_name` as a string snapshot rather than a foreign key, avoiding orphan rows and pointless joins.
- **Terminal output never touches disk.** Only command metadata was stored; the ring buffer is memory-only. See [`../../60-security/privacy-history.md`](../../60-security/privacy-history.md).
- **Snippets are not a separate table**, just a `pinned` boolean on `commands`. See [ADR-0008](0008-pinned-history-as-snippets.md).
- **No FTS5 in v0.1.** `modernc.org/sqlite` supports FTS5, but `text LIKE '%x%'` over tens of thousands of rows takes milliseconds. Adding an FTS5 virtual table later is a purely additive change.

Implementation:

- One connection with writes serialized by a `sync.Mutex`. SQLite in WAL mode allows concurrent reads, but with the `modernc.org` driver serializing writes is the simplest reliable approach, and the load allows it.
- `PRAGMA journal_mode=WAL`, `PRAGMA synchronous=NORMAL`, `PRAGMA foreign_keys=ON`.
- The schema version lives in the `settings` table. Idempotent migrations (ordered `.sql` files embedded with `go:embed`) run at startup.
- Create the file with `os.OpenFile(..., 0600)` before opening the database, because when SQLite creates it the mode depends on the umask.
- The data directory follows XDG: `$XDG_DATA_HOME/webterm/`, else `~/.local/share/webterm/`. `--data-dir` overrides it.

## Consequences

- The binary stays cgo-free and cross-compiles directly, about 10 MB larger.
- Full SQL and transactions are available without writing a storage engine.
- Migrations are embedded and run automatically at startup; there is no separate migration step for users.
