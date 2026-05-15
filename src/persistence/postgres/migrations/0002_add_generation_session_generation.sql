-- 0002_add_generation_session_generation
-- Adds the generation JSONB column to generation_sessions.
-- This is safe to run multiple times (IF NOT EXISTS).
-- The column is already included in schema.sql for new databases;
-- this migration handles existing databases created before this column was added.

ALTER TABLE generation_sessions ADD COLUMN IF NOT EXISTS generation JSONB NOT NULL DEFAULT '{}'::jsonb;
