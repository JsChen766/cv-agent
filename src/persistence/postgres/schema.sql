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
