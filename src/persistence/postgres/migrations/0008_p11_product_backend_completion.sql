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

ALTER TABLE background_job ADD COLUMN IF NOT EXISTS progress INTEGER NOT NULL DEFAULT 0;
ALTER TABLE background_job ADD COLUMN IF NOT EXISTS progress_message TEXT;
ALTER TABLE background_job ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE background_job ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE background_job ADD COLUMN IF NOT EXISTS locked_by TEXT;
ALTER TABLE background_job ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE background_job ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 3;
ALTER TABLE background_job ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
ALTER TABLE background_job ADD COLUMN IF NOT EXISTS result_ref TEXT;
ALTER TABLE background_job DROP CONSTRAINT IF EXISTS background_job_type_check;
ALTER TABLE background_job ADD CONSTRAINT background_job_type_check CHECK (type IN ('import_pdf', 'export_pdf', 'rebuild_index', 'long_generation', 'parse_document', 'import_resume_file', 'export_resume_html', 'export_resume_pdf'));
CREATE INDEX IF NOT EXISTS idx_background_job_claim ON background_job(status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_background_job_locked_until ON background_job(locked_until);

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
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_resume_export_user_id ON resume_export(user_id);
CREATE INDEX IF NOT EXISTS idx_resume_export_resume_id ON resume_export(resume_id);
CREATE INDEX IF NOT EXISTS idx_resume_export_status ON resume_export(status);
