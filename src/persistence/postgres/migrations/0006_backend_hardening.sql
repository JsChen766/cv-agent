CREATE TABLE IF NOT EXISTS api_idempotency_key (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  request_method TEXT NOT NULL,
  request_path TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER,
  response_body_json JSONB,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_idempotency_user_key ON api_idempotency_key(user_id, key);
CREATE INDEX IF NOT EXISTS idx_api_idempotency_expires_at ON api_idempotency_key(expires_at);

CREATE TABLE IF NOT EXISTS copilot_session_lock (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  owner_request_id TEXT NOT NULL,
  locked_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_copilot_session_lock_user_id ON copilot_session_lock(user_id);
CREATE INDEX IF NOT EXISTS idx_copilot_session_lock_locked_until ON copilot_session_lock(locked_until);

CREATE TABLE IF NOT EXISTS api_usage_counter (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  ip TEXT,
  bucket TEXT NOT NULL CHECK (bucket IN ('per_minute', 'daily')),
  metric TEXT NOT NULL CHECK (metric IN ('request', 'message', 'tool_call', 'generation')),
  count INTEGER NOT NULL,
  reset_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_usage_counter_user_id ON api_usage_counter(user_id);
CREATE INDEX IF NOT EXISTS idx_api_usage_counter_ip ON api_usage_counter(ip);
CREATE INDEX IF NOT EXISTS idx_api_usage_counter_reset_at ON api_usage_counter(reset_at);

CREATE TABLE IF NOT EXISTS agent_run (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT,
  turn_id TEXT,
  request_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  decision_mode TEXT,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  latency_ms INTEGER,
  token_usage_json JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_agent_run_user_id ON agent_run(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_session_id ON agent_run(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_request_id ON agent_run(request_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_status ON agent_run(status);
CREATE INDEX IF NOT EXISTS idx_agent_run_created_at ON agent_run(created_at);

CREATE TABLE IF NOT EXISTS agent_tool_run (
  id TEXT PRIMARY KEY,
  agent_run_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'needs_input')),
  latency_ms INTEGER,
  error_code TEXT,
  error_message TEXT,
  input_summary_json JSONB,
  output_summary_json JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_agent_tool_run_agent_run_id ON agent_tool_run(agent_run_id);
CREATE INDEX IF NOT EXISTS idx_agent_tool_run_user_id ON agent_tool_run(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_tool_run_session_id ON agent_tool_run(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_tool_run_tool_name ON agent_tool_run(tool_name);
CREATE INDEX IF NOT EXISTS idx_agent_tool_run_status ON agent_tool_run(status);

CREATE TABLE IF NOT EXISTS background_job (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('import_pdf', 'export_pdf', 'rebuild_index', 'long_generation')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  input_json JSONB,
  output_json JSONB,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  run_after TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_background_job_user_id ON background_job(user_id);
CREATE INDEX IF NOT EXISTS idx_background_job_status ON background_job(status);
CREATE INDEX IF NOT EXISTS idx_background_job_type ON background_job(type);
CREATE INDEX IF NOT EXISTS idx_background_job_created_at ON background_job(created_at);
