-- ═══════════════════════════════════════════════════════════════
-- 0011_product_constraints
-- Low-risk CHECK constraints and foreign keys for product tables.
-- All constraints use DO $$ blocks to safely skip if already present.
-- No data cleanup, no schema changes to existing columns.
-- ═══════════════════════════════════════════════════════════════

-- ── CHECK constraints ─────────────────────────────────────────────

DO $$ BEGIN
  ALTER TABLE product_experience ADD CONSTRAINT chk_product_experience_category
    CHECK (category IN ('work','internship','project','education','award','skill','other'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE product_experience ADD CONSTRAINT chk_product_experience_status
    CHECK (status IN ('active','archived','deleted'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE product_experience_revision ADD CONSTRAINT chk_product_experience_revision_source
    CHECK (source IN ('manual','import','copilot','resume_upload'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE product_experience_variant ADD CONSTRAINT chk_product_experience_variant_variant_type
    CHECK (variant_type IN ('full','medium','short','jd_tailored','custom'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE product_experience_variant ADD CONSTRAINT chk_product_experience_variant_language
    CHECK (language IN ('zh','en'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE product_experience_variant ADD CONSTRAINT chk_product_experience_variant_status
    CHECK (status IN ('active','archived'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE product_resume ADD CONSTRAINT chk_product_resume_status
    CHECK (status IN ('draft','ready','archived'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE product_resume_item ADD CONSTRAINT chk_product_resume_item_section_type
    CHECK (section_type IN ('experience','education','project','skill','award','summary','other'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE product_import_job ADD CONSTRAINT chk_product_import_job_source_type
    CHECK (source_type IN ('text','pdf'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE product_import_job ADD CONSTRAINT chk_product_import_job_status
    CHECK (status IN ('pending','extracting','candidates_ready','confirmed','failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE product_import_candidate ADD CONSTRAINT chk_product_import_candidate_category
    CHECK (category IN ('work','internship','project','education','award','skill','other'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE product_import_candidate ADD CONSTRAINT chk_product_import_candidate_status
    CHECK (status IN ('pending','accepted','rejected','merged'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE product_resume_template ADD CONSTRAINT chk_product_resume_template_status
    CHECK (status IN ('active','archived'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Foreign key constraints ───────────────────────────────────────

DO $$ BEGIN
  ALTER TABLE product_import_candidate ADD CONSTRAINT fk_product_import_candidate_job_id
    FOREIGN KEY (job_id) REFERENCES product_import_job(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE product_resume_item ADD CONSTRAINT fk_product_resume_item_resume_id
    FOREIGN KEY (resume_id) REFERENCES product_resume(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE product_experience_revision ADD CONSTRAINT fk_product_experience_revision_experience_id
    FOREIGN KEY (experience_id) REFERENCES product_experience(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE product_experience_variant ADD CONSTRAINT fk_product_experience_variant_experience_id
    FOREIGN KEY (experience_id) REFERENCES product_experience(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE product_experience_variant ADD CONSTRAINT fk_product_experience_variant_revision_id
    FOREIGN KEY (revision_id) REFERENCES product_experience_revision(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Index additions ───────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_product_import_candidate_user_status
  ON product_import_candidate(user_id, status);
