// Package store is the SQLite persistence layer.
//
// See ADR-0005 for the choice of modernc.org/sqlite (pure Go, no cgo) and
// docs/50-backend/storage-schema.md for the schema.
//
// Terminal output must never reach this database (invariant 3 / AC-8.4), and
// neither do the commands a user typed (command history was removed in
// ADR-0026). It holds only devices, pairings (tokens and pairing codes are
// stored as hashes) and the schema version.
package store

import (
	"database/sql"
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"

	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

const schemaVersionKey = "schema_version"

// Store is the database handle.
//
// It uses a single connection plus a write lock. SQLite in WAL mode supports
// concurrent readers, but the only load here is pairing, device checks and
// throttled last_seen_at updates, so serializing everything is the simplest
// reliable option. Don't add a connection pool for performance.
type Store struct {
	db *sql.DB
	mu sync.Mutex
}

// Open opens the database, creating it if needed. dir is created with mode
// 0700 and the database file with mode 0600.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("store: create data dir: %w", err)
	}
	// MkdirAll is a no-op on an existing directory, so tighten the mode
	// explicitly: the data dir holds device credential hashes and certificate
	// private keys, and other users on the host are outside the trust boundary.
	if err := os.Chmod(dir, 0o700); err != nil {
		return nil, fmt.Errorf("store: chmod data dir: %w", err)
	}
	path := filepath.Join(dir, "webterm.db")

	// Create the file ourselves: when SQLite creates it, the mode depends on
	// the umask and may end up 0644 (AC-1.12).
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("store: create db file: %w", err)
	}
	f.Close()
	if err := os.Chmod(path, 0o600); err != nil {
		return nil, fmt.Errorf("store: chmod db file: %w", err)
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("store: open db: %w", err)
	}
	db.SetMaxOpenConns(1)

	s := &Store{db: db}
	if err := s.pragmas(); err != nil {
		db.Close()
		return nil, err
	}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) pragmas() error {
	// auto_vacuum must be set before the first table is created; afterwards it
	// only takes effect after a full VACUUM. Without it, the incremental_vacuum
	// in migrate is a no-op.
	for _, p := range []string{
		"PRAGMA auto_vacuum = INCREMENTAL",
		"PRAGMA journal_mode = WAL",
		"PRAGMA synchronous = NORMAL",
		"PRAGMA foreign_keys = ON",
		"PRAGMA busy_timeout = 5000",
	} {
		// Some PRAGMAs (journal_mode) return a row, so use Query for all of them.
		rows, err := s.db.Query(p)
		if err != nil {
			return fmt.Errorf("store: %s: %w", p, err)
		}
		rows.Close()
	}
	return nil
}

// migrate applies pending migration scripts in order, each in its own
// transaction.
//
// Rules: the statements of a released migration never change (scripts are
// tracked by number only, so editing comments is harmless); schema changes
// are new scripts. Each script must be safe to re-run after an interruption.
// There are no down migrations.
func (s *Store) migrate() error {
	if _, err := s.db.Exec(
		`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
	); err != nil {
		return fmt.Errorf("store: create settings table: %w", err)
	}

	current := 0
	if v, ok, err := s.getSetting(schemaVersionKey); err != nil {
		return err
	} else if ok {
		current, _ = strconv.Atoi(v)
	}

	entries, err := migrationFS.ReadDir("migrations")
	if err != nil {
		return err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)

	applied := 0
	for _, name := range names {
		v, err := strconv.Atoi(name[:4])
		if err != nil {
			return fmt.Errorf("store: invalid migration file name: %s", name)
		}
		if v <= current {
			continue
		}
		body, err := migrationFS.ReadFile("migrations/" + name)
		if err != nil {
			return err
		}
		tx, err := s.db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(string(body)); err != nil {
			tx.Rollback()
			return fmt.Errorf("store: migration %s: %w", name, err)
		}
		if _, err := tx.Exec(
			`INSERT INTO settings(key, value) VALUES(?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			schemaVersionKey, strconv.Itoa(v),
		); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		current = v
		applied++
	}
	if applied > 0 {
		// Return pages freed by dropped tables (0003 drops command history) to
		// the file system. With auto_vacuum = INCREMENTAL they stay in the file
		// until this runs. It frees one page per row, so drain all rows.
		rows, err := s.db.Query("PRAGMA incremental_vacuum")
		if err != nil {
			return fmt.Errorf("store: incremental_vacuum: %w", err)
		}
		for rows.Next() {
		}
		rows.Close()
	}
	return nil
}

// SchemaVersion returns the currently applied schema version.
func (s *Store) SchemaVersion() (int, error) {
	v, ok, err := s.getSetting(schemaVersionKey)
	if err != nil || !ok {
		return 0, err
	}
	return strconv.Atoi(v)
}

func (s *Store) getSetting(key string) (string, bool, error) {
	var v string
	err := s.db.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&v)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("store: read setting %q: %w", key, err)
	}
	return v, true, nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }
