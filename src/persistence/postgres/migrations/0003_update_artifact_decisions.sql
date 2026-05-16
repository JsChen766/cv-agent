-- 0003_update_artifact_decisions
-- Expands artifact_decisions from the legacy three-state session decision
-- shape to the P8.7.2 artifact decision record shape.
-- No foreign keys are introduced.

ALTER TABLE artifact_decisions ADD COLUMN IF NOT EXISTS decision TEXT DEFAULT 'request_revision';
ALTER TABLE artifact_decisions ADD COLUMN IF NOT EXISTS selected_variant_id TEXT;
ALTER TABLE artifact_decisions ADD COLUMN IF NOT EXISTS confirmation_json JSONB;
ALTER TABLE artifact_decisions ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE artifact_decisions DROP COLUMN IF EXISTS status;
ALTER TABLE artifact_decisions DROP COLUMN IF EXISTS metadata;
ALTER TABLE artifact_decisions DROP COLUMN IF EXISTS updated_at;
ALTER TABLE artifact_decisions ALTER COLUMN decision SET NOT NULL;
ALTER TABLE artifact_decisions ALTER COLUMN decision DROP DEFAULT;

CREATE INDEX IF NOT EXISTS idx_artifact_decisions_user_artifact ON artifact_decisions(user_id, artifact_id);
CREATE INDEX IF NOT EXISTS idx_artifact_decisions_user_session ON artifact_decisions(user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_artifact_decisions_created_at ON artifact_decisions(created_at);
