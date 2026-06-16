-- Phase 7 Fit Engine v3: persist the LLM Resume Fit Editor's
-- per-export decision/result record. JSONB so we can evolve the action
-- union without further migrations. Optional column: pre-Phase-7 exports
-- and any export that didn't trigger the editor leave this NULL.
ALTER TABLE resume_export ADD COLUMN IF NOT EXISTS edit_report JSONB;
