-- Evidence RAG persistent claim graph, long-term evidence memory, and Guideline RAG chunks.

CREATE TABLE IF NOT EXISTS product_experience_claim (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  experience_id TEXT NOT NULL,
  revision_id TEXT,
  claim TEXT NOT NULL,
  claim_type TEXT NOT NULL,
  evidence_text TEXT NOT NULL,
  skills_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence REAL NOT NULL DEFAULT 0.5,
  risk_level TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'active',
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_product_experience_claim_user
  ON product_experience_claim(user_id);

CREATE INDEX IF NOT EXISTS idx_product_experience_claim_experience
  ON product_experience_claim(experience_id);

CREATE INDEX IF NOT EXISTS idx_product_experience_claim_revision
  ON product_experience_claim(revision_id);

CREATE INDEX IF NOT EXISTS idx_product_experience_claim_status
  ON product_experience_claim(status);

CREATE TABLE IF NOT EXISTS product_evidence_graph_edge (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_product_evidence_edge_user
  ON product_evidence_graph_edge(user_id);

CREATE INDEX IF NOT EXISTS idx_product_evidence_edge_source
  ON product_evidence_graph_edge(source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_product_evidence_edge_target
  ON product_evidence_graph_edge(target_type, target_id);

CREATE TABLE IF NOT EXISTS product_evidence_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  generation_id TEXT,
  variant_id TEXT,
  resume_id TEXT,
  jd_id TEXT,
  target_role TEXT,
  role_family TEXT,
  requirement_id TEXT NOT NULL,
  claim_id TEXT,
  experience_id TEXT,
  evidence_text TEXT,
  generated_text TEXT,
  final_text TEXT,
  action TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_product_evidence_usage_user
  ON product_evidence_usage(user_id);

CREATE INDEX IF NOT EXISTS idx_product_evidence_usage_generation
  ON product_evidence_usage(generation_id);

CREATE INDEX IF NOT EXISTS idx_product_evidence_usage_variant
  ON product_evidence_usage(variant_id);

CREATE INDEX IF NOT EXISTS idx_product_evidence_usage_claim
  ON product_evidence_usage(claim_id);

CREATE INDEX IF NOT EXISTS idx_product_evidence_usage_role
  ON product_evidence_usage(role_family);

CREATE TABLE IF NOT EXISTS product_evidence_outcome_feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  generation_id TEXT,
  resume_id TEXT,
  jd_id TEXT,
  target_role TEXT,
  role_family TEXT,
  outcome TEXT NOT NULL,
  notes TEXT,
  related_claim_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  related_experience_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_product_evidence_outcome_user
  ON product_evidence_outcome_feedback(user_id);

CREATE INDEX IF NOT EXISTS idx_product_evidence_outcome_role
  ON product_evidence_outcome_feedback(role_family);

CREATE TABLE IF NOT EXISTS product_guideline_chunk (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  role_family TEXT,
  industry TEXT,
  application_type TEXT,
  language TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_product_guideline_chunk_role
  ON product_guideline_chunk(role_family);

CREATE INDEX IF NOT EXISTS idx_product_guideline_chunk_language
  ON product_guideline_chunk(language);

CREATE INDEX IF NOT EXISTS idx_product_guideline_chunk_source_type
  ON product_guideline_chunk(source_type);
