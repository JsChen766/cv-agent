-- Final retrieval and analytics indexes for Guideline RAG v2 and Evidence RAG v5.

CREATE INDEX IF NOT EXISTS idx_product_experience_claim_user_status_type
  ON product_experience_claim(user_id, status, claim_type);

CREATE INDEX IF NOT EXISTS idx_product_experience_claim_skills_gin
  ON product_experience_claim USING GIN (skills_json);

CREATE INDEX IF NOT EXISTS idx_product_experience_claim_metadata_gin
  ON product_experience_claim USING GIN (metadata_json);

CREATE INDEX IF NOT EXISTS idx_product_evidence_usage_user_action
  ON product_evidence_usage(user_id, action);

CREATE INDEX IF NOT EXISTS idx_product_evidence_usage_user_generation_variant
  ON product_evidence_usage(user_id, generation_id, variant_id);

CREATE INDEX IF NOT EXISTS idx_product_evidence_outcome_claims_gin
  ON product_evidence_outcome_feedback USING GIN (related_claim_ids_json);

CREATE INDEX IF NOT EXISTS idx_product_evidence_outcome_experiences_gin
  ON product_evidence_outcome_feedback USING GIN (related_experience_ids_json);

CREATE INDEX IF NOT EXISTS idx_product_guideline_chunk_tags_gin
  ON product_guideline_chunk USING GIN (tags_json);

CREATE INDEX IF NOT EXISTS idx_product_guideline_chunk_metadata_gin
  ON product_guideline_chunk USING GIN (metadata_json);

CREATE INDEX IF NOT EXISTS idx_product_guideline_chunk_lookup
  ON product_guideline_chunk(language, role_family, application_type, source_type);
