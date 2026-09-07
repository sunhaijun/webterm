package store

import (
	"database/sql"
	"fmt"
	"time"
)

// Command 是一条命令记录。pinned = true 的就是「快捷命令」，没有单独的实体。
type Command struct {
	ID          int64   `json:"id"`
	Text        string  `json:"text"`
	SessionName string  `json:"session_name"`
	CWD         string  `json:"cwd"`
	ExitCode    *int    `json:"exit_code"`   // NULL = 未完成 或 手动新建的快捷命令
	StartedAt   int64   `json:"started_at"`  // unix ms
	DurationMS  *int64  `json:"duration_ms"` // NULL 同上
	Pinned      bool    `json:"pinned"`
	Label       *string `json:"label"`
	PinOrder    *int64  `json:"pin_order"`
}

// Filter 是历史列表的查询条件。
type Filter struct {
	Q string // 命令原文子串匹配
	// Prefix 是前缀匹配并按原文去重，用于 Composer 的历史导航。与 Q 互斥。
	Prefix     string
	CWD        string // 精确匹配执行目录
	FailedOnly bool   // 只看 exit_code != 0（不含未完成的）
	PinnedOnly bool   // 只看快捷命令，按 pin_order 升序
	Limit      int    // 默认 50，上限 200
	Before     int64  // 游标：上一页最后一条的 started_at，0 表示第一页
}

// BeginCommand 在收到 OSC 133;C 时写入一条进行中的记录，返回 cmd_id。
// exit_code / duration_ms 此时为 NULL，由 FinishCommand 补齐。
func (s *Store) BeginCommand(text, sessionName, cwd string, startedAt time.Time) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(
		`INSERT INTO commands (text, session_name, cwd, started_at, pinned) VALUES (?, ?, ?, ?, 0)`,
		text, nullStr(sessionName), nullStr(cwd), startedAt.UnixMilli())
	if err != nil {
		return 0, fmt.Errorf("store: 写入命令记录: %w", err)
	}
	return res.LastInsertId()
}

// FinishCommand 在收到 OSC 133;D 时补齐退出码与耗时。
//
// shell 在 133;D 之前死掉时这一步永远不会发生，该行的 exit_code / duration_ms
// 永久为 NULL —— 查询时按"未完成"展示。知道"我跑了什么"比知道"结果如何"更重要。
func (s *Store) FinishCommand(id int64, exitCode *int, duration time.Duration) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`UPDATE commands SET exit_code = ?, duration_ms = ? WHERE id = ?`,
		nullInt(exitCode), duration.Milliseconds(), id)
	return err
}

// NewSnippet 手动新建一条从未执行过的快捷命令（次要入口，不在主路径上）。
func (s *Store) NewSnippet(text string, label *string, now time.Time) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var next sql.NullInt64
	if err := s.db.QueryRow(`SELECT MAX(pin_order) FROM commands WHERE pinned = 1`).Scan(&next); err != nil {
		return 0, err
	}
	res, err := s.db.Exec(
		`INSERT INTO commands (text, started_at, pinned, label, pin_order) VALUES (?, ?, 1, ?, ?)`,
		text, now.UnixMilli(), nullStrPtr(label), next.Int64+1)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// ListCommands 返回历史列表。
//
// 用游标（Before）而不是 OFFSET 分页 —— 历史一直在追加，翻页期间新插入的行
// 会让 OFFSET 漏行和重行。
func (s *Store) ListCommands(f Filter) ([]Command, error) {
	limit := f.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	if f.Prefix != "" {
		return s.listByPrefix(f.Prefix, limit)
	}
	order := `ORDER BY started_at DESC, id DESC`
	if f.PinnedOnly {
		order = `ORDER BY pin_order ASC, id ASC`
	}
	rows, err := s.db.Query(`
		SELECT id, text, session_name, cwd, exit_code, started_at, duration_ms, pinned, label, pin_order
		FROM commands
		WHERE (? = ''  OR text LIKE '%' || ? || '%')
		  AND (? = ''  OR cwd = ?)
		  AND (? = 0   OR (exit_code IS NOT NULL AND exit_code != 0))
		  AND (? = 0   OR pinned = 1)
		  AND (? = 0   OR started_at < ?)
		`+order+`
		LIMIT ?`,
		f.Q, f.Q, f.CWD, f.CWD, boolInt(f.FailedOnly), boolInt(f.PinnedOnly), f.Before, f.Before, limit)
	if err != nil {
		return nil, fmt.Errorf("store: 查询历史: %w", err)
	}
	defer rows.Close()
	return scanCommands(rows)
}

// listByPrefix 是 Composer 里按 ↑ 翻历史用的：前缀匹配 + 按原文去重。
//
// 【去重是必须的】—— 否则连按 ↑ 会在同一条命令上原地打转十几次。
func (s *Store) listByPrefix(prefix string, limit int) ([]Command, error) {
	rows, err := s.db.Query(`
		SELECT MAX(id), text, MAX(session_name), MAX(cwd), NULL, MAX(started_at),
		       NULL, MAX(pinned), MAX(label), NULL
		FROM commands
		WHERE text LIKE ? || '%'
		GROUP BY text
		ORDER BY MAX(started_at) DESC
		LIMIT ?`, prefix, limit)
	if err != nil {
		return nil, fmt.Errorf("store: 前缀查询历史: %w", err)
	}
	defer rows.Close()
	return scanCommands(rows)
}

// Patch 是对一条命令记录的部分更新（对应 PATCH /api/commands/:id）。
type Patch struct {
	Pinned   *bool
	Label    *string
	PinOrder *int64
}

// UpdateCommand 应用一个部分更新。置顶时若未指定 PinOrder，追加到末尾。
func (s *Store) UpdateCommand(id int64, p Patch) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if p.Pinned != nil {
		if *p.Pinned {
			order := int64(0)
			if p.PinOrder != nil {
				order = *p.PinOrder
			} else {
				var max sql.NullInt64
				if err := tx.QueryRow(`SELECT MAX(pin_order) FROM commands WHERE pinned = 1`).Scan(&max); err != nil {
					return err
				}
				order = max.Int64 + 1
			}
			if _, err := tx.Exec(`UPDATE commands SET pinned = 1, pin_order = ? WHERE id = ?`, order, id); err != nil {
				return err
			}
		} else {
			// 取消置顶：pin_order 必须一并清空，否则会污染置顶列表的排序
			if _, err := tx.Exec(`UPDATE commands SET pinned = 0, pin_order = NULL WHERE id = ?`, id); err != nil {
				return err
			}
		}
	} else if p.PinOrder != nil {
		if _, err := tx.Exec(`UPDATE commands SET pin_order = ? WHERE id = ? AND pinned = 1`, *p.PinOrder, id); err != nil {
			return err
		}
	}
	if p.Label != nil {
		if _, err := tx.Exec(`UPDATE commands SET label = ? WHERE id = ?`, nullStr(*p.Label), id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Reorder 批量设置 pin_order，一次事务提交所有受影响的项 ——
// 逐条提交会在中间态出现重复的 pin_order。
func (s *Store) Reorder(order map[int64]int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for id, ord := range order {
		if _, err := tx.Exec(`UPDATE commands SET pin_order = ? WHERE id = ? AND pinned = 1`, ord, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// DeleteCommand 删除单条记录。
func (s *Store) DeleteCommand(id int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`DELETE FROM commands WHERE id = ?`, id)
	return err
}

// ClearHistory 清空全部【非置顶】历史，返回删除条数与保留的置顶条数。
//
// 不提供"整表删除" —— 置顶记录承载着快捷命令，误删不可恢复。
func (s *Store) ClearHistory() (deleted, keptPinned int64, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(`DELETE FROM commands WHERE pinned = 0`)
	if err != nil {
		return 0, 0, err
	}
	deleted, _ = res.RowsAffected()
	err = s.db.QueryRow(`SELECT COUNT(*) FROM commands WHERE pinned = 1`).Scan(&keptPinned)
	return deleted, keptPinned, err
}

// Evict 把历史裁到 max 条以内，按时间淘汰最旧的【非置顶】记录。
//
// 置顶记录永不淘汰 —— 快捷命令的生命周期跟历史行绑定（ADR-0008 / AC-6.10）。
func (s *Store) Evict(max int) (int64, error) {
	if max <= 0 {
		return 0, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(`
		DELETE FROM commands
		WHERE pinned = 0
		  AND id NOT IN (
		      SELECT id FROM commands WHERE pinned = 0
		      ORDER BY started_at DESC, id DESC LIMIT ?
		  )`, max)
	if err != nil {
		return 0, fmt.Errorf("store: 淘汰历史: %w", err)
	}
	n, _ := res.RowsAffected()
	if n > 0 {
		// 淘汰后回收空间。auto_vacuum=INCREMENTAL 在建库时已设，这里才有效。
		if rows, err := s.db.Query(`PRAGMA incremental_vacuum`); err == nil {
			rows.Close()
		}
	}
	return n, nil
}

// PrefixHistory 是 Composer 里按 ↑ 的历史导航（前缀匹配）。
//
// DISTINCT 很重要 —— 否则连按 ↑ 会翻到同一条命令十几次。
func (s *Store) PrefixHistory(prefix string, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 50
	}
	rows, err := s.db.Query(`
		SELECT text FROM commands
		WHERE text LIKE ? || '%'
		GROUP BY text
		ORDER BY MAX(started_at) DESC
		LIMIT ?`, prefix, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func scanCommands(rows *sql.Rows) ([]Command, error) {
	// 【必须是非 nil 的空切片】。nil 切片会被 encoding/json 编成 null，
	// 而 API 契约说的是数组 —— 客户端拿到 null 之后一个 .length 就崩了。
	out := []Command{}
	for rows.Next() {
		var c Command
		var sessionName, cwd, label sql.NullString
		var exitCode, durationMS, pinOrder sql.NullInt64
		if err := rows.Scan(&c.ID, &c.Text, &sessionName, &cwd, &exitCode,
			&c.StartedAt, &durationMS, &c.Pinned, &label, &pinOrder); err != nil {
			return nil, err
		}
		c.SessionName, c.CWD = sessionName.String, cwd.String
		if exitCode.Valid {
			v := int(exitCode.Int64)
			c.ExitCode = &v
		}
		if durationMS.Valid {
			c.DurationMS = &durationMS.Int64
		}
		if label.Valid {
			c.Label = &label.String
		}
		if pinOrder.Valid {
			c.PinOrder = &pinOrder.Int64
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullStrPtr(s *string) any {
	if s == nil || *s == "" {
		return nil
	}
	return *s
}

func nullInt(v *int) any {
	if v == nil {
		return nil
	}
	return *v
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
