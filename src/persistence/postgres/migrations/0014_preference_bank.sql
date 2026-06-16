-- PreferenceBank v1: persistent user-facing preference evolution.

CREATE TABLE IF NOT EXISTS product_preference_event (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  session_id TEXT,
  turn_id TEXT,
  source TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_preference_event_user_dedupe
  ON product_preference_event(user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_product_preference_event_user_created
  ON product_preference_event(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_product_preference_event_type
  ON product_preference_event(event_type);

CREATE TABLE IF NOT EXISTS product_user_preference (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  dimension TEXT NOT NULL,
  value TEXT NOT NULL,
  instruction TEXT NOT NULL,
  scope_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  experience_id TEXT,
  strength REAL NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0,
  support_count INTEGER NOT NULL DEFAULT 0,
  contradiction_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'candidate',
  source_types_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_event_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  first_observed_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL,
  last_used_at TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, identity_key)
);

CREATE INDEX IF NOT EXISTS idx_product_user_preference_user_status
  ON product_user_preference(user_id, status);

CREATE INDEX IF NOT EXISTS idx_product_user_preference_dimension
  ON product_user_preference(user_id, dimension);

CREATE INDEX IF NOT EXISTS idx_product_user_preference_experience
  ON product_user_preference(user_id, experience_id);

CREATE INDEX IF NOT EXISTS idx_product_user_preference_scope_gin
  ON product_user_preference USING GIN (scope_json);
