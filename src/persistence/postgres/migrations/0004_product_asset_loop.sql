CREATE TABLE IF NOT EXISTS product_experience (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  organization TEXT,
  role TEXT,
  start_date TEXT,
  end_date TEXT,
  source_document_id TEXT,
  tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL,
  current_revision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_product_experience_user_id ON product_experience(user_id);
CREATE INDEX IF NOT EXISTS idx_product_experience_user_status ON product_experience(user_id, status);
CREATE INDEX IF NOT EXISTS idx_product_experience_created_at ON product_experience(created_at);
CREATE INDEX IF NOT EXISTS idx_product_experience_source_document_id ON product_experience(source_document_id);

CREATE TABLE IF NOT EXISTS product_experience_revision (
  id TEXT PRIMARY KEY,
  experience_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  structured_json JSONB,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_product_experience_revision_user_id ON product_experience_revision(user_id);
CREATE INDEX IF NOT EXISTS idx_product_experience_revision_experience_id ON product_experience_revision(experience_id);
CREATE INDEX IF NOT EXISTS idx_product_experience_revision_created_at ON product_experience_revision(created_at);

CREATE TABLE IF NOT EXISTS product_experience_variant (
  id TEXT PRIMARY KEY,
  experience_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  variant_type TEXT NOT NULL,
  language TEXT NOT NULL,
  target_jd_id TEXT,
  content TEXT NOT NULL,
  evidence_ids_json JSONB,
  score_json JSONB,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_product_experience_variant_user_id ON product_experience_variant(user_id);
CREATE INDEX IF NOT EXISTS idx_product_experience_variant_experience_id ON product_experience_variant(experience_id);
CREATE INDEX IF NOT EXISTS idx_product_experience_variant_revision_id ON product_experience_variant(revision_id);
CREATE INDEX IF NOT EXISTS idx_product_experience_variant_target_jd_id ON product_experience_variant(target_jd_id);
CREATE INDEX IF NOT EXISTS idx_product_experience_variant_created_at ON product_experience_variant(created_at);

CREATE TABLE IF NOT EXISTS product_jd (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  company TEXT,
  target_role TEXT,
  raw_text TEXT NOT NULL,
  requirements_json JSONB,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_product_jd_user_id ON product_jd(user_id);
CREATE INDEX IF NOT EXISTS idx_product_jd_target_role ON product_jd(target_role);
CREATE INDEX IF NOT EXISTS idx_product_jd_created_at ON product_jd(created_at);

CREATE TABLE IF NOT EXISTS product_resume (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  target_role TEXT,
  jd_id TEXT,
  template_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_product_resume_user_id ON product_resume(user_id);
CREATE INDEX IF NOT EXISTS idx_product_resume_jd_id ON product_resume(jd_id);
CREATE INDEX IF NOT EXISTS idx_product_resume_status ON product_resume(status);
CREATE INDEX IF NOT EXISTS idx_product_resume_created_at ON product_resume(created_at);

CREATE TABLE IF NOT EXISTS product_resume_item (
  id TEXT PRIMARY KEY,
  resume_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_experience_id TEXT,
  source_variant_id TEXT,
  source_artifact_id TEXT,
  section_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content_snapshot TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  hidden BOOLEAN NOT NULL DEFAULT false,
  pinned BOOLEAN NOT NULL DEFAULT false,
  metadata_json JSONB,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_product_resume_item_user_id ON product_resume_item(user_id);
CREATE INDEX IF NOT EXISTS idx_product_resume_item_resume_id ON product_resume_item(resume_id);
CREATE INDEX IF NOT EXISTS idx_product_resume_item_source_experience_id ON product_resume_item(source_experience_id);
CREATE INDEX IF NOT EXISTS idx_product_resume_item_order_index ON product_resume_item(order_index);

CREATE TABLE IF NOT EXISTS product_generation (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  session_id TEXT,
  jd_id TEXT,
  resume_id TEXT,
  target_role TEXT,
  input_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_snapshot_json JSONB,
  selected_variant_ids_json JSONB,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_product_generation_user_id ON product_generation(user_id);
CREATE INDEX IF NOT EXISTS idx_product_generation_session_id ON product_generation(session_id);
CREATE INDEX IF NOT EXISTS idx_product_generation_jd_id ON product_generation(jd_id);
CREATE INDEX IF NOT EXISTS idx_product_generation_resume_id ON product_generation(resume_id);
CREATE INDEX IF NOT EXISTS idx_product_generation_created_at ON product_generation(created_at);

CREATE TABLE IF NOT EXISTS product_import_job (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  status TEXT NOT NULL,
  raw_text TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_product_import_job_user_id ON product_import_job(user_id);
CREATE INDEX IF NOT EXISTS idx_product_import_job_status ON product_import_job(status);
CREATE INDEX IF NOT EXISTS idx_product_import_job_created_at ON product_import_job(created_at);

CREATE TABLE IF NOT EXISTS product_import_candidate (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  organization TEXT,
  role TEXT,
  start_date TEXT,
  end_date TEXT,
  source_document_id TEXT,
  content TEXT NOT NULL,
  structured_json JSONB,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_product_import_candidate_user_id ON product_import_candidate(user_id);
CREATE INDEX IF NOT EXISTS idx_product_import_candidate_job_id ON product_import_candidate(job_id);
CREATE INDEX IF NOT EXISTS idx_product_import_candidate_status ON product_import_candidate(status);
CREATE INDEX IF NOT EXISTS idx_product_import_candidate_created_at ON product_import_candidate(created_at);

CREATE TABLE IF NOT EXISTS product_resume_template (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_product_resume_template_status ON product_resume_template(status);
INSERT INTO product_resume_template (id, name, description, config_json, status, created_at, updated_at)
VALUES ('template-default', 'Default', 'Default product resume template.', '{"sections":["summary","experience","project","education","skill"]}'::jsonb, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
ON CONFLICT (id) DO NOTHING;
