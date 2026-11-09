package store_test

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/sunhaijun/webterm/internal/store"
)

// A device paired from another machine's page keeps that page's origin
// (ADR-0062 §4); one paired on the agent's own page has none.
func TestDeviceOrigin(t *testing.T) {
	s, _ := open(t)
	now := time.Now()
	if _, err := s.CreateDevice("own", "Mac · Safari", "tok-own", "1.2.3.4", "", now); err != nil {
		t.Fatal(err)
	}
	d, err := s.CreateDevice("bound", "iPhone · Safari", "tok-bound", "1.2.3.4", "https://tokyo.example.com:8443", now)
	if err != nil {
		t.Fatal(err)
	}
	if d.Origin != "https://tokyo.example.com:8443" {
		t.Fatalf("CreateDevice returned origin %q", d.Origin)
	}
	for tok, want := range map[string]string{"tok-own": "", "tok-bound": "https://tokyo.example.com:8443"} {
		got, err := s.DeviceByToken(tok)
		if err != nil || got == nil {
			t.Fatalf("DeviceByToken(%s): %v %v", tok, got, err)
		}
		if got.Origin != want {
			t.Errorf("DeviceByToken(%s).Origin = %q, want %q", tok, got.Origin, want)
		}
	}
	list, err := s.ListDevices()
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]string{}
	for _, d := range list {
		seen[d.ID] = d.Origin
	}
	if seen["own"] != "" || seen["bound"] != "https://tokyo.example.com:8443" {
		t.Errorf("ListDevices origins = %v", seen)
	}
}

// Migration 0004 adds the column; devices paired before it have no origin and
// keep working.
func TestMigration0004KeepsDevices(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "webterm.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"0001_init.sql", "0002_pairing_digits.sql", "0003_drop_commands.sql"} {
		body, err := os.ReadFile(filepath.Join("migrations", name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(string(body)); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	for _, q := range []string{
		`INSERT INTO settings(key, value) VALUES('schema_version', '3')`,
		`INSERT INTO devices(id, name, token_hash, created_at, last_seen_at) VALUES('old', 'Old', x'` + hexOf(store.TokenHash("tok-old")) + `', 1, 1)`,
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
	if v, _ := s.SchemaVersion(); v < 4 {
		t.Fatalf("schema version = %d, want ≥ 4", v)
	}
	d, err := s.DeviceByToken("tok-old")
	if err != nil || d == nil {
		t.Fatalf("old device lost: %v %v", d, err)
	}
	if d.Origin != "" {
		t.Errorf("old device origin = %q, want empty", d.Origin)
	}
}

func hexOf(b []byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, 0, len(b)*2)
	for _, c := range b {
		out = append(out, digits[c>>4], digits[c&15])
	}
	return string(out)
}
