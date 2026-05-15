CREATE TABLE IF NOT EXISTS experiences (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  organization TEXT NOT NULL,
  role TEXT NOT NULL,
  summary TEXT NOT NULL,
  time_range_json TEXT NOT NULL,
  star_json TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  skill_ids_json TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidences (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  experience_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  evidence_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jd_requirements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  jd_id TEXT NOT NULL,
  description TEXT NOT NULL,
  required_skill_ids_json TEXT NOT NULL,
  weight REAL NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS generated_artifacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  source_experience_ids_json TEXT NOT NULL,
  source_evidence_ids_json TEXT NOT NULL,
  matched_skill_ids_json TEXT NOT NULL,
  target_jd_id TEXT NOT NULL,
  target_requirement_ids_json TEXT NOT NULL,
  target_role TEXT NOT NULL,
  scores_json TEXT NOT NULL,
  status TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_experiences_user_id ON experiences(user_id);
CREATE INDEX IF NOT EXISTS idx_evidences_user_id ON evidences(user_id);
CREATE INDEX IF NOT EXISTS idx_evidences_experience_id ON evidences(experience_id);
CREATE INDEX IF NOT EXISTS idx_skills_user_id ON skills(user_id);
CREATE INDEX IF NOT EXISTS idx_requirements_user_jd ON jd_requirements(user_id, jd_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_user_id ON generated_artifacts(user_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_target_jd_id ON generated_artifacts(target_jd_id);
