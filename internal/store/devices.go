package store

import (
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"fmt"
	"time"
)

// Device is created by a successful pairing and holds a long-lived session
// cookie.
type Device struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	CreatedAt  int64  `json:"created_at"`
	LastSeenAt int64  `json:"last_seen_at"`
	LastIP     string `json:"last_ip"`
	RevokedAt  *int64 `json:"revoked_at,omitempty"`
	// Origin is the page origin the device was paired from when that wasn't
	// the agent's own (ADR-0062 §4); empty otherwise.
	Origin string `json:"origin,omitempty"`
}

// TokenHash returns the SHA-256 of token.
//
// Only hashes are stored (AC-1.10), so a leaked database yields no usable
// cookies.
func TokenHash(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// CreateDevice records a newly paired device. origin is the page origin it
// was paired from, or empty for the agent's own page (ADR-0062 §4).
func (s *Store) CreateDevice(id, name, token, ip, origin string, now time.Time) (*Device, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ms := now.UnixMilli()
	_, err := s.db.Exec(
		`INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, last_ip, origin)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		id, name, TokenHash(token), ms, ms, nullStr(ip), nullStr(origin))
	if err != nil {
		return nil, fmt.Errorf("store: create device: %w", err)
	}
	return &Device{ID: id, Name: name, CreatedAt: ms, LastSeenAt: ms, LastIP: ip, Origin: origin}, nil
}

// DeviceByToken looks up a device by its cookie token. Revoked devices are
// not returned.
func (s *Store) DeviceByToken(token string) (*Device, error) {
	row := s.db.QueryRow(`
		SELECT id, name, created_at, last_seen_at, last_ip, origin
		FROM devices WHERE token_hash = ? AND revoked_at IS NULL`, TokenHash(token))
	var d Device
	var ip, origin sql.NullString
	if err := row.Scan(&d.ID, &d.Name, &d.CreatedAt, &d.LastSeenAt, &ip, &origin); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	d.LastIP = ip.String
	d.Origin = origin.String
	return &d, nil
}

// TokenRevoked reports whether token belongs to a device that has been
// revoked.
func (s *Store) TokenRevoked(token string) (bool, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM devices WHERE token_hash = ? AND revoked_at IS NOT NULL`, TokenHash(token)).Scan(&n)
	return n > 0, err
}

// ListDevices returns all non-revoked devices, most recently paired first.
func (s *Store) ListDevices() ([]Device, error) {
	rows, err := s.db.Query(`
		SELECT id, name, created_at, last_seen_at, last_ip, origin
		FROM devices WHERE revoked_at IS NULL ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Device{} // not nil, or it encodes as JSON null
	for rows.Next() {
		var d Device
		var ip, origin sql.NullString
		if err := rows.Scan(&d.ID, &d.Name, &d.CreatedAt, &d.LastSeenAt, &ip, &origin); err != nil {
			return nil, err
		}
		d.LastIP = ip.String
		d.Origin = origin.String
		out = append(out, d)
	}
	return out, rows.Err()
}

// RenameDevice renames a device.
func (s *Store) RenameDevice(id, name string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`UPDATE devices SET name = ? WHERE id = ? AND revoked_at IS NULL`, name, id)
	return err
}

// RevokeDevice revokes a device.
func (s *Store) RevokeDevice(id string, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
		now.UnixMilli(), id)
	return err
}

// RevokeAllDevices revokes every device, including the one making the
// request.
func (s *Store) RevokeAllDevices(now time.Time) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(`UPDATE devices SET revoked_at = ? WHERE revoked_at IS NULL`, now.UnixMilli())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// TouchDevice updates last_seen_at and last_ip.
//
// Callers throttle it (at most once per device per 60 seconds) so that not
// every request writes to the database.
func (s *Store) TouchDevice(id, ip string, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`UPDATE devices SET last_seen_at = ?, last_ip = ? WHERE id = ?`,
		now.UnixMilli(), nullStr(ip), id)
	return err
}

// HasAnyDevice reports whether any device is authorized. Startup uses it to
// decide whether to print a pairing code.
func (s *Store) HasAnyDevice() (bool, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM devices WHERE revoked_at IS NULL`).Scan(&n)
	return n > 0, err
}

// ---------- Pairing codes ----------

// CreatePairing stores the hashes of both keys for one pairing (ADR-0017):
// code goes in the QR code, digits are for typing by hand. An empty digits
// means URL code only (older callers and tests).
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

// ErrPairingInvalid means the pairing code does not exist, has expired or
// was already used.
//
// The three cases share one error on purpose: telling them apart would reveal
// to an attacker that a code once existed.
var ErrPairingInvalid = fmt.Errorf("store: invalid pairing code")

// ConsumePairing validates a pairing code and invalidates it. Codes are
// single-use (AC-1.4).
//
// It compares with subtle.ConstantTimeCompare instead of matching the hash in
// a WHERE clause: index lookup time depends on the key distribution, which is
// a weak but real timing side channel. There are at most a handful of live
// codes, so loading them all and comparing each in constant time is cheap.
//
// Validation and invalidation share one transaction so that concurrent
// requests cannot use the same code twice.
func (s *Store) ConsumePairing(code string, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Compare against both keys (ADR-0017): the presented code may be the URL
	// code or the digits (the caller strips separators). A match on either
	// invalidates the whole row by its primary key, code_hash.
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
		// No short-circuit: always do both comparisons on every row so timing
		// does not depend on where the match is.
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
		return ErrPairingInvalid // a concurrent request used it first
	}
	return tx.Commit()
}

// PurgePairings deletes expired and used pairing codes. It runs at startup
// and hourly.
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

// nullStr stores an empty string as NULL.
func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}
