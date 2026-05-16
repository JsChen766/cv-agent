ALTER TABLE generation_sessions ADD COLUMN IF NOT EXISTS generation JSONB NOT NULL DEFAULT '{}'::jsonb;
