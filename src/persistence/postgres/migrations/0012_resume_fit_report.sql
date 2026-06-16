-- ══════════════════════════════════════════════════════════════
-- 0012_resume_fit_report
-- Phase 5 Fit Engine v1: persist a measured `fitReport` per export so
-- we can answer "did this resume fit on one page?" without re-rendering.
-- The column is jsonb and nullable — legacy exports keep working.
-- ══════════════════════════════════════════════════════════════

ALTER TABLE resume_export ADD COLUMN IF NOT EXISTS fit_report JSONB;
