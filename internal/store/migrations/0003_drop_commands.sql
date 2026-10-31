-- 命令历史整体删除（ADR-0026 §6）：shell 集成没了，命令记录也就没了来源。
-- 老库升级后不再留着用户敲过的命令原文。只为历史服务的设置项一并删掉。
-- 页由 migrate 之后的 PRAGMA incremental_vacuum 还给文件系统。
DROP INDEX IF EXISTS idx_cmd_started;
DROP INDEX IF EXISTS idx_cmd_pinned;
DROP INDEX IF EXISTS idx_cmd_cwd;
DROP TABLE IF EXISTS commands;
DELETE FROM settings WHERE key = 'history_enabled';
