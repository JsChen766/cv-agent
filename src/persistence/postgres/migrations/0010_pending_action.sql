CREATE TABLE IF NOT EXISTS pending_action (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  tool_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'cancelled', 'executed', 'expired', 'failed')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  affected_resources_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  preview_json JSONB,
  result_json JSONB,
  error_json JSONB,
  job_id TEXT,
  dedupe_key TEXT,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pending_action_user_session ON pending_action(user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_pending_action_status ON pending_action(status);
CREATE INDEX IF NOT EXISTS idx_pending_action_expires_at ON pending_action(expires_at);
CREATE INDEX IF NOT EXISTS idx_pending_action_job_id ON pending_action(job_id);
CREATE INDEX IF NOT EXISTS idx_pending_action_dedupe_key ON pending_action(user_id, dedupe_key);
