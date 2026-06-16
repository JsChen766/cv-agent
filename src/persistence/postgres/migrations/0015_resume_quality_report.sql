-- Phase 8 Resume Quality Report: persist deterministic per-export quality
-- assessment (authenticity / jd_match / evidence / metric / expression /
-- layout). JSONB so heuristics can evolve without further migrations.
-- Optional column: pre-Phase-8 exports leave this NULL, and any export
-- whose evaluation throws also leaves it NULL (warn-only contract).
ALTER TABLE resume_export ADD COLUMN IF NOT EXISTS quality_report JSONB;
