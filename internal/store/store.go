// Package store 是 SQLite 持久化层。
//
// 选型见 ADR-0005（modernc.org/sqlite，纯 Go 无 cgo），schema 见
// docs/50-backend/storage-schema.md。
//
// 这个库里【绝对不能】出现终端输出内容（不变式 3 / AC-8.4），也不存用户敲过的
// 命令（命令历史随 ADR-0026 删除）—— 只有设备与配对（token 与配对码只存哈希）
// 和 schema 版本。
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

// Store 是数据库句柄。
//
// 单连接 + 写锁：WAL 下 SQLite 支持并发读，但本项目的负载只有配对、设备校验与
// last_seen_at 的节流更新，串行化是最简单可靠的选择。不要为了性能引入连接池的复杂度。
type Store struct {
	db *sql.DB
	mu sync.Mutex
}

// Open 打开（必要时创建）数据库。dir 会被创建为 0700，db 文件为 0600。
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("store: 创建数据目录: %w", err)
	}
	// MkdirAll 对已存在的目录是空操作，权限得显式收紧 —— 数据目录里有设备凭据
	// 的哈希与证书私钥，同机的其它用户不在信任边界内。
	if err := os.Chmod(dir, 0o700); err != nil {
		return nil, fmt.Errorf("store: 设置数据目录权限: %w", err)
	}
	path := filepath.Join(dir, "webterm.db")

	// 必须预创建：SQLite 自己建文件时受 umask 影响，可能得到 0644（AC-1.12）。
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("store: 创建 db 文件: %w", err)
	}
	f.Close()
	if err := os.Chmod(path, 0o600); err != nil {
		return nil, fmt.Errorf("store: 设置 db 权限: %w", err)
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("store: 打开数据库: %w", err)
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
	// auto_vacuum 必须在建第一张表【之前】设，否则要整库 VACUUM 才生效 ——
	// 不设的话后面的 incremental_vacuum 是空操作。
	for _, p := range []string{
		"PRAGMA auto_vacuum = INCREMENTAL",
		"PRAGMA journal_mode = WAL",
		"PRAGMA synchronous = NORMAL",
		"PRAGMA foreign_keys = ON",
		"PRAGMA busy_timeout = 5000",
	} {
		// journal_mode 之类的 PRAGMA 会返回一行，用 Query 统一处理。
		rows, err := s.db.Query(p)
		if err != nil {
			return fmt.Errorf("store: %s: %w", p, err)
		}
		rows.Close()
	}
	return nil
}

// migrate 顺序执行未应用的迁移脚本，每个脚本在一个事务里。
//
// 规则：迁移脚本一旦发布不再修改，只追加新脚本；每个脚本必须幂等友好，
// 以容忍中断后重跑。不做降级迁移。
func (s *Store) migrate() error {
	if _, err := s.db.Exec(
		`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
	); err != nil {
		return fmt.Errorf("store: 建 settings 表: %w", err)
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
			return fmt.Errorf("store: 迁移脚本名不合法: %s", name)
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
			return fmt.Errorf("store: 迁移 %s: %w", name, err)
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
		// 删表（0003 删命令历史）留下的空闲页还给文件系统。auto_vacuum 是
		// INCREMENTAL，不跑这一句页就一直留在文件里。每一步回收一页，得把行读完。
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

// SchemaVersion 返回当前已应用的 schema 版本。
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
		return "", false, fmt.Errorf("store: 读 setting %q: %w", key, err)
	}
	return v, true, nil
}

// Close 关闭数据库。
func (s *Store) Close() error { return s.db.Close() }
