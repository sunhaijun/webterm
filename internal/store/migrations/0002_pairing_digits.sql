-- Numeric pairing code (ADR-0017): a second key for the same pairing, 16
-- decimal digits typed by hand when the QR code can't be scanned. It shares
-- the row with code_hash: using either key sets used_at for the whole row.
-- Older rows have NULL here and accept only the URL code.
ALTER TABLE pairings ADD COLUMN digits_hash BLOB;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pairings_digits ON pairings(digits_hash) WHERE digits_hash IS NOT NULL;
