ALTER TABLE product_experience
  ADD COLUMN IF NOT EXISTS source_document_id TEXT;

ALTER TABLE product_import_candidate
  ADD COLUMN IF NOT EXISTS start_date TEXT,
  ADD COLUMN IF NOT EXISTS end_date TEXT,
  ADD COLUMN IF NOT EXISTS source_document_id TEXT;

CREATE INDEX IF NOT EXISTS idx_product_experience_source_document_id
  ON product_experience(source_document_id);
