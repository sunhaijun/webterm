-- 数字配对码（ADR-0017）：同一次配对的第二把钥匙 —— 16 位十进制，给扫不了码的人手输。
-- 与 code_hash 同生共死：任一把用掉，整行 used_at 置位。老行没有它（NULL），照旧只认 URL 码。
ALTER TABLE pairings ADD COLUMN digits_hash BLOB;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pairings_digits ON pairings(digits_hash) WHERE digits_hash IS NOT NULL;
