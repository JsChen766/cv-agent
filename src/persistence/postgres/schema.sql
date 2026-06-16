CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  display_name TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('pdf', 'docx', 'markdown', 'plain_text')),
  file_name TEXT NOT NULL,
  mime_type TEXT,
  source_ref TEXT NOT NULL,
  storage_uri TEXT,
  text TEXT,
  text_preview TEXT NOT NULL,
  text_length INTEGER NOT NULL,
  parser_status TEXT NOT NULL CHECK (parser_status IN ('parsed', 'failed', 'pending')),
  parser_name TEXT,
  parser_error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_user_id ON documents(user_id);
CREATE INDEX IF NOT EXISTS idx_documents_source_type ON documents(source_type);
CREATE INDEX IF NOT EXISTS idx_documents_parser_status ON documents(parser_status);
CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents(created_at);

CREATE TABLE IF NOT EXISTS experiences (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  organization TEXT NOT NULL,
  role TEXT NOT NULL,
  summary TEXT NOT NULL,
  time_range JSONB NOT NULL,
  star JSONB NOT NULL,
  evidence_ids JSONB NOT NULL,
  skill_ids JSONB NOT NULL,
  confidence REAL NOT NULL,
  source_document_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_experiences_user_id ON experiences(user_id);
CREATE INDEX IF NOT EXISTS idx_experiences_source_document_id ON experiences(source_document_id);
CREATE INDEX IF NOT EXISTS idx_experiences_created_at ON experiences(created_at);

CREATE TABLE IF NOT EXISTS evidences (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  experience_id TEXT NOT NULL,
  source_document_id TEXT,
  source_type TEXT NOT NULL,
  evidence_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  confidence REAL NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidences_user_id ON evidences(user_id);
CREATE INDEX IF NOT EXISTS idx_evidences_experience_id ON evidences(experience_id);
CREATE INDEX IF NOT EXISTS idx_evidences_source_document_id ON evidences(source_document_id);
CREATE INDEX IF NOT EXISTS idx_evidences_evidence_type ON evidences(evidence_type);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  evidence_ids JSONB NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skills_user_id ON skills(user_id);
CREATE INDEX IF NOT EXISTS idx_skills_lower_name ON skills(user_id, lower(name));

CREATE TABLE IF NOT EXISTS jd_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT,
  target_role TEXT NOT NULL,
  jd_text TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jd_profiles_user_id ON jd_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_jd_profiles_target_role ON jd_profiles(target_role);
CREATE INDEX IF NOT EXISTS idx_jd_profiles_created_at ON jd_profiles(created_at);

CREATE TABLE IF NOT EXISTS jd_requirements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  jd_id TEXT NOT NULL,
  description TEXT NOT NULL,
  required_skill_ids JSONB NOT NULL,
  weight REAL NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jd_requirements_user_id ON jd_requirements(user_id);
CREATE INDEX IF NOT EXISTS idx_jd_requirements_jd_id ON jd_requirements(jd_id);

CREATE TABLE IF NOT EXISTS generated_artifacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  source_experience_ids JSONB NOT NULL,
  source_evidence_ids JSONB NOT NULL,
  matched_skill_ids JSONB NOT NULL,
  target_jd_id TEXT NOT NULL,
  target_requirement_ids JSONB NOT NULL,
  target_role TEXT NOT NULL,
  scores JSONB NOT NULL,
  status TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_generated_artifacts_user_id ON generated_artifacts(user_id);
CREATE INDEX IF NOT EXISTS idx_generated_artifacts_target_jd_id ON generated_artifacts(target_jd_id);
CREATE INDEX IF NOT EXISTS idx_generated_artifacts_status ON generated_artifacts(status);
CREATE INDEX IF NOT EXISTS idx_generated_artifacts_created_at ON generated_artifacts(created_at);

CREATE TABLE IF NOT EXISTS generation_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  jd_id TEXT,
  target_role TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'archived')),
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  generation JSONB NOT NULL,
  result_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_generation_sessions_user_id ON generation_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_generation_sessions_jd_id ON generation_sessions(jd_id);
CREATE INDEX IF NOT EXISTS idx_generation_sessions_status ON generation_sessions(status);
CREATE INDEX IF NOT EXISTS idx_generation_sessions_created_at ON generation_sessions(created_at);
CREATE TABLE IF NOT EXISTS generation_artifact_bundles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  evidence_chain_snapshot_id TEXT,
  graph_view_snapshot_id TEXT,
  decision_status TEXT NOT NULL DEFAULT 'undecided',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_generation_artifact_bundles_user_id ON generation_artifact_bundles(user_id);
CREATE INDEX IF NOT EXISTS idx_generation_artifact_bundles_session_id ON generation_artifact_bundles(session_id);
CREATE INDEX IF NOT EXISTS idx_generation_artifact_bundles_artifact_id ON generation_artifact_bundles(artifact_id);
CREATE INDEX IF NOT EXISTS idx_generation_artifact_bundles_decision_status ON generation_artifact_bundles(decision_status);

CREATE TABLE IF NOT EXISTS evidence_chain_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT,
  artifact_id TEXT,
  chain JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_chain_snapshots_user_id ON evidence_chain_snapshots(user_id);
CREATE INDEX IF NOT EXISTS idx_evidence_chain_snapshots_session_id ON evidence_chain_snapshots(session_id);
CREATE INDEX IF NOT EXISTS idx_evidence_chain_snapshots_artifact_id ON evidence_chain_snapshots(artifact_id);
CREATE INDEX IF NOT EXISTS idx_evidence_chain_snapshots_created_at ON evidence_chain_snapshots(created_at);

CREATE TABLE IF NOT EXISTS graph_view_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('user', 'experience', 'generation', 'artifact')),
  scope_id TEXT NOT NULL,
  graph JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_graph_view_snapshots_user_id ON graph_view_snapshots(user_id);
CREATE INDEX IF NOT EXISTS idx_graph_view_snapshots_scope ON graph_view_snapshots(scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_graph_view_snapshots_created_at ON graph_view_snapshots(created_at);

CREATE TABLE IF NOT EXISTS artifact_decisions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  session_id TEXT,
  decision TEXT NOT NULL,
  reason TEXT,
  selected_variant_id TEXT,
  confirmation_json JSONB,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifact_decisions_user_artifact ON artifact_decisions(user_id, artifact_id);
CREATE INDEX IF NOT EXISTS idx_artifact_decisions_user_session ON artifact_decisions(user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_artifact_decisions_created_at ON artifact_decisions(created_at);

CREATE TABLE IF NOT EXISTS coverage_gap_decisions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  gap_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('generate_supplemental_artifact', 'request_more_evidence', 'ignore', 'mark_not_relevant')),
  reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_coverage_gap_decisions_user_id ON coverage_gap_decisions(user_id);
CREATE INDEX IF NOT EXISTS idx_coverage_gap_decisions_session_id ON coverage_gap_decisions(session_id);
CREATE INDEX IF NOT EXISTS idx_coverage_gap_decisions_gap_id ON coverage_gap_decisions(gap_id);
CREATE INDEX IF NOT EXISTS idx_coverage_gap_decisions_status ON coverage_gap_decisions(status);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT,
  agent_name TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  status TEXT NOT NULL,
  input JSONB NOT NULL,
  output JSONB,
  error TEXT,
  usage JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_user_id ON agent_runs(user_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_session_id ON agent_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_name ON agent_runs(agent_name);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);
CREATE INDEX IF NOT EXISTS idx_agent_runs_created_at ON agent_runs(created_at);

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
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_idempotency_user_key_unique ON api_idempotency_key(user_id, key);
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

CREATE TABLE IF NOT EXISTS app_user (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'deleted')),
  auth_provider TEXT NOT NULL CHECK (auth_provider IN ('password', 'github', 'google', 'dev', 'static')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  last_login_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_app_user_status ON app_user(status);

CREATE TABLE IF NOT EXISTS auth_identity (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('password', 'github', 'google', 'dev', 'static')),
  provider_user_id TEXT NOT NULL,
  email TEXT,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_identity_provider_user ON auth_identity(provider, provider_user_id);
CREATE INDEX IF NOT EXISTS idx_auth_identity_user_id ON auth_identity(user_id);

CREATE TABLE IF NOT EXISTS auth_session (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_token_hash TEXT UNIQUE NOT NULL,
  refresh_token_hash TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  user_agent TEXT,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_auth_session_user_id ON auth_session(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_session_status ON auth_session(status);
CREATE INDEX IF NOT EXISTS idx_auth_session_expires_at ON auth_session(expires_at);

CREATE TABLE IF NOT EXISTS user_api_key (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('deepseek', 'openai', 'compatible')),
  label TEXT NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  base_url TEXT,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_user_api_key_user_id ON user_api_key(user_id);
CREATE INDEX IF NOT EXISTS idx_user_api_key_status ON user_api_key(status);

CREATE TABLE IF NOT EXISTS uploaded_file (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_provider TEXT NOT NULL CHECK (storage_provider IN ('local', 'memory', 'r2', 's3')),
  storage_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('uploaded', 'parsed', 'failed', 'deleted')),
  parser_status TEXT,
  parser_error TEXT,
  text_document_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_uploaded_file_user_id ON uploaded_file(user_id);
CREATE INDEX IF NOT EXISTS idx_uploaded_file_status ON uploaded_file(status);
CREATE INDEX IF NOT EXISTS idx_uploaded_file_sha256 ON uploaded_file(sha256);

CREATE TABLE IF NOT EXISTS parsed_document (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  file_id TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('pdf', 'docx', 'text', 'paste')),
  text TEXT NOT NULL,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_parsed_document_user_id ON parsed_document(user_id);
CREATE INDEX IF NOT EXISTS idx_parsed_document_file_id ON parsed_document(file_id);

CREATE TABLE IF NOT EXISTS resume_export (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  resume_id TEXT NOT NULL,
  job_id TEXT,
  format TEXT NOT NULL CHECK (format IN ('pdf', 'html', 'docx')),
  template_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'rendering', 'completed', 'failed', 'expired', 'deleted')),
  file_id TEXT,
  download_token_hash TEXT,
  download_expires_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  fit_report JSONB,
  compression_report JSONB,
  edit_report JSONB
);
CREATE INDEX IF NOT EXISTS idx_resume_export_user_id ON resume_export(user_id);
CREATE INDEX IF NOT EXISTS idx_resume_export_resume_id ON resume_export(resume_id);
CREATE INDEX IF NOT EXISTS idx_resume_export_status ON resume_export(status);
