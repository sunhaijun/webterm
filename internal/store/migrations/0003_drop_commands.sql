-- Drop command history entirely (ADR-0026 §6): with shell integration gone,
-- nothing records commands anymore. Upgraded databases no longer keep the text
-- of commands the user typed. The history-only setting goes too. The freed
-- pages are returned to the file system by PRAGMA incremental_vacuum after
-- migrate.
DROP INDEX IF EXISTS idx_cmd_started;
DROP INDEX IF EXISTS idx_cmd_pinned;
DROP INDEX IF EXISTS idx_cmd_cwd;
DROP TABLE IF EXISTS commands;
DELETE FROM settings WHERE key = 'history_enabled';
