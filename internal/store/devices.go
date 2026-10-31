package store

import (
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"fmt"
	"time"
)

// Device 是一次成功配对产生的记录，持有一个长效会话 Cookie。
type Device struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	CreatedAt  int64  `json:"created_at"`
	LastSeenAt int64  `json:"last_seen_at"`
	LastIP     string `json:"last_ip"`
	RevokedAt  *int64 `json:"revoked_at,omitempty"`
}

// TokenHash 返回 token 的 SHA-256。
//
// 库里【只存哈希】（AC-1.10）：库泄露时攻击者拿不到可用的 Cookie。
func TokenHash(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// CreateDevice 记录一台新配对的设备。
func (s *Store) CreateDevice(id, name, token, ip string, now time.Time) (*Device, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ms := now.UnixMilli()
	_, err := s.db.Exec(
		`INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, last_ip)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		id, name, TokenHash(token), ms, ms, nullStr(ip))
	if err != nil {
		return nil, fmt.Errorf("store: 创建设备: %w", err)
	}
	return &Device{ID: id, Name: name, CreatedAt: ms, LastSeenAt: ms, LastIP: ip}, nil
}

// DeviceByToken 按 Cookie token 查设备。已吊销的设备查不到。
func (s *Store) DeviceByToken(token string) (*Device, error) {
	row := s.db.QueryRow(`
		SELECT id, name, created_at, last_seen_at, last_ip
		FROM devices WHERE token_hash = ? AND revoked_at IS NULL`, TokenHash(token))
	var d Device
	var ip sql.NullString
	if err := row.Scan(&d.ID, &d.Name, &d.CreatedAt, &d.LastSeenAt, &ip); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	d.LastIP = ip.String
	return &d, nil
}

// ListDevices 返回所有未吊销的设备，按配对时间倒序。
func (s *Store) ListDevices() ([]Device, error) {
	rows, err := s.db.Query(`
		SELECT id, name, created_at, last_seen_at, last_ip
		FROM devices WHERE revoked_at IS NULL ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Device{} // 同样不能是 nil，否则 JSON 里是 null
	for rows.Next() {
		var d Device
		var ip sql.NullString
		if err := rows.Scan(&d.ID, &d.Name, &d.CreatedAt, &d.LastSeenAt, &ip); err != nil {
			return nil, err
		}
		d.LastIP = ip.String
		out = append(out, d)
	}
	return out, rows.Err()
}

// RenameDevice 改设备名。
func (s *Store) RenameDevice(id, name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`UPDATE devices SET name = ? WHERE id = ? AND revoked_at IS NULL`, name, id)
	return err
}

// RevokeDevice 吊销一台设备。
func (s *Store) RevokeDevice(id string, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
		now.UnixMilli(), id)
	return err
}

// RevokeAllDevices 吊销全部设备（包括发起请求的那台）。
func (s *Store) RevokeAllDevices(now time.Time) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(`UPDATE devices SET revoked_at = ? WHERE revoked_at IS NULL`, now.UnixMilli())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// TouchDevice 更新 last_seen_at / last_ip。
//
// 调用方负责节流（每设备最多 60 秒一次），避免每个请求都写库。
func (s *Store) TouchDevice(id, ip string, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`UPDATE devices SET last_seen_at = ?, last_ip = ? WHERE id = ?`,
		now.UnixMilli(), nullStr(ip), id)
	return err
}

// HasAnyDevice 报告是否已经有授权设备（决定启动时要不要自动打配对码）。
func (s *Store) HasAnyDevice() (bool, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM devices WHERE revoked_at IS NULL`).Scan(&n)
	return n > 0, err
}

// ---------- 配对码 ----------

// CreatePairing 记录一次配对的两把钥匙的哈希（ADR-0017）：code 走二维码，digits 手输。
// digits 为空表示只有 URL 码（老调用方 / 测试）。
func (s *Store) CreatePairing(code, digits string, now time.Time, ttl time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var dh any
	if digits != "" {
		dh = TokenHash(digits)
	}
	_, err := s.db.Exec(
		`INSERT INTO pairings (code_hash, digits_hash, created_at, expires_at) VALUES (?, ?, ?, ?)`,
		TokenHash(code), dh, now.UnixMilli(), now.Add(ttl).UnixMilli())
	return err
}

// ErrPairingInvalid 表示配对码不存在、已过期或已被用过。
//
// 三种情况【故意合并成同一个错误】：区分它们等于告诉攻击者"这个码存在过"。
var ErrPairingInvalid = fmt.Errorf("store: 配对码无效")

// ConsumePairing 校验并作废一个配对码。单次有效，用过即废（AC-1.4）。
//
// 比较用 subtle.ConstantTimeCompare 而不是拿哈希去 WHERE 匹配：索引查找的
// 耗时依赖于键的分布，是一条（虽然微弱但真实的）时序侧信道。有效的配对码
// 最多只有个位数条，全取出来逐个常数时间比一遍的代价可以忽略。
//
// 校验与作废在同一个事务里，防止并发请求把同一个码用两次。
func (s *Store) ConsumePairing(code string, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// 两把钥匙都取出来比（ADR-0017）：presented 可能是 URL 码也可能是数字码，
	// 调用方已把分隔符剥掉。匹配到任一把，就按主键 code_hash 把整行作废。
	rows, err := tx.Query(
		`SELECT code_hash, digits_hash FROM pairings WHERE used_at IS NULL AND expires_at >= ?`,
		now.UnixMilli())
	if err != nil {
		return err
	}
	want := TokenHash(code)
	var matched []byte
	for rows.Next() {
		var h, dh []byte
		if err := rows.Scan(&h, &dh); err != nil {
			rows.Close()
			return err
		}
		// 不短路：每一行两次比较都做完，耗时与命中位置无关
		hit := subtle.ConstantTimeCompare(h, want) == 1
		if len(dh) == len(want) && subtle.ConstantTimeCompare(dh, want) == 1 {
			hit = true
		}
		if hit && matched == nil {
			matched = h
		}
	}
	rows.Close()
	if matched == nil {
		return ErrPairingInvalid
	}
	res, err := tx.Exec(
		`UPDATE pairings SET used_at = ? WHERE code_hash = ? AND used_at IS NULL`,
		now.UnixMilli(), matched)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return ErrPairingInvalid // 并发请求抢先用掉了
	}
	return tx.Commit()
}

// PurgePairings 清理过期与已使用的配对码。启动时和每小时跑一次。
func (s *Store) PurgePairings(now time.Time) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(
		`DELETE FROM pairings WHERE expires_at < ? OR used_at IS NOT NULL`, now.UnixMilli())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// nullStr 把空字符串存成 NULL。
func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}
