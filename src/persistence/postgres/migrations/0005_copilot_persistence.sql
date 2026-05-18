CREATE TABLE IF NOT EXISTS copilot_session (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT,
  target_role TEXT,
  resume_text TEXT,
  jd_text TEXT,
  current_workspace_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived', 'deleted')),
  resume_ingested BOOLEAN NOT NULL DEFAULT false,
  resume_document_ids_json JSONB,
  resume_artifact_ids_json JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_copilot_session_user_id ON copilot_session(user_id);
CREATE INDEX IF NOT EXISTS idx_copilot_session_user_status ON copilot_session(user_id, status);
CREATE INDEX IF NOT EXISTS idx_copilot_session_updated_at ON copilot_session(updated_at);
CREATE INDEX IF NOT EXISTS idx_copilot_session_created_at ON copilot_session(created_at);

CREATE TABLE IF NOT EXISTS copilot_message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  turn_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_copilot_message_user_id ON copilot_message(user_id);
CREATE INDEX IF NOT EXISTS idx_copilot_message_session_id ON copilot_message(session_id);
CREATE INDEX IF NOT EXISTS idx_copilot_message_created_at ON copilot_message(created_at);

CREATE TABLE IF NOT EXISTS copilot_turn (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_message_id TEXT NOT NULL,
  assistant_message_id TEXT,
  intent TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_copilot_turn_user_id ON copilot_turn(user_id);
CREATE INDEX IF NOT EXISTS idx_copilot_turn_session_id ON copilot_turn(session_id);
CREATE INDEX IF NOT EXISTS idx_copilot_turn_created_at ON copilot_turn(created_at);
CREATE INDEX IF NOT EXISTS idx_copilot_turn_status ON copilot_turn(status);

CREATE TABLE IF NOT EXISTS copilot_workspace (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  active_variant_id TEXT,
  active_panel TEXT,
  product_generation_id TEXT,
  jd_id TEXT,
  resume_id TEXT,
  status TEXT NOT NULL,
  summary TEXT,
  workspace_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_copilot_workspace_user_id ON copilot_workspace(user_id);
CREATE INDEX IF NOT EXISTS idx_copilot_workspace_session_id ON copilot_workspace(session_id);
CREATE INDEX IF NOT EXISTS idx_copilot_workspace_active_panel ON copilot_workspace(active_panel);
CREATE INDEX IF NOT EXISTS idx_copilot_workspace_updated_at ON copilot_workspace(updated_at);

CREATE TABLE IF NOT EXISTS copilot_activity (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('chat', 'generation', 'decision', 'revision', 'import', 'save_experience', 'save_resume', 'open_workspace')),
  title TEXT NOT NULL,
  description TEXT,
  entity_type TEXT CHECK (entity_type IN ('experience', 'jd', 'resume', 'generation', 'session', 'variant')),
  entity_id TEXT,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_copilot_activity_user_id ON copilot_activity(user_id);
CREATE INDEX IF NOT EXISTS idx_copilot_activity_session_id ON copilot_activity(session_id);
CREATE INDEX IF NOT EXISTS idx_copilot_activity_type ON copilot_activity(type);
CREATE INDEX IF NOT EXISTS idx_copilot_activity_entity ON copilot_activity(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_copilot_activity_created_at ON copilot_activity(created_at);
