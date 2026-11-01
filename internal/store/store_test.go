package store_test

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/store"
)

func open(t *testing.T) (*store.Store, string) {
	t.Helper()
	dir := t.TempDir()
	s, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s, dir
}

// Migrations are idempotent: opening twice gives the same result.
func TestMigrationsIdempotent(t *testing.T) {
	dir := t.TempDir()
	s1, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	v1, _ := s1.SchemaVersion()
	if _, err := s1.CreateDevice("dev-1", "iPhone", "tok", "1.2.3.4", time.Now()); err != nil {
		t.Fatal(err)
	}
	s1.Close()

	s2, err := store.Open(dir)
	if err != nil {
		t.Fatalf("second Open failed: %v", err)
	}
	defer s2.Close()
	v2, _ := s2.SchemaVersion()
	if v1 != v2 || v1 == 0 {
		t.Fatalf("schema version %d → %d", v1, v2)
	}
	if d, err := s2.DeviceByToken("tok"); err != nil || d == nil || d.ID != "dev-1" {
		t.Fatalf("data lost after reopen: %+v %v", d, err)
	}
}

// Migration 0003: an upgraded database no longer keeps the text of commands
// the user typed (ADR-0026 §6).
//
// On a fresh database 0003 drops the commands table right after 0001 creates
// it; this simulates an old database stuck at 0002 with real commands in it.
func TestMigration0003DropsCommandHistory(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "webterm.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"0001_init.sql", "0002_pairing_digits.sql"} {
		body, err := os.ReadFile(filepath.Join("migrations", name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(string(body)); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	for _, q := range []string{
		`INSERT INTO settings(key, value) VALUES('schema_version', '2')`,
		`INSERT INTO settings(key, value) VALUES('history_enabled', 'true')`,
		`INSERT INTO commands(text, started_at) VALUES('mysql -p SECRET_CMD_TEXT', 1)`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()

	s, err := store.Open(dir)
	if err != nil {
		t.Fatalf("upgrading old database failed: %v", err)
	}
	defer s.Close()
	if v, _ := s.SchemaVersion(); v < 3 {
		t.Fatalf("schema version = %d, want ≥ 3", v)
	}
	s.Close()

	db, err = sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE name LIKE '%cmd%' OR name = 'commands'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("commands table or its indexes still present (%d)", n)
	}
	if err := db.QueryRow(`SELECT count(*) FROM settings WHERE key = 'history_enabled'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatal("history-only setting history_enabled still present")
	}
}

// Fresh database: 0003 also drops the commands table created by 0001, so no
// command history schema remains.
func TestFreshStoreHasNoCommandsTable(t *testing.T) {
	_, dir := open(t)
	db, err := sql.Open("sqlite", filepath.Join(dir, "webterm.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE name = 'commands'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatal("fresh database still has a commands table")
	}
}

// IT-store-1: the DB file mode must be 0600 (AC-1.12). When SQLite creates
// the file itself, the umask may leave it at 0644.
func TestStoreFilePermissions(t *testing.T) {
	_, dir := open(t)
	fi, err := os.Stat(filepath.Join(dir, "webterm.db"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Fatalf("webterm.db mode = %04o, want 0600", perm)
	}
	di, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if perm := di.Mode().Perm(); perm != 0o700 {
		t.Fatalf("data dir mode = %04o, want 0700", perm)
	}
}
