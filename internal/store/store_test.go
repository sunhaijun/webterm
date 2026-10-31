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

// 迁移必须幂等：连续跑两次结果一致。
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
		t.Fatalf("第二次 Open 失败: %v", err)
	}
	defer s2.Close()
	v2, _ := s2.SchemaVersion()
	if v1 != v2 || v1 == 0 {
		t.Fatalf("schema 版本 %d → %d", v1, v2)
	}
	if d, err := s2.DeviceByToken("tok"); err != nil || d == nil || d.ID != "dev-1" {
		t.Fatalf("重开后数据丢了: %+v %v", d, err)
	}
}

// 迁移 0003：老库升级之后不再留着用户敲过的命令原文（ADR-0026 §6）。
//
// 新库上 0001 建的 commands 表随即被 0003 删掉；这里模拟的是一个停在 0002、
// 表里真有命令的老库。
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
		t.Fatalf("升级老库失败: %v", err)
	}
	defer s.Close()
	if v, _ := s.SchemaVersion(); v < 3 {
		t.Fatalf("schema 版本 = %d, want ≥ 3", v)
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
		t.Fatalf("commands 表或它的索引还在（%d 个）", n)
	}
	if err := db.QueryRow(`SELECT count(*) FROM settings WHERE key = 'history_enabled'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatal("只为历史服务的 history_enabled 还在")
	}
}

// 新库：0001 建的 commands 表也被 0003 删掉，库里没有任何命令历史的结构。
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
		t.Fatal("新库里还有 commands 表")
	}
}

// IT-store-1：DB 文件权限必须是 0600（AC-1.12）。
// SQLite 自己创建时受 umask 影响，可能得到 0644。
func TestStoreFilePermissions(t *testing.T) {
	_, dir := open(t)
	fi, err := os.Stat(filepath.Join(dir, "webterm.db"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Fatalf("webterm.db 权限 = %04o, want 0600", perm)
	}
	di, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if perm := di.Mode().Perm(); perm != 0o700 {
		t.Fatalf("数据目录权限 = %04o, want 0700", perm)
	}
}
